"""
TeamBench Human Eval — Backend Server

Provides:
1. WebSocket terminal proxy to Docker containers
2. Session/container lifecycle management
3. Grading endpoint using existing grade.sh scripts

Run: uvicorn server:app --host 0.0.0.0 --port 8443
"""

import asyncio
import hashlib
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from collections import deque
from pathlib import Path
from typing import Optional

# Load API keys + Firebase URL from the canonical TeamBench .env BEFORE any
# module that reads them. Keys stay in process env only; never logged, never
# returned from any endpoint. The file path is configurable via TEAMBENCH_ENV_FILE.
try:
    from dotenv import load_dotenv

    for _envp in (
        os.environ.get("TEAMBENCH_ENV_FILE"),
        "/u/ybkim95/TeamBench/.env",
        str(Path(__file__).parent / ".env"),
    ):
        if _envp and os.path.isfile(_envp):
            load_dotenv(_envp, override=False)
            break
except ImportError:
    pass

import docker
from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect, HTTPException
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="TeamBench Human Eval Backend")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # GitHub Pages + local dev
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Config
TEAMBENCH_ROOT = os.environ.get("TEAMBENCH_ROOT", "/u/ybkim95/TeamBench")
DOCKER_IMAGE = os.environ.get("DOCKER_IMAGE", "teambench-executor:human")
MAX_CONTAINERS = int(os.environ.get("MAX_CONTAINERS", "20"))
CONTAINER_TIMEOUT = int(os.environ.get("CONTAINER_TIMEOUT", "3600"))  # 1 hour
DEFAULT_SEED = int(os.environ.get("HUMAN_EVAL_SEED", "0"))

# Make TeamBench generators importable from the backend process.
if TEAMBENCH_ROOT not in sys.path:
    sys.path.insert(0, TEAMBENCH_ROOT)

# Active sessions: sessionId -> container info
sessions: dict[str, dict] = {}
docker_client = docker.from_env()


_CONFTEST_SRC = (
    "import os, sys\n"
    "sys.path.insert(0, os.path.dirname(__file__))\n"
)


def _resolve_task_dir(task_id: str, seed: int) -> Optional[Path]:
    """
    Resolve the on-disk task definition dir. RDS-style tasks split work
    between two locations: tasks/{task_id}/ (thin shim holding only
    grade.sh) and tasks/{task_id}_seed{seed}/ (has spec/brief/workspace/).
    Prefer whichever candidate actually contains a workspace or spec, so
    we don't accidentally pick the shim.
    """
    root = Path(TEAMBENCH_ROOT) / "tasks"
    candidates = [root / task_id, root / f"{task_id}_seed{seed}"]
    # First pass: prefer a dir that actually has staging content.
    for c in candidates:
        if c.is_dir() and ((c / "workspace").is_dir() or (c / "spec.md").is_file()):
            return c
    # Fallback: any existing dir (e.g., grade.sh-only shim).
    for c in candidates:
        if c.is_dir():
            return c
    return None


def _apply_task_patches(task_id: str, ws_path: str) -> None:
    """
    Per-task in-place workspace fixes that address upstream-generator bugs
    we cannot repair without breaking the ablation harness that consumes
    the same generators.

    Each entry reads and rewrites files under ws_path. Failures are logged
    but not fatal — a task with a failed patch is no worse than unpatched.
    """
    try:
        if task_id == "RDS10_survey_analysis":
            # The generator only ships data/stackoverflow.csv + requirements.
            # The participant is expected to PRODUCE analysis.py, results.json,
            # and report.md — but Monaco cannot open a file that does not
            # exist, so there was no way to start typing without first
            # creating the file in the terminal. Stub the three expected
            # deliverables so the file tree surfaces them as editable.
            stubs = {
                "analysis.py": (
                    '"""Stack Overflow Developer Survey — remote work vs job satisfaction.\n\n'
                    'Write a regression analysis here. Read data/stackoverflow.csv, run a\n'
                    'model that regresses job satisfaction on a remote-work indicator while\n'
                    'controlling for ConvertedCompYearly and employment type, then write\n'
                    'your effect estimates (with uncertainty) to results.json and a short\n'
                    'findings-and-limitations write-up to report.md.\n"""\n\n'
                    '# import pandas as pd, statsmodels.formula.api as smf, json, pathlib\n'
                    '# df = pd.read_csv("data/stackoverflow.csv")\n'
                    '# ...\n'
                    '# pathlib.Path("results.json").write_text(json.dumps({...}))\n'
                    '# pathlib.Path("report.md").write_text("# Findings\\n\\n...")\n'
                ),
                "results.json": "{}\n",
                "report.md": "# RDS10 Findings\n\n(Fill in after running analysis.py.)\n",
            }
            for rel, content in stubs.items():
                p = os.path.join(ws_path, rel)
                if not os.path.isfile(p):
                    os.makedirs(os.path.dirname(p) or ws_path, exist_ok=True)
                    with open(p, "w", encoding="utf-8") as f:
                        f.write(content)
        if task_id == "RDS13_smote_leakage":
            # The generator's analysis.py reads ../datasets/credit_card_fraud.csv
            # which is never shipped to the workspace. The collaborator reported
            # the task as unsolvable. Inject a synthetic-data fallback so the
            # script runs; the SMOTE-before-split bug (the actual task) is
            # preserved so the participant still has something to fix.
            ap = os.path.join(ws_path, "analysis.py")
            if os.path.isfile(ap):
                src = open(ap).read()
                old_load = (
                    'data_path = pathlib.Path(__file__).parent.parent / "datasets" / "credit_card_fraud.csv"\n'
                    'df = pd.read_csv(data_path, comment="#")\n'
                )
                new_load = (
                    '# NOTE: The original credit_card_fraud.csv is not shipped with the\n'
                    '# human-eval workspace. Fallback: generate a synthetic imbalanced\n'
                    '# dataset with the same shape (binary Class column, 5% positives).\n'
                    'from sklearn.datasets import make_classification\n'
                    '_X, _y = make_classification(\n'
                    '    n_samples=2000, n_features=20, n_informative=10,\n'
                    '    n_redundant=5, weights=[0.95, 0.05], random_state=42,\n'
                    ')\n'
                    'df = pd.DataFrame(_X, columns=[f"V{i+1}" for i in range(_X.shape[1])])\n'
                    'df["Class"] = _y\n'
                )
                if old_load in src:
                    src = src.replace(old_load, new_load)
                    open(ap, "w").write(src)
    except Exception as e:
        print(f"[_apply_task_patches] {task_id}: {e}")


