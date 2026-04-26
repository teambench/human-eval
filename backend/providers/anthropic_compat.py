"""Anthropic-native gateway (anthropic SDK).

Separate from openai_compat because the Messages API has different
schema (system as a top-level field, no role 'system' inside messages,
content blocks as objects). We still return the same
`{content, finish_reason, usage}` shape so the model_pool code path is
provider-agnostic.

Security: same rules — API key only from the caller, never logged.
"""
from __future__ import annotations

from typing import Any

try:
    import anthropic
    from anthropic import (
        APIError,
        APIStatusError,
        APITimeoutError,
        RateLimitError,
    )
except ImportError:  # anthropic SDK not installed
    anthropic = None  # type: ignore
    APIError = APIStatusError = APITimeoutError = RateLimitError = Exception  # type: ignore

from .openai_compat import GatewayError


def _split_messages(
    messages: list[dict[str, Any]],
) -> tuple[str | None, list[dict[str, Any]]]:
    """Pull system messages out into a single system string for Anthropic.

    Anthropic's Messages API expects:
      messages: [{role:'user'|'assistant', content:str|blocks}, ...]
      system:   string (or None) — set at top level, NOT in the messages list

    We concatenate all 'system' messages with blank lines so multi-system
    prompts (e.g. role + style guide) compose naturally.
    """
    system_parts: list[str] = []
    out: list[dict[str, Any]] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "") or ""
        if role == "system":
            system_parts.append(content)
            continue
        # Anthropic only knows 'user' and 'assistant'.
        anth_role = "assistant" if role == "assistant" else "user"
        out.append({"role": anth_role, "content": content})
    system = "\n\n".join(system_parts) if system_parts else None
    return system, out


def call(
    *,
    gateway_id: str,
    api_key: str,
    model: str,
    messages: list[dict[str, Any]],
    temperature: float = 0.2,
    max_tokens: int = 2048,
    timeout: float = 60.0,
) -> dict[str, Any]:
    """Single blocking call. Returns `{content, finish_reason, usage}`.

    Raises `GatewayError` with retriable flag on any failure.
    """
    if anthropic is None:
        raise GatewayError(gateway_id, "anthropic SDK not installed", retriable=False)

    client = anthropic.Anthropic(api_key=api_key, timeout=timeout)
    system, anth_messages = _split_messages(messages)

    try:
        resp = client.messages.create(
            model=model,
            messages=anth_messages,  # type: ignore[arg-type]
            system=system or anthropic.NOT_GIVEN,  # type: ignore[arg-type]
            temperature=temperature,
            max_tokens=max_tokens,
        )
    except RateLimitError:
        raise GatewayError(gateway_id, "rate_limited", retriable=True)
    except APITimeoutError:
        raise GatewayError(gateway_id, "timeout", retriable=True)
    except APIStatusError as e:
        # 5xx → retry; 4xx (auth/bad-request/model-not-found) → fall through.
        retriable = e.status_code >= 500
        raise GatewayError(gateway_id, f"http_{e.status_code}", retriable=retriable)
    except APIError:
        raise GatewayError(gateway_id, "api_error", retriable=True)
    except Exception as e:
        raise GatewayError(gateway_id, f"{type(e).__name__}", retriable=True)

    # content is a list of TextBlock-style objects; concatenate text parts.
    text_chunks: list[str] = []
    for block in (resp.content or []):
        text = getattr(block, "text", None)
        if isinstance(text, str):
            text_chunks.append(text)

    return {
        "content": "".join(text_chunks),
        "finish_reason": getattr(resp, "stop_reason", "stop") or "stop",
        "usage": {
            "prompt_tokens": getattr(getattr(resp, "usage", None), "input_tokens", 0) or 0,
            "completion_tokens": getattr(getattr(resp, "usage", None), "output_tokens", 0) or 0,
        },
    }
