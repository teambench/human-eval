"""Agent runner — impersonates a Planner or Executor in a hybrid session.

Invoked as a subprocess by the backend:

    python agent_runner.py --session-id SID --role {planner|executor} \
        --task-id TID --workspace-path /tmp/tb_SID_.../workspace

It then:
  - reads task brief + current workspace files
  - calls the LLM via providers.model_pool
  - posts chat messages / file edits / phase transitions to Firebase

Runs until phase transitions to completed / cancelled, or a global session
budget is exhausted (max turns or wall-clock). Designed to be SIGTERM'd
by the parent when the human leaves.

Security: the LLM API key is read once from env (loaded via python-dotenv
if /u/ybkim95/TeamBench/.env is present). The key never appears in any
Firebase payload, stdout log line, or exception re-raise.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import signal
import sys
import time
from pathlib import Path
from typing import Any

try:
    from dotenv import load_dotenv

    _env_candidates = [
        os.environ.get("TEAMBENCH_ENV_FILE"),
        "/u/ybkim95/TeamBench/.env",
        str(Path(__file__).parent / ".env"),
    ]
    for p in _env_candidates:
        if p and os.path.isfile(p):
            load_dotenv(p, override=False)
            break
except ImportError:
    pass

sys.path.insert(0, str(Path(__file__).parent))

import firebase_rest as fb  # noqa: E402
from providers import model_pool  # noqa: E402


logging.basicConfig(
    level=os.environ.get("HYBRID_LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("hybrid.agent")

# ── Config ───────────────────────────────────────────────────────────────

POLL_INTERVAL = float(os.environ.get("HYBRID_POLL_INTERVAL", "2.0"))
MAX_TURNS_PER_PHASE = int(os.environ.get("HYBRID_MAX_TURNS_PHASE", "5"))
MAX_TURNS_TOTAL = int(os.environ.get("HYBRID_MAX_TURNS_TOTAL", "20"))
WALL_CLOCK_LIMIT = int(os.environ.get("HYBRID_WALL_CLOCK_S", "1800"))  # 30 min
DEAD_MAN_LIMIT = int(os.environ.get("HYBRID_DEAD_MAN_S", "300"))  # 5 min no human

FILE_PATTERN = re.compile(
    r"^###\s*FILE:\s*(.+?)\s*$", re.MULTILINE
)

TERMINAL_PHASES = {"completed", "cancelled"}

# ── Prompts ──────────────────────────────────────────────────────────────

PLANNER_SYSTEM = """You are the PLANNER in a collaborative coding task.
A human VERIFIER is reviewing your teammate's work. An automated EXECUTOR
will implement your plan. You do NOT write code.

Read the task specification. In ONE message of ~150 words:
  1. Summarize the core problem in 1-2 sentences.
  2. List the concrete steps the Executor must take (files to modify,
     functions to add, tests to pass).
  3. Flag any edge cases that might trip up a naive fix.

Be terse, numbered, and concrete. The Executor reads only your message
— not the full spec. Do not reveal your model identity."""

EXECUTOR_SYSTEM = """You are the EXECUTOR in a collaborative coding task.
You receive a plan from the Planner and must modify the given workspace
files to satisfy the task brief. A human VERIFIER will grade your work.

Output format (STRICT — the runner parses this):

  Brief explanation of changes (max 3 sentences).

  ### FILE: path/relative/to/workspace.py
  ```
  <complete new file contents>
  ```

  ### FILE: another/file.py
  ```
  <complete new file contents>
  ```