def _stage_task_workspace(task_id: str, workspace_dir: str, seed: int = DEFAULT_SEED) -> dict:
    """
    Stage a task's workspace, reports, and submission directories.

    Layout produced under `workspace_dir/`:
      workspace/   — mounted to /workspace (rw, visible to human)
      reports/     — mounted to /reports (rw, grader-only: expected.json + score.json)
      submission/  — mounted to /submission (rw, for attestation.json)

    Source priority (last writer wins):
      1. Static tasks/{task_id}/workspace/  copytree
      2. Generator's workspace_files         overlay
      3. Frontend-provided files             overlay (applied by caller)
    """
    ws_path = os.path.join(workspace_dir, "workspace")
    reports_path = os.path.join(workspace_dir, "reports")
    submission_path = os.path.join(workspace_dir, "submission")
    os.makedirs(ws_path, exist_ok=True)
    os.makedirs(reports_path, exist_ok=True)
    os.makedirs(submission_path, exist_ok=True)

    info = {
        "generator_found": False, "static_workspace_used": False,
        "files_written": 0, "task_dir_abs": "", "task_dir_resolved": "",
        "grade_sh": "", "setup_sh": "", "expected_written": False,
        "brief": "", "spec": "",
    }

    task_dir = _resolve_task_dir(task_id, seed)
    if task_dir:
        info["task_dir_abs"] = str(Path(TEAMBENCH_ROOT) / "tasks" / task_id)
        info["task_dir_resolved"] = str(task_dir)
        # 1) Static workspace (some tasks ship pre-generated files).
        static_ws = task_dir / "workspace"
        if static_ws.is_dir():
            shutil.copytree(static_ws, ws_path, dirs_exist_ok=True)
            info["static_workspace_used"] = True
        # Static reports (expected.json for RDS-style and some others).
        static_reports = task_dir / "reports"
        if static_reports.is_dir():
            shutil.copytree(static_reports, reports_path, dirs_exist_ok=True)
            if (Path(reports_path) / "expected.json").is_file():
                info["expected_written"] = True
        # Grader + setup paths. RDS-style tasks split the layout: staging
        # (workspace/spec) lives in tasks/{id}_seed{N}/ but grade.sh lives in
        # the tasks/{id}/ shim dir. Fall back to the shim when the resolved
        # dir lacks a grader.
        shim_dir = Path(TEAMBENCH_ROOT) / "tasks" / task_id
        if (task_dir / "grade.sh").is_file():
            info["grade_sh"] = str(task_dir / "grade.sh")
        elif shim_dir.is_dir() and (shim_dir / "grade.sh").is_file():
            info["grade_sh"] = str(shim_dir / "grade.sh")
        if (task_dir / "setup.sh").is_file():
            info["setup_sh"] = str(task_dir / "setup.sh")
        elif shim_dir.is_dir() and (shim_dir / "setup.sh").is_file():
            info["setup_sh"] = str(shim_dir / "setup.sh")
        # Task brief / spec for in-workspace display.
        for name in ("brief.md", "spec.md"):
            p = task_dir / name
            if p.is_file():
                info[name.split(".")[0]] = p.read_text()

    # 2) Generator overlay (may supersede static files with seed-parameterized content).
    try:
        from generators.registry import get_generator
        gen = get_generator(task_id)
        generated = gen.generate(seed)
        info["generator_found"] = True
        if not info["brief"]:
            info["brief"] = getattr(generated, "brief_md", "") or ""
        if not info["spec"]:
            info["spec"] = getattr(generated, "spec_md", "") or ""

        for rel_path, content in (generated.workspace_files or {}).items():
            safe_rel = os.path.normpath(rel_path).lstrip(os.sep)
            if safe_rel.startswith(".."):
                continue
            abs_path = os.path.join(ws_path, safe_rel)
            real = os.path.realpath(abs_path)
            if not real.startswith(os.path.realpath(ws_path)):
                continue
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            mode = "wb" if isinstance(content, (bytes, bytearray)) else "w"
            with open(abs_path, mode) as f:
                f.write(content)
            info["files_written"] += 1

        for rel_path, content in (generated.corpus_files or {}).items():
            safe_rel = os.path.normpath(rel_path).lstrip(os.sep)
            if safe_rel.startswith(".."):
                continue
            abs_path = os.path.join(ws_path, "corpus", safe_rel)
            real = os.path.realpath(abs_path)
            if not real.startswith(os.path.realpath(ws_path)):
                continue
            os.makedirs(os.path.dirname(abs_path), exist_ok=True)
            with open(abs_path, "w", encoding="utf-8") as f:
                f.write(content)
            info["files_written"] += 1

        # Write expected.json from the generator (ground truth).
        if getattr(generated, "expected", None) is not None:
            with open(os.path.join(reports_path, "expected.json"), "w") as f:
                json.dump(generated.expected, f, indent=2)
            info["expected_written"] = True
    except KeyError:
        pass  # No generator (e.g., GH103_redis-py_3998 — static only).
    except Exception as e:
        print(f"[stage] generator {task_id} failed: {e}")

    # Per-task post-stage patches: fix generator bugs, inject stub files that
    # the participant is expected to create. Run UNCONDITIONALLY, not under
    # the generator try-block — some tasks (RDS10, RDS13) have generators
    # that require external datasets we don't ship to the droplet, so the
    # generator fails but the static workspace is still viable and the patch
    # is still needed. Patch is a no-op when its preconditions are absent.
    _apply_task_patches(task_id, ws_path)

    # 3) Helper artefacts inside the workspace.
    if info["brief"]:
        with open(os.path.join(ws_path, "brief.md"), "w") as f:
            f.write(info["brief"])
    readme_human = (
        "# Human Evaluation Workspace\n\n"
        f"Task: **{task_id}** (seed {seed})\n\n"
        "Read `brief.md` for the task description.\n\n"
        "## Running tests\n"
        "`pytest -x` (PYTHONPATH already includes /workspace via conftest.py).\n\n"
        "## Grading\n"
        "Use the web UI's **Grade** button — it runs the task's grade.sh and returns the score.\n"
    )
    with open(os.path.join(ws_path, "README_HUMAN.md"), "w") as f:
        f.write(readme_human)

    # Pre-seed attestation so grade.sh doesn't trivially fail on the "verdict=pass"
    # check. Humans aren't required to attest; the grader's other checks remain the
    # real signal. The workspace is world-writable so the human can overwrite this.
    attest_path = os.path.join(submission_path, "attestation.json")
    with open(attest_path, "w") as f:
        json.dump({"verdict": "pass", "source": "human_eval_default"}, f)

    return info


