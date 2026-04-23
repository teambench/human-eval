"""Multi-gateway LLM cascade with health-based cooldown.

Cascade (per-call, in order):
    1. gpt-5.4-mini via OpenAI direct
    2. gpt-5.4-mini via OpenRouter
    3. gemini-3-flash via Google direct
    4. gemini-3-flash via OpenRouter

Each gateway gets 2 retries with exponential backoff before we advance to
the next. A gateway that fails 3 consecutive times enters a 60s cooldown
(skipped without even attempting a call).

Keys are read from env once at import time; never logged, never returned.
"""
from __future__ import annotations

import logging
import os
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable

from . import gemini_native, openai_compat
from .openai_compat import GatewayError

log = logging.getLogger("hybrid.model_pool")

# ── Gateway catalog ──────────────────────────────────────────────────────
# Each entry is a self-contained callable that takes (messages, **kwargs)
# and returns the normalized response dict (or raises GatewayError).


@dataclass
class Gateway:
    id: str
    model: str  # human-readable (for logging)
    call: Callable[..., dict[str, Any]]
    required_env: tuple[str, ...]


def _load_gateways() -> list[Gateway]:
    """Build the cascade from available env vars; skip any missing creds.

    We deliberately read env here (not at module import) so the backend
    can start even if some keys are missing — only the gateways with
    available keys are registered.
    """
    openai_key = os.environ.get("OPENAI_API_KEY") or ""
    openrouter_key = os.environ.get("OPENROUTER_API") or os.environ.get("OPENROUTER_API_KEY") or ""
    gemini_key = os.environ.get("GEMINI_API_KEY") or ""

    gw: list[Gateway] = []

    if openai_key:
        gw.append(
            Gateway(
                id="openai/gpt-5.4-mini",
                model="gpt-5.4-mini",
                call=lambda messages, **kw: openai_compat.call(
                    gateway_id="openai/gpt-5.4-mini",
                    base_url=None,
                    api_key=openai_key,
                    model="gpt-5.4-mini",
                    messages=messages,
                    **kw,
                ),
                required_env=("OPENAI_API_KEY",),
            )
        )
    if openrouter_key:
        gw.append(
            Gateway(
                id="openrouter/openai/gpt-5.4-mini",
                model="openai/gpt-5.4-mini",
                call=lambda messages, **kw: openai_compat.call(
                    gateway_id="openrouter/openai/gpt-5.4-mini",
                    base_url="https://openrouter.ai/api/v1",
                    api_key=openrouter_key,
                    model="openai/gpt-5.4-mini",
                    messages=messages,
                    **kw,
                ),
                required_env=("OPENROUTER_API",),
            )
        )
    if gemini_key:
        gw.append(
            Gateway(
                id="gemini/gemini-3-flash",
                model="gemini-3-flash",
                call=lambda messages, **kw: gemini_native.call(
                    gateway_id="gemini/gemini-3-flash",
                    api_key=gemini_key,
                    model="gemini-3-flash",
                    messages=messages,
                    **kw,
                ),
                required_env=("GEMINI_API_KEY",),
            )
        )
    if openrouter_key:
        gw.append(
            Gateway(
                id="openrouter/google/gemini-3-flash",
                model="google/gemini-3-flash",
                call=lambda messages, **kw: openai_compat.call(
                    gateway_id="openrouter/google/gemini-3-flash",
                    base_url="https://openrouter.ai/api/v1",
                    api_key=openrouter_key,
                    model="google/gemini-3-flash",
                    messages=messages,
                    **kw,
                ),
                required_env=("OPENROUTER_API",),
            )
        )
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
PER_GATEWAY_RETRIES = 2
BACKOFF_SECONDS = (1.0, 4.0)  # must be len == PER_GATEWAY_RETRIES


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
    gateway_id: str  # which gateway served the call (for logging)
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
            "OPENAI_API_KEY, OPENROUTER_API, GEMINI_API_KEY."
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
                # Non-retriable (4xx auth/bad-request) — advance immediately.
                if not e.retriable or attempt == PER_GATEWAY_RETRIES:
                    _on_fail(gw.id)
                    break
                time.sleep(BACKOFF_SECONDS[attempt])

    # All gateways exhausted.
    raise RuntimeError(f"All LLM gateways failed: {', '.join(errors)}")


def available_gateways() -> list[str]:
    """Public listing for /healthz-style diagnostics. Returns only IDs."""
    return [g.id for g in _load_gateways()]