Rules:
  - Emit the FULL new content of each file you edit (not a patch).
  - Only include files you actually change. Don't echo unchanged files.
  - Do not include any other markdown headers or fences.
  - Do not reveal your model identity."""


# ── Firebase helpers ─────────────────────────────────────────────────────


def chat(session_id: str, role: str, content: str) -> None:
    fb.post_message(session_id, from_role=role, to="all", content=content)


def get_phase(session_id: str) -> str:
    s = fb.get_session(session_id) or {}
    return s.get("phase", "lobby")


def get_messages_since(session_id: str, ts_ms: int) -> list[dict[str, Any]]:
    raw = fb.get(fb.session_path(session_id, "messages")) or {}
    msgs = list(raw.values()) if isinstance(raw, dict) else []
    msgs.sort(key=lambda m: m.get("timestamp", 0))
    return [m for m in msgs if m.get("timestamp", 0) > ts_ms]


def log_model_use(session_id: str, role: str, gateway: str, usage: dict[str, int]) -> None:
    """Record which gateway served each turn — critical for replicability."""
    turn_key = fb._genid()
    fb.set(
        fb.session_path(session_id, "agentModelUsage", f"{role}_{turn_key}"),
        {
            "role": role,
            "gateway": gateway,
            "usage": usage,
            "timestamp": int(time.time() * 1000),
        },
    )


# ── Task loading ─────────────────────────────────────────────────────────


def load_workspace(ws_path: str) -> dict[str, str]:
    """Return {rel_path: content} for all non-binary files in workspace."""
    files: dict[str, str] = {}
    root = Path(ws_path)
    if not root.is_dir():
        return files
    SKIP = {"__pycache__", ".pytest_cache", ".git", "node_modules", ".venv"}
    for p in root.rglob("*"):
        if p.is_dir() or p.name.startswith(".DS"):
            continue
        if any(part in SKIP for part in p.parts):
            continue
        rel = str(p.relative_to(root))
        try:
            if p.stat().st_size > 100_000:
                continue
            files[rel] = p.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
    return files


def read_brief_and_spec(files: dict[str, str]) -> tuple[str, str]:
    brief = files.get("brief.md", "")
    spec = files.get("spec.md", files.get("README.md", ""))
    return brief, spec


def format_workspace_for_prompt(files: dict[str, str], skip: set[str] | None = None) -> str:
    skip = skip or {"brief.md", "spec.md", "README.md", "README_HUMAN.md", "analysis_guidance.md"}
    lines: list[str] = []
    for path, content in sorted(files.items()):
        if path in skip or path.startswith("tests/"):
            continue
        lines.append(f"### FILE: {path}")
        lines.append("```")
        lines.append(content)
        lines.append("```")
        lines.append("")
    return "\n".join(lines)


# ── Executor output parsing ──────────────────────────────────────────────


def parse_executor_output(text: str) -> tuple[str, list[tuple[str, str]]]:
    """Split LLM output into (explanation, [(path, content), ...])."""
    # Find all FILE headers and their positions.
    matches = list(FILE_PATTERN.finditer(text))
    if not matches:
        return text.strip(), []

    explanation = text[: matches[0].start()].strip()
    edits: list[tuple[str, str]] = []
    for i, m in enumerate(matches):
        path = m.group(1).strip()
        body_start = m.end()
        body_end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        body = text[body_start:body_end]
        # Strip triple-backtick fences if present.
        body = body.strip()
        if body.startswith("```"):
            body = re.sub(r"^```[\w+-]*\s*\n", "", body, count=1)
            if body.endswith("```"):
                body = body[: -3].rstrip()
        edits.append((path, body))
    return explanation, edits


def write_file(ws_path: str, rel: str, content: str) -> bool:
    """Write file inside workspace — reject escaping paths."""
    ws = Path(ws_path).resolve()
    full = (ws / rel).resolve()
    try:
        full.relative_to(ws)
    except ValueError:
        log.warning("rejected path escape attempt: %s", rel)
        return False
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    return True


# ── Planner loop ─────────────────────────────────────────────────────────


def run_planner(session_id: str, task_id: str, ws_path: str) -> None:
    log.info("planner start session=%s task=%s", session_id, task_id)
    files = load_workspace(ws_path)
    brief, spec = read_brief_and_spec(files)
    source = spec or brief or f"Task: {task_id}"

    # Wait for phase=planning (the frontend advances lobby → planning when
    # it calls /start-hybrid; in case of race, sleep briefly).
    start_ts = time.time()
    while time.time() - start_ts < 30:
        phase = get_phase(session_id)
        if phase == "planning":
            break
        if phase in TERMINAL_PHASES:
            log.info("planner: phase=%s at start, exiting", phase)
            return
        time.sleep(1.0)

    # Generate plan.
    messages = [
        {"role": "system", "content": PLANNER_SYSTEM},
        {"role": "user", "content": f"Task specification:\n\n{source[:8000]}"},
    ]
    try:
        resp = model_pool.call_llm(messages, max_tokens=600)
    except RuntimeError as e:
        log.error("planner LLM failure: %s", e)
        chat(session_id, "planner", "[Planner unavailable — LLM gateways exhausted. Please cancel and retry.]")
        return

    plan_text = resp.content.strip() or "(Planner produced no output.)"
    chat(session_id, "planner", plan_text)
    log_model_use(session_id, "planner", resp.gateway_id, resp.usage)
    log.info("planner posted plan via %s", resp.gateway_id)

    time.sleep(2.0)
    fb.set_phase(session_id, "execution")
    log.info("planner advanced phase → execution")


# ── Executor loop ────────────────────────────────────────────────────────


def run_executor(session_id: str, task_id: str, ws_path: str) -> None:
    log.info("executor start session=%s task=%s", session_id, task_id)
    total_turns = 0
    last_verifier_note: str | None = None
    start_ts = time.time()
    last_human_activity = time.time()

    # Wait for phase=execution (Planner advances first).
    while time.time() - start_ts < 120:
        phase = get_phase(session_id)
        if phase == "execution":
            break
        if phase in TERMINAL_PHASES:
            log.info("executor: phase=%s at start, exiting", phase)
            return
        time.sleep(POLL_INTERVAL)
    else:
        log.warning("executor: timed out waiting for planning phase")
        return

    # Main loop: act on each execution phase (initial + remediations).
    while total_turns < MAX_TURNS_TOTAL and time.time() - start_ts < WALL_CLOCK_LIMIT:
        phase = get_phase(session_id)
        if phase in TERMINAL_PHASES:
            log.info("executor: phase=%s, exiting", phase)
            return

        # Dead-man: if no human activity for too long, bail.
        if time.time() - last_human_activity > DEAD_MAN_LIMIT:
            log.warning("executor: dead-man timeout, exiting")
            return

        if phase != "execution":
            time.sleep(POLL_INTERVAL)
            continue

        # Execute one turn.
        total_turns += 1
        files = load_workspace(ws_path)
        brief, _spec = read_brief_and_spec(files)
        ws_dump = format_workspace_for_prompt(files)

        # Read the planner's most recent chat message.
        msgs = fb.get(fb.session_path(session_id, "messages")) or {}
        msgs_list = sorted(list(msgs.values()) if isinstance(msgs, dict) else [],
                           key=lambda m: m.get("timestamp", 0))
        planner_msg = next(
            (m["content"] for m in reversed(msgs_list) if m.get("from") == "planner"),
            "",
        )

        prompt_parts = [f"Task brief:\n{brief or '(no brief)'}"]
        if planner_msg:
            prompt_parts.append(f"Planner's plan:\n{planner_msg}")
        if last_verifier_note:
            prompt_parts.append(
                f"Verifier rejected your previous attempt:\n{last_verifier_note}"
            )
        prompt_parts.append(f"Current workspace:\n{ws_dump}")

        messages = [
            {"role": "system", "content": EXECUTOR_SYSTEM},
            {"role": "user", "content": "\n\n".join(prompt_parts)[:24000]},
        ]
        try:
            resp = model_pool.call_llm(messages, max_tokens=3000)
        except RuntimeError as e:
            log.error("executor LLM failure: %s", e)
            chat(session_id, "executor", "[Executor unavailable — LLM gateways exhausted.]")
            return

        log_model_use(session_id, "executor", resp.gateway_id, resp.usage)
        explanation, edits = parse_executor_output(resp.content)
        log.info("executor turn %d: %d edits via %s", total_turns, len(edits), resp.gateway_id)

        # Apply edits.
        applied: list[str] = []
        for rel, content in edits:
            if write_file(ws_path, rel, content):
                fb.write_file_echo(session_id, rel, content)
                applied.append(rel)

        summary = explanation
        if applied:
            summary += f"\n\nEdited: {', '.join(applied)}"
        chat(session_id, "executor", summary or "(No edits produced.)")

        # Advance to verification.
        time.sleep(1.0)
        fb.set_phase(session_id, "verification")
        log.info("executor advanced phase → verification")

        # Wait for verifier verdict.
        verdict_start = time.time()
        while time.time() - verdict_start < WALL_CLOCK_LIMIT:
            phase = get_phase(session_id)
            if phase in TERMINAL_PHASES:
                log.info("executor: phase=%s after verification, exiting", phase)
                return
            if phase == "execution":
                # Verifier sent it back — pick up the latest verifier note.
                msgs = fb.get(fb.session_path(session_id, "messages")) or {}
                msgs_list = sorted(list(msgs.values()) if isinstance(msgs, dict) else [],
                                   key=lambda m: m.get("timestamp", 0))
                for m in reversed(msgs_list):
                    if m.get("from") == "verifier":
                        last_verifier_note = m.get("content", "")
                        last_human_activity = time.time()
                        break
                break
            time.sleep(POLL_INTERVAL)

    log.info("executor: exhausted turns/time, exiting")


# ── Entry point ──────────────────────────────────────────────────────────


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--session-id", required=True)
    ap.add_argument("--role", required=True, choices=["planner", "executor"])
    ap.add_argument("--task-id", required=True)
    ap.add_argument("--workspace-path", required=True)
    args = ap.parse_args()

    # Graceful SIGTERM handling so the parent can clean up.
    def _shutdown(sig, frame):
        log.info("received signal %s, exiting", sig)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _shutdown)
    signal.signal(signal.SIGINT, _shutdown)

    # Mark participant so the human verifier sees them in the roster.
    fb.set_participant(
        args.session_id,
        args.role,
        {
            "name": f"AI {args.role.capitalize()}",
            "joinedAt": int(time.time() * 1000),
            "isAgent": True,
        },
    )

    try:
        if args.role == "planner":
            run_planner(args.session_id, args.task_id, args.workspace_path)
        else:
            run_executor(args.session_id, args.task_id, args.workspace_path)
    except Exception as e:
        log.exception("agent runner crash: %s", type(e).__name__)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