def _ensure_conftest(ws_path: str) -> None:
    """Drop a root conftest.py so pytest discovers src/, app.py, etc."""
    conftest = os.path.join(ws_path, "conftest.py")
    if not os.path.exists(conftest):
        with open(conftest, "w") as f:
            f.write(_CONFTEST_SRC)


def _chmod_recursive(path: str) -> None:
    """Make workspace world-writable so container uid 10001 can edit."""
    os.chmod(path, 0o777)
    for root, dirs, fnames in os.walk(path):
        for d in dirs:
            try:
                os.chmod(os.path.join(root, d), 0o777)
            except OSError:
                pass
        for fname in fnames:
            try:
                os.chmod(os.path.join(root, fname), 0o666)
            except OSError:
                pass


def get_session(session_id: str) -> Optional[dict]:
    """Get session info, clean up expired sessions."""
    session = sessions.get(session_id)
    if session and time.time() - session["created_at"] > CONTAINER_TIMEOUT:
        cleanup_session(session_id)
        return None
    return session


def cleanup_session(session_id: str):
    """Stop and remove a session's container."""
    # Always stop any hybrid agents first so they don't burn tokens
    # writing to a session we're about to tear down.
    _stop_hybrid_agents(session_id)

    session = sessions.pop(session_id, None)
    if not session:
        return
    try:
        container = docker_client.containers.get(session["container_id"])
        container.stop(timeout=5)
        container.remove(force=True)
    except docker.errors.NotFound:
        pass
    except Exception as e:
        print(f"Cleanup error for {session_id}: {e}")
    # Clean up workspace
    workspace_dir = session.get("workspace_dir")
    if workspace_dir and os.path.exists(workspace_dir):
        shutil.rmtree(workspace_dir, ignore_errors=True)


# ── Hybrid mode: LLM-powered Planner + Executor, human Verifier ─────────
#
# Safety rails (all enforced before an LLM call is ever made):
#   * HYBRID_DISABLED=1 env var refuses new sessions entirely.
#   * Rate limit: MAX 1 hybrid session per (task_id, client_ip) per hour.
#   * Global cap: MAX HYBRID_MAX_SESSIONS concurrent hybrid sessions.
#   * Dead-man: agent_runner exits after HYBRID_DEAD_MAN_S of no human
#     activity (enforced inside the subprocess).
#   * Wall-clock: HYBRID_WALL_CLOCK_S per agent (subprocess-enforced).

HYBRID_MAX_SESSIONS = int(os.environ.get("HYBRID_MAX_SESSIONS", "5"))
HYBRID_RATE_WINDOW_S = int(os.environ.get("HYBRID_RATE_WINDOW_S", "3600"))

# sid -> list of subprocess.Popen (one per agent role)
hybrid_agents: dict[str, list[subprocess.Popen]] = {}
# (task_id, client_ip) -> deque[timestamp] within rate window
hybrid_rate_state: dict[tuple[str, str], deque] = {}
_hybrid_lock = threading.Lock()


def _hybrid_rate_allow(task_id: str, client_ip: str) -> bool:
    """Per-IP-per-task rate limit. Drops records outside the window."""
    if not client_ip:
        client_ip = "unknown"
    key = (task_id, client_ip)
    now = time.time()
    cutoff = now - HYBRID_RATE_WINDOW_S
    with _hybrid_lock:
        q = hybrid_rate_state.setdefault(key, deque())
        while q and q[0] < cutoff:
            q.popleft()
        if len(q) >= 1:  # 1 session per task per IP per window
            return False
        q.append(now)
        return True


