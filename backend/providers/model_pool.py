"""Multi-tier LLM cascade with health-based cooldown.

Cascade is registered fresh on every call_llm() so new keys / model
changes in .env take effect on the next call without restarting the
process. Order is QUALITY+RELIABILITY first, COST/SCALE backups last:

  1. Anthropic Claude (Sonnet → Haiku → Opus)         — primary
  2. OpenAI direct (gpt-5.5-pro → gpt-4-0613 → gpt-4 → gpt-3.5-turbo)
  3. Gemini direct, primary key (gemini-3-flash)
  4. Gemini direct, all rotation keys (GEMINI_API_KEY_1..N)
  5. Gemini direct, fallback model names on primary key
  6. OpenRouter (mixed providers)                      — last resort

Each gateway gets PER_GATEWAY_RETRIES with backoff before falling
through. A gateway that fails FAIL_THRESHOLD times in a row enters a
COOLDOWN_SECONDS skip window. Cooldown auto-clears after expiry so
keys that were rate-limited briefly come back online.

Provider redundancy is the design goal: a single dead key, a retired
model, or an uninstalled SDK should never take the system down. Earlier
incident: every gateway happened to be one of {dead-key, dead-model,
missing-SDK} simultaneously, leaving zero working LLMs.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from . import anthropic_compat, gemini_native, openai_compat
from .openai_compat import GatewayError

log = logging.getLogger("hybrid.model_pool")

# ── Model catalog ────────────────────────────────────────────────────────
# Lists are tried IN ORDER. Add new models at the head, deprecate at tail.

ANTHROPIC_MODELS = (
    "claude-sonnet-4-5-20250929",
    "claude-haiku-4-5-20251001",
    "claude-opus-4-5-20251101",
)

# Mix of GPT-5 family (modern) + GPT-4 family (broad-availability backups).
# openai_compat.call() auto-switches max_tokens→max_completion_tokens for
# the GPT-5 family, so all of these work with the same call signature.
OPENAI_MODELS = (
    "gpt-5.4-mini-2026-03-17",
    "gpt-5.4",
    "gpt-4-0613",
    "gpt-4",
    "gpt-3.5-turbo",
)

# `gemini-flash-latest` is the moving alias that the v1beta API resolves to
# whatever the current best Gemini Flash is. Verified responding for the
# primary key. Plain `gemini-3-flash` (without -preview) is NOT a valid
# model id — it 404s.
GEMINI_PRIMARY_MODEL = "gemini-flash-latest"
# Fallback Gemini models tried only on the primary key (not rotated, since
# they're a "model dead" backstop, not a "key dead" one).
GEMINI_FALLBACK_MODELS = (
    "gemini-3-flash-preview",
    "gemini-flash-lite-latest",
    "gemini-2.5-flash-lite",
)

# OpenRouter is provider-of-providers. Cross-provider mixed catalog so
# a single OpenRouter key activates fallbacks for all three primary
# providers. Models use OpenRouter's provider/model naming.
OPENROUTER_MODELS = (
    # Mirror the OpenAI direct fleet via OpenRouter so a dead OpenAI direct
    # key still has a path through OpenRouter (and vice versa). User asked
    # for gpt-5.4-mini via OpenRouter as a backup.
    "openai/gpt-5.4-mini",
    "openai/gpt-5.4",
    "openai/gpt-4o-mini",
    "openai/gpt-4-turbo",
    # Cross-provider fallbacks so one key gives access to all 3 ecosystems.
    "anthropic/claude-sonnet-4-5-20250929",
    "anthropic/claude-haiku-4-5-20251001",
    "google/gemini-flash-latest",
    "google/gemini-2.5-flash",
)

GEMINI_KEY_RANGE = range(1, 30)  # GEMINI_API_KEY_1..29 inclusive


# ── Gateway registration ─────────────────────────────────────────────────


@dataclass
class Gateway:
    id: str
    model: str  # human-readable (for logging)
    call: Callable[..., dict[str, Any]]
    required_env: tuple[str, ...]


def _collect_gemini_keys() -> list[tuple[str, str]]:
    """Return [(label, key), ...] for every GEMINI_API_KEY* env var present.

    Label is 'primary' for the bare GEMINI_API_KEY, 'k1'..'kN' for the
    numbered variants. Order is primary first, then numeric ascending.
    """
    out: list[tuple[str, str]] = []
    primary = os.environ.get("GEMINI_API_KEY") or ""
    if primary:
        out.append(("primary", primary))
    seen: set[str] = {primary} if primary else set()
    for i in GEMINI_KEY_RANGE:
        v = os.environ.get(f"GEMINI_API_KEY_{i}") or ""
        if v and v not in seen:
            out.append((f"k{i}", v))
            seen.add(v)
    return out


def _load_gateways() -> list[Gateway]:
    """Build the cascade from available env vars; skip any missing creds.

    Closures capture key/model/gid via default-args to avoid the classic
    late-binding trap (all closures sharing the loop variable's last value).
    """
    openai_key = os.environ.get("OPENAI_API_KEY") or ""
    openrouter_key = os.environ.get("OPENROUTER_API") or os.environ.get("OPENROUTER_API_KEY") or ""
    anthropic_key = os.environ.get("ANTHROPIC_API_KEY") or ""
    gemini_keys = _collect_gemini_keys()

    gw: list[Gateway] = []

    # 1. Anthropic — primary tier (highest reliability + quality).
    if anthropic_key:
        for model in ANTHROPIC_MODELS:
            gid = f"anthropic/{model}"
            gw.append(Gateway(
                id=gid, model=model,
                call=lambda messages, _key=anthropic_key, _model=model, _gid=gid, **kw:
                    anthropic_compat.call(
                        gateway_id=_gid, api_key=_key, model=_model,
                        messages=messages, **kw,
                    ),
                required_env=("ANTHROPIC_API_KEY",),
            ))

    # 2. OpenAI direct — same key, walk model list (newest first).
    if openai_key:
        for model in OPENAI_MODELS:
            gid = f"openai/{model}"
            gw.append(Gateway(
                id=gid, model=model,
                call=lambda messages, _key=openai_key, _model=model, _gid=gid, **kw:
                    openai_compat.call(
                        gateway_id=_gid, base_url=None, api_key=_key,
                        model=_model, messages=messages, **kw,
                    ),
                required_env=("OPENAI_API_KEY",),
            ))

    # 3. Gemini direct — primary key first, then rotation keys.
    for key_label, key in gemini_keys:
        gid = f"gemini/{GEMINI_PRIMARY_MODEL}#{key_label}"
        gw.append(Gateway(
            id=gid, model=GEMINI_PRIMARY_MODEL,
            call=lambda messages, _key=key, _gid=gid, **kw:
                gemini_native.call(
                    gateway_id=_gid, api_key=_key, model=GEMINI_PRIMARY_MODEL,
                    messages=messages, **kw,
                ),
            required_env=("GEMINI_API_KEY",),
        ))

    # 4. Gemini fallback models on the PRIMARY key only — only fires if the
    # whole gemini-3-flash family is broken. Cheap insurance.
    if gemini_keys:
        primary_key = gemini_keys[0][1]
        for model in GEMINI_FALLBACK_MODELS:
            gid = f"gemini/{model}"
            gw.append(Gateway(
                id=gid, model=model,
                call=lambda messages, _key=primary_key, _model=model, _gid=gid, **kw:
                    gemini_native.call(
                        gateway_id=_gid, api_key=_key, model=_model,
                        messages=messages, **kw,
                    ),
                required_env=("GEMINI_API_KEY",),
            ))

    # 5. OpenRouter — last resort, cross-provider redundancy.
    if openrouter_key:
        for model in OPENROUTER_MODELS:
            gid = f"openrouter/{model}"
            gw.append(Gateway(
                id=gid, model=model,
                call=lambda messages, _key=openrouter_key, _model=model, _gid=gid, **kw:
                    openai_compat.call(
                        gateway_id=_gid, base_url="https://openrouter.ai/api/v1",
                        api_key=_key, model=_model, messages=messages, **kw,
                    ),
                required_env=("OPENROUTER_API",),
            ))

    return gw


# ── Health tracking ──────────────────────────────────────────────────────


@dataclass
class _GatewayHealth:
    consecutive_fails: int = 0
    cooldown_until: float = 0.0  # unix ts; 0 = not cooling down


_health: dict[str, _GatewayHealth] = {}
_health_lock = threading.Lock()

COOLDOWN_SECONDS = 60.0
FAIL_THRESHOLD = 3
PER_GATEWAY_RETRIES = 1     # was 2; with ~20 gateways we'd rather move on
BACKOFF_SECONDS = (1.0,)    # one backoff per retry; len must == PER_GATEWAY_RETRIES


def _on_success(gid: str) -> None:
    with _health_lock:
        h = _health.setdefault(gid, _GatewayHealth())
        h.consecutive_fails = 0
        h.cooldown_until = 0.0


def _on_fail(gid: str) -> None:
    with _health_lock:
        h = _health.setdefault(gid, _GatewayHealth())
        h.consecutive_fails += 1
        if h.consecutive_fails >= FAIL_THRESHOLD:
            h.cooldown_until = time.time() + COOLDOWN_SECONDS


def _is_cooling(gid: str) -> bool:
    with _health_lock:
        h = _health.get(gid)
        if not h:
            return False
        if h.cooldown_until and time.time() >= h.cooldown_until:
            # Cooldown expired — clear so we try once.
            h.cooldown_until = 0.0
            h.consecutive_fails = 0
            return False
        return h.cooldown_until > 0


# ── Public API ───────────────────────────────────────────────────────────


@dataclass
class LLMResponse:
    content: str
    gateway_id: str
    usage: dict[str, int] = field(default_factory=dict)
    finish_reason: str = "stop"


def call_llm(
    messages: list[dict[str, Any]],
    *,
    temperature: float = 0.2,
    max_tokens: int = 2048,
    timeout: float = 60.0,
) -> LLMResponse:
    """Walk the cascade until one gateway succeeds. Raises on total failure."""
    gateways = _load_gateways()
    if not gateways:
        raise RuntimeError(
            "No LLM gateways configured. Check env vars: "
            "ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY (+ _1..N), OPENROUTER_API."
        )

    errors: list[str] = []
    for gw in gateways:
        if _is_cooling(gw.id):
            errors.append(f"{gw.id}:cooling")
            continue

        for attempt in range(PER_GATEWAY_RETRIES + 1):
            try:
                resp = gw.call(
                    messages,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    timeout=timeout,
                )
                _on_success(gw.id)
                return LLMResponse(
                    content=resp["content"],
                    gateway_id=gw.id,
                    usage=resp.get("usage", {}),
                    finish_reason=resp.get("finish_reason", "stop"),
                )
            except GatewayError as e:
                errors.append(f"{gw.id}:{e.reason}")
                # Non-retriable (4xx auth/bad-request/missing-SDK) — advance
                # immediately so we don't waste backoff time on a permanent
                # failure.
                if not e.retriable or attempt == PER_GATEWAY_RETRIES:
                    _on_fail(gw.id)
                    break
                time.sleep(BACKOFF_SECONDS[attempt])

    raise RuntimeError(f"All LLM gateways failed: {', '.join(errors)}")


def available_gateways() -> list[str]:
    """Public listing for /healthz-style diagnostics. Returns only IDs."""
    return [g.id for g in _load_gateways()]