def _snapshot_initial_workspace(session_id: str, ws_path: str) -> None:
    """Mirror the staged workspace to Firebase BEFORE agents start editing.

    The Verifier diffs current-vs-initial to see exactly what the Executor
    changed. Without this snapshot the diff would always show "everything
    was just written" because Firebase's /files also updates as the
    executor edits. We use a parallel path sessions/{sid}/initialWorkspace
    and only write it once.
    """
    import httpx as _httpx  # already in deps

    fb_root = os.environ.get("FIREBASE_DB_URL",
                             "https://ivory-plane-406700-default-rtdb.firebaseio.com")
    # Check if already captured (idempotent — don't wipe on repeat /start-hybrid).
    try:
        r = _httpx.get(f"{fb_root}/teambench/sessions/{session_id}/initialWorkspace.json",
                       timeout=5.0)
        if r.status_code == 200 and r.text and r.text != "null":
            return
    except Exception:
        pass

    entries: dict[str, dict] = {}
    SKIP = {"__pycache__", ".pytest_cache", ".git", "node_modules", ".venv"}
    for root_dir, dirs, fnames in os.walk(ws_path):
        dirs[:] = [d for d in dirs if d not in SKIP]
        for fn in fnames:
            full = os.path.join(root_dir, fn)
            rel = os.path.relpath(full, ws_path)
            try:
                if os.path.getsize(full) > 200_000:
                    continue
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()
            except Exception:
                continue
            # Same key-escape scheme as the existing /files path.
            key = "".join("_" if ch in "./[]#$" else ch for ch in rel)
            entries[key] = {"path": rel, "content": content}
    try:
        _httpx.put(f"{fb_root}/teambench/sessions/{session_id}/initialWorkspace.json",
                   json=entries, timeout=10.0)
    except Exception as e:
        print(f"[initialWorkspace] snapshot failed for {session_id}: {e}")


def _start_hybrid_agents(session_id: str, task_id: str) -> None:
    """Spawn planner + executor agent_runner subprocesses.

    Keys are inherited via os.environ (already loaded from .env at startup).
    We pass env explicitly so the subprocess sees exactly what the parent
    has — no extra leakage, no missing state.
    """
    session = sessions.get(session_id)
    if not session:
        raise HTTPException(404, "Session not found — call /create first")
    ws_path = session.get("ws_path") or os.path.join(session["workspace_dir"], "workspace")

    # Snapshot the baseline BEFORE spawning agents. Must be sync so agents
    # don't race us.
    _snapshot_initial_workspace(session_id, ws_path)

    with _hybrid_lock:
        if session_id in hybrid_agents:
            return  # idempotent

    runner = os.path.join(os.path.dirname(__file__), "agent_runner.py")
    python_bin = os.environ.get("HYBRID_PYTHON", sys.executable)

    # Start both agents. Stdout/stderr go to a per-session log file so we
    # can debug without logs polluting the uvicorn stream.
    log_dir = os.environ.get("HYBRID_LOG_DIR", "/tmp/teambench_hybrid_logs")
    os.makedirs(log_dir, exist_ok=True)

    procs: list[subprocess.Popen] = []
    for role in ("planner", "executor"):
        log_path = os.path.join(log_dir, f"{session_id}_{role}.log")
        lf = open(log_path, "a", buffering=1)
        p = subprocess.Popen(
            [
                python_bin, runner,
                "--session-id", session_id,
                "--role", role,
                "--task-id", task_id,
                "--workspace-path", ws_path,
            ],
            env=os.environ.copy(),
            stdout=lf,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,  # so SIGTERM doesn't cascade unexpectedly
        )
        procs.append(p)

    with _hybrid_lock:
        hybrid_agents[session_id] = procs


def _stop_hybrid_agents(session_id: str) -> None:
    """Terminate agent subprocesses for a session. Idempotent."""
    with _hybrid_lock:
        procs = hybrid_agents.pop(session_id, [])
    for p in procs:
        try:
            if p.poll() is None:
                p.terminate()
        except Exception:
            pass
    # Brief grace period, then SIGKILL stragglers.
    deadline = time.time() + 3.0
    for p in procs:
        try:
            remaining = max(0.1, deadline - time.time())
            p.wait(timeout=remaining)
        except subprocess.TimeoutExpired:
            try:
                p.kill()
            except Exception:
                pass
        except Exception:
            pass


from pydantic import BaseModel

class CreateSessionRequest(BaseModel):
    files: dict[str, str] = {}  # path -> content, sent from frontend

@app.post("/api/session/{session_id}/create")
async def create_session(session_id: str, task_id: str = "DEMO_api_fix", body: CreateSessionRequest = CreateSessionRequest()):
    """Create a Docker container for a session."""
    if len(sessions) >= MAX_CONTAINERS:
        raise HTTPException(503, "Too many active sessions. Try again later.")

    if session_id in sessions:
        return {"status": "exists", "session_id": session_id}

    # Create a temporary workspace directory (workspace/, reports/, submission/).
    workspace_dir = tempfile.mkdtemp(prefix=f"tb_{session_id}_")
    ws_path = os.path.join(workspace_dir, "workspace")
    reports_path = os.path.join(workspace_dir, "reports")
    submission_path = os.path.join(workspace_dir, "submission")

    # 1) Stage static workspace + generator overlay + reports/expected.json.
    stage_info = _stage_task_workspace(task_id, workspace_dir, seed=DEFAULT_SEED)

    # 2) Apply frontend-provided overrides (Monaco edits or DEMO_api_fix files).
    for file_path, content in body.files.items():
        safe_path = os.path.normpath(file_path).lstrip("/").lstrip("../")
        full_path = os.path.join(ws_path, safe_path)
        real_path = os.path.realpath(full_path)
        if not real_path.startswith(os.path.realpath(ws_path)):
            continue
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w") as f:
            f.write(content)

    # 3) Ensure pytest can import root-level modules (src/, app.py, ...).
    _ensure_conftest(ws_path)

    # 4) Make everything world-writable so container uid 10001 can edit.
    for p in (ws_path, reports_path, submission_path):
        _chmod_recursive(p)

    # Use a short hash of the full session_id to guarantee uniqueness while
    # keeping container names within Docker's 64-char limit. The previous
    # session_id[:16] truncation caused collisions for sessions sharing a
    # common task prefix (e.g. all "SEC3_crypto_upgrade_oracle_*" sessions
    # collapsed to "SEC3_crypto_upgr").
    session_hash = hashlib.sha256(session_id.encode()).hexdigest()[:12]
    container_name = f"tb-human-{session_hash}"

    container_env = {"PYTHONPATH": "/workspace", "PYTHONDONTWRITEBYTECODE": "1"}

    container_volumes = {
        ws_path: {"bind": "/workspace", "mode": "rw"},
        reports_path: {"bind": "/reports", "mode": "rw"},
        submission_path: {"bind": "/submission", "mode": "rw"},
    }
    container_kwargs = dict(
        command="sleep infinity",
        detach=True,
        name=container_name,
        volumes=container_volumes,
        working_dir="/workspace",
        environment=container_env,
        mem_limit="1g",
        cpu_period=100000,
        cpu_quota=100000,  # 1.0 CPU
        network_mode="bridge",
        remove=False,
    )

    try:
        container = docker_client.containers.run(DOCKER_IMAGE, **container_kwargs)
    except docker.errors.APIError as e:
        # Defensive: if a stale container with this name still exists, remove it and retry once.
        if "Conflict" in str(e) or "already in use" in str(e):
            try:
                old = docker_client.containers.get(container_name)
                old.remove(force=True)
                container = docker_client.containers.run(DOCKER_IMAGE, **container_kwargs)
            except Exception as retry_err:
                shutil.rmtree(workspace_dir, ignore_errors=True)
                print(f"[create_session] Container conflict retry failed: {retry_err}")
                raise HTTPException(500, f"Failed to create container: {retry_err}")
        else:
            shutil.rmtree(workspace_dir, ignore_errors=True)
            print(f"[create_session] Docker API error: {e}")
            raise HTTPException(500, f"Failed to create container: {e}")
    except Exception as e:
        shutil.rmtree(workspace_dir, ignore_errors=True)
        print(f"[create_session] Unexpected error: {e}")
        raise HTTPException(500, f"Failed to create container: {e}")

    sessions[session_id] = {
        "container_id": container.id,
        "workspace_dir": workspace_dir,
        "ws_path": ws_path,
        "reports_path": reports_path,
        "submission_path": submission_path,
        "task_id": task_id,
        "task_dir_resolved": stage_info.get("task_dir_resolved", ""),
        "grade_sh_path": stage_info.get("grade_sh", ""),
        "created_at": time.time(),
    }

    # Run the task's setup.sh (installs task-specific deps like flask, pytest-flask).
    setup_output = ""
    if stage_info.get("setup_sh"):
        try:
            setup_src = stage_info["setup_sh"]
            with open(setup_src, "rb") as f:
                setup_bytes = f.read()
            import tarfile, io
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode="w") as tar:
                ti = tarfile.TarInfo(name="setup.sh")
                ti.size = len(setup_bytes)
                ti.mode = 0o755
                tar.addfile(ti, io.BytesIO(setup_bytes))
            buf.seek(0)
            container.put_archive("/tmp", buf.read())
            # Run setup.sh from /tmp (not /workspace) so any stray shell
            # redirects don't pollute the user-visible workspace.
            r = container.exec_run(
                ["bash", "-c", "bash /tmp/setup.sh"],
                environment=container_env,
                workdir="/tmp",
                user="root",  # pip install may need root; base image USER=agent
            )
            setup_output = r.output.decode("utf-8", errors="replace")[-500:]
        except Exception as e:
            setup_output = f"setup.sh failed: {e}"
            print(f"[create_session] {setup_output}")

    return {
        "status": "created",
        "session_id": session_id,
        "container_id": container.short_id,
        "staged_from_generator": stage_info.get("generator_found", False),
        "files_staged": stage_info.get("files_written", 0),
        "setup_ran": bool(stage_info.get("setup_sh")),
        "setup_tail": setup_output,
        "static_workspace_used": stage_info.get("static_workspace_used", False),
        "has_grader": bool(stage_info.get("grade_sh")),
        "expected_written": stage_info.get("expected_written", False),
    }


class WriteFileRequest(BaseModel):
    path: str
    content: str


@app.get("/api/session/{session_id}/files")
async def list_files(session_id: str):
    """Return all files in the session's workspace (for the editor panel)."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")
    ws_path = session.get("ws_path") or os.path.join(session["workspace_dir"], "workspace")
    results = []
    SKIP_DIRS = {"__pycache__", ".pytest_cache", ".git", "node_modules", ".venv", ".hypothesis"}
    for root, dirs, fnames in os.walk(ws_path):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in sorted(fnames):
            if fn.endswith((".pyc", ".pyo")):
                continue
            full = os.path.join(root, fn)
            rel = os.path.relpath(full, ws_path)
            try:
                size = os.path.getsize(full)
                if size > 200_000:
                    content = f"<file too large: {size} bytes>"
                else:
                    with open(full, "r", encoding="utf-8", errors="replace") as f:
                        content = f.read()
            except Exception as e:
                content = f"<read error: {e}>"
            # Tests, brief, spec, and expected outputs are read-only for the human.
            read_only = (
                rel.startswith("tests/")
                or rel in ("brief.md", "spec.md", "README.md", "README_HUMAN.md",
                           "conftest.py", "analysis_guidance.md")
                or rel.endswith("_test.go")
            )
            # Per-task writable overrides: tasks whose whole point is writing a
            # test file must whitelist that file. Without this, TEST3's single
            # required deliverable (tests/test_integration.py) is blocked by the
            # default "tests/ is read-only" rule.
            WRITABLE_OVERRIDES = {
                "TEST3_integration": {"tests/test_integration.py"},
            }
            task_id = session.get("task_id", "")
            if task_id in WRITABLE_OVERRIDES and rel in WRITABLE_OVERRIDES[task_id]:
                read_only = False
            # Per-task read-only overrides: some task specs explicitly say
            # "do not modify X" but the default RO rule doesn't cover X. For
            # example, CROSS1_api_contract ships a Go reference server that
            # the spec says MUST NOT be modified — but .go files aren't on
            # the default RO list. Lock those paths down here.
            RO_OVERRIDES = {
                "CROSS1_api_contract": lambda p: p.startswith("service/") or p == "service/go.mod",
                "CROSS2_schema_evolution": lambda p: p.startswith("service_a/"),
                "CRYPTO1_nonce_reuse": lambda p: p == "crypto_service/utils.py",
                "GO1_concurrency_fix": lambda p: p.endswith("_test.go"),
            }
            ro_fn = RO_OVERRIDES.get(task_id)
            if ro_fn and ro_fn(rel):
                read_only = True
            language = {
                ".py": "python", ".js": "javascript", ".ts": "typescript",
                ".tsx": "typescript", ".go": "go", ".sh": "shell",
                ".md": "markdown", ".yaml": "yaml", ".yml": "yaml",
                ".json": "json", ".txt": "plaintext", ".sql": "sql",
            }.get(os.path.splitext(rel)[1], "plaintext")
            results.append({
                "path": rel,
                "content": content,
                "language": language,
                "readOnly": read_only,
            })
    return {"files": results}


_ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]")
_PAGER_STATUS_RE = re.compile(r"\s+\[\d+/\d+\]\s*$")
_PAGER_LINES_RE = re.compile(r"\s+\[lines? \d+(?:[-,]\s*\d+)?\]\s*$", re.IGNORECASE)


def _sanitize_source(text: str) -> str:
    """Strip paste artifacts that browser editors carry through xterm/less.

    Mirrors the frontend sanitizeFileContent — defense in depth so older
    cached clients can't push corrupted source into the workspace.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = _ANSI_RE.sub("", text)
    cleaned_lines = []
    for line in text.split("\n"):
        line = _PAGER_STATUS_RE.sub("", line)
        line = _PAGER_LINES_RE.sub("", line)
        cleaned_lines.append(line.rstrip(" \t"))
    return "\n".join(cleaned_lines)


@app.post("/api/session/{session_id}/write-file")
async def write_file(session_id: str, body: WriteFileRequest):
    """Write a file to the session's container workspace (called on every Monaco save)."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    ws_path = session.get("ws_path") or os.path.join(session["workspace_dir"], "workspace")
    file_path = os.path.join(ws_path, body.path)

    real_path = os.path.realpath(file_path)
    if not real_path.startswith(os.path.realpath(ws_path)):
        raise HTTPException(400, "Invalid path")

    clean = _sanitize_source(body.content)
    parent = os.path.dirname(file_path)
    os.makedirs(parent, exist_ok=True)
    with open(file_path, "w") as f:
        f.write(clean)

    # Container runs as uid 10001 (agent); make file + parent writable so the
    # agent can overwrite or delete the file (e.g. when analysis.py regenerates
    # results.json). Without this, tasks that write outputs hit PermissionError.
    try:
        os.chmod(file_path, 0o666)
        os.chmod(parent, 0o777)
    except OSError:
        pass

    return {"status": "ok", "path": body.path, "size": len(clean),
            "stripped_bytes": len(body.content) - len(clean)}


@app.post("/api/session/{session_id}/grade")
async def grade_session(session_id: str):
    """
    Run the task's grade.sh inside the container with the canonical 4-arg
    signature: grade.sh /workspace /reports /submission /task

    The grader writes score.json to /reports. We read it back from the host.
    """
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    grade_sh = session.get("grade_sh_path") or ""
    task_dir_resolved = session.get("task_dir_resolved") or ""
    if not grade_sh or not os.path.isfile(grade_sh) or not task_dir_resolved:
        return {"status": "no_grader",
                "message": f"No grade.sh resolved for {session['task_id']}"}

    try:
        container = docker_client.containers.get(session["container_id"])

        # Copy the full task_dir into /task in the container, plus the shared
        # harness/grader_helpers.sh into /harness (some graders `source
        # $(dirname "$0")/../../harness/grader_helpers.sh`). Tar on host, then
        # put_archive into / so /task and /harness appear at the container root.
        #
        # 634+ GH* task graders are committed with a uniform 8-space leading
        # indent (template artefact). Heredoc closers like `PYEOF` are indented
        # too, which breaks `<<'PYEOF'` (no `-`), causing bash to swallow the
        # rest of the script as heredoc content and exit 2. textwrap.dedent
        # normalizes this transparently before tarring into the container.
        import tarfile, io, re
        def _dedent_bytes(p: Path) -> bytes:
            """
            Strip a uniform leading indent applied to shell scripts.

            textwrap.dedent doesn't work here: the GH* graders have some lines
            at column 0 (e.g. trailing `# TODO:` comments) while the rest have
            8-space indent, so the *common* prefix is 0. We detect the indent
            from the shebang line and strip exactly that many leading spaces
            from every line.
            """
            try:
                text = p.read_text()
                m = re.match(r'^( +)#!', text)
                if m:
                    indent = m.group(1)
                    text = re.sub(
                        rf'^{re.escape(indent)}', '', text, flags=re.MULTILINE)
                # Many GH* graders use `set -euo pipefail` but then do
                # `var=$(cmd_that_can_fail)` without guarding — which trips
                # errexit and silently exits 2. Drop -e so the explicit
                # `check` calls determine pass/fail instead of hidden
                # mid-stream failures. Pipefail + nounset still apply.
                text = re.sub(
                    r'^(\s*)set\s+-euo\s+pipefail\s*$',
                    r'\1set -uo pipefail',
                    text, flags=re.MULTILINE)
                text = re.sub(
                    r'^(\s*)set\s+-eu\s*$', r'\1set -u',
                    text, flags=re.MULTILINE)
                return text.encode()
            except Exception:
                return p.read_bytes()

        buf = io.BytesIO()
        task_root = Path(task_dir_resolved)
        with tarfile.open(fileobj=buf, mode="w") as tar:
            # Add every file under task_dir, dedenting shell scripts.
            for fp in task_root.rglob("*"):
                if not fp.is_file():
                    continue
                arc = "task/" + str(fp.relative_to(task_root)).replace(os.sep, "/")
                if fp.suffix == ".sh":
                    data = _dedent_bytes(fp)
                else:
                    data = fp.read_bytes()
                info = tarfile.TarInfo(name=arc)
                info.size = len(data)
                info.mode = 0o755 if fp.suffix == ".sh" else 0o644
                tar.addfile(info, io.BytesIO(data))

            helper = Path(TEAMBENCH_ROOT) / "harness" / "grader_helpers.sh"
            if helper.is_file():
                data = _dedent_bytes(helper)
                info = tarfile.TarInfo(name="harness/grader_helpers.sh")
                info.size = len(data)
                info.mode = 0o755
                tar.addfile(info, io.BytesIO(data))
        buf.seek(0)
        try:
            container.exec_run(["rm", "-rf", "/task", "/harness"], user="root")
        except Exception:
            pass
        container.put_archive("/", buf.read())
        container.exec_run(["chmod", "-R", "a+rx", "/task", "/harness"], user="root")

        exec_result = container.exec_run(
            [
                "bash", "-c",
                "bash /task/grade.sh /workspace /reports /submission /task",
            ],
            environment={
                "PYTHONPATH": "/workspace",
                "WORKSPACE": "/workspace",
                "REPORTS": "/reports",
                "SUBMISSION": "/submission",
                "TASK_DIR": "/task",
            },
            workdir="/workspace",
        )
        output = exec_result.output.decode("utf-8", errors="replace")
        exit_code = exec_result.exit_code

        # score.json is written to /reports/score.json by the canonical graders.
        reports_path = session.get("reports_path") or os.path.join(
            session["workspace_dir"], "reports")
        score = None
        for candidate in ("score.json",):
            p = os.path.join(reports_path, candidate)
            if os.path.exists(p):
                try:
                    with open(p) as f:
                        score = json.load(f)
                    break
                except Exception as e:
                    print(f"[grade] failed to read {p}: {e}")

        return {
            "status": "graded",
            "exit_code": exit_code,
            "output": output[-2000:],
            "score": score,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


@app.post("/api/session/{session_id}/start-hybrid")
async def start_hybrid(session_id: str, request: Request, task_id: str = "DEMO_api_fix"):
    """Spawn LLM planner + executor for a hybrid session.

    Rate limit: 1 session per (task_id, client_ip) per hour.
    Global cap: HYBRID_MAX_SESSIONS concurrent.
    Kill switch: HYBRID_DISABLED=1 refuses the call.
    """
    if os.environ.get("HYBRID_DISABLED") == "1":
        raise HTTPException(503, "Hybrid mode is disabled")

    with _hybrid_lock:
        if len(hybrid_agents) >= HYBRID_MAX_SESSIONS:
            raise HTTPException(503, "Too many active hybrid sessions")

    client_ip = (request.headers.get("x-forwarded-for", "") or request.client.host or "").split(",")[0].strip()
    if not _hybrid_rate_allow(task_id, client_ip):
        raise HTTPException(429, "Rate limit: try again later or pick a different task")

    # Must have a session + workspace already provisioned.
    if session_id not in sessions:
        raise HTTPException(404, "Session not found — call /create first")

    # At least one LLM gateway must be available, else we'd spawn processes
    # that immediately fail. Import lazily so server boots even if deps missing.
    try:
        sys.path.insert(0, os.path.dirname(__file__))
        from providers import model_pool  # type: ignore
        if not model_pool.available_gateways():
            raise HTTPException(503, "No LLM gateways configured on backend")
    except ImportError as e:
        raise HTTPException(503, f"Hybrid dependencies missing: {type(e).__name__}")

    _start_hybrid_agents(session_id, task_id)
    return {"status": "started", "session_id": session_id}


@app.post("/api/session/{session_id}/stop-hybrid")
async def stop_hybrid(session_id: str):
    """Terminate hybrid agents for a session. Idempotent."""
    _stop_hybrid_agents(session_id)
    return {"status": "stopped"}


@app.delete("/api/session/{session_id}")
async def delete_session(session_id: str):
    """Clean up a session."""
    cleanup_session(session_id)
    return {"status": "deleted"}


@app.get("/api/sessions")
async def list_sessions():
    """List active sessions (admin endpoint)."""
    return {
        "count": len(sessions),
        "sessions": [
            {
                "session_id": sid,
                "task_id": info["task_id"],
                "age_seconds": int(time.time() - info["created_at"]),
            }
            for sid, info in sessions.items()
        ],
    }


@app.websocket("/ws/terminal/{session_id}")
async def terminal_websocket(websocket: WebSocket, session_id: str):
    """WebSocket terminal — proxies stdin/stdout to Docker exec."""
    await websocket.accept()

    session = get_session(session_id)
    if not session:
        await websocket.send_json({"type": "error", "data": "Session not found. Create it first."})
        await websocket.close()
        return

    try:
        container = docker_client.containers.get(session["container_id"])
    except docker.errors.NotFound:
        await websocket.send_json({"type": "error", "data": "Container not found."})
        await websocket.close()
        return

    # Create an interactive exec instance
    exec_instance = docker_client.api.exec_create(
        container.id,
        cmd=["/bin/bash"],
        stdin=True,
        stdout=True,
        stderr=True,
        tty=True,
        workdir="/workspace",
    )

    sock = docker_client.api.exec_start(
        exec_instance["Id"],
        socket=True,
        tty=True,
    )
    raw_sock = sock._sock

    # Enable TCP keepalive so dead docker-exec sockets are detected in seconds,
    # not minutes. Without this, a silently-dropped exec socket leaves the WS
    # reader blocked in recv() forever and the terminal appears frozen.
    import socket as _socket
    try:
        raw_sock.setsockopt(_socket.SOL_SOCKET, _socket.SO_KEEPALIVE, 1)
        # Linux-specific knobs (harmless if unavailable).
        for opt, val in (("TCP_KEEPIDLE", 30), ("TCP_KEEPINTVL", 10), ("TCP_KEEPCNT", 3)):
            if hasattr(_socket, opt):
                raw_sock.setsockopt(_socket.IPPROTO_TCP, getattr(_socket, opt), val)
    except Exception as e:
        print(f"[ws] keepalive setup failed: {e}")

    stop_event = asyncio.Event()

    await websocket.send_json({"type": "output", "data": "Connected to sandbox terminal.\r\n"})

    async def read_from_container():
        """Pump container stdout → WebSocket. Triggers shutdown on EOF/error."""
        loop = asyncio.get_event_loop()
        try:
            while not stop_event.is_set():
                data = await loop.run_in_executor(None, lambda: raw_sock.recv(4096))
                if not data:
                    await websocket.send_json({"type": "output",
                        "data": "\r\n\x1b[31m[Shell exited — reload page]\x1b[0m\r\n"})
                    break
                await websocket.send_json({"type": "output",
                    "data": data.decode("utf-8", errors="replace")})
        except Exception as e:
            print(f"[ws/read] {type(e).__name__}: {e}")
        finally:
            stop_event.set()

    async def write_to_container():
        """Pump WebSocket → container stdin. Handles ping/pong keepalive."""
        try:
            while not stop_event.is_set():
                msg = await websocket.receive_text()
                parsed = json.loads(msg)
                t = parsed.get("type")
                if t == "input":
                    try:
                        raw_sock.send(parsed["data"].encode("utf-8"))
                    except (BrokenPipeError, ConnectionResetError, OSError) as e:
                        print(f"[ws/write] raw_sock dead: {e}")
                        break
                elif t == "resize":
                    try:
                        docker_client.api.exec_resize(
                            exec_instance["Id"],
                            height=parsed.get("rows", 24),
                            width=parsed.get("cols", 80),
                        )
                    except Exception:
                        pass
                elif t == "ping":
                    await websocket.send_json({"type": "pong"})
        except WebSocketDisconnect:
            pass
        except Exception as e:
            print(f"[ws/write] {type(e).__name__}: {e}")
        finally:
            stop_event.set()

    reader = asyncio.create_task(read_from_container())
    writer = asyncio.create_task(write_to_container())

    # Keepalive loop: while neither side exits, fire a heartbeat every 20s.
    async def keepalive_loop():
        while not stop_event.is_set():
            try:
                await asyncio.wait_for(stop_event.wait(), timeout=20)
                break  # stop_event set → exit loop
            except asyncio.TimeoutError:
                try:
                    await websocket.send_json({"type": "hb"})
                except Exception:
                    stop_event.set()
                    break
    keepalive = asyncio.create_task(keepalive_loop())

    try:
        await asyncio.gather(reader, writer, keepalive, return_exceptions=True)
    finally:
        for t in (reader, writer, keepalive):
            if not t.done():
                t.cancel()
        try:
            raw_sock.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.on_event("startup")
async def startup_cleanup():
    """Remove orphan tb-human-* containers left behind by a prior crash."""
    try:
        for c in docker_client.containers.list(all=True):
            if c.name.startswith("tb-human-"):
                try:
                    c.remove(force=True)
                    print(f"[startup] removed orphan container {c.name}")
                except Exception as e:
                    print(f"[startup] failed to remove {c.name}: {e}")
    except Exception as e:
        print(f"[startup] orphan scan failed: {e}")


@app.on_event("shutdown")
async def shutdown():
    """Clean up all containers on server shutdown."""
    for session_id in list(sessions.keys()):
        cleanup_session(session_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8443)
