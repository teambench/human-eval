"""OpenAI-compatible gateway — handles OpenAI direct + OpenRouter.

Both exposes the /v1/chat/completions API; only the base_url + key differ.
OpenRouter uses provider-prefixed model IDs ("openai/gpt-5.4-mini",
"google/gemini-3-flash"), which we let the caller specify.

Security:
- The API key is only read from the env dict passed in; never logged, never
  returned from errors. The `openai` SDK itself doesn't include the key in
  exception messages.
"""
from __future__ import annotations

from typing import Any

try:
    from openai import OpenAI, APIError, APIStatusError, APITimeoutError, RateLimitError
except ImportError:  # openai SDK not installed
    OpenAI = None  # type: ignore
    APIError = APIStatusError = APITimeoutError = RateLimitError = Exception  # type: ignore


class GatewayError(Exception):
    """Wraps provider errors so upstream only sees a generic failure.

    We never include the API key or any secret in the message — only the
    gateway identifier + short reason (HTTP status or exception class).
    """

    def __init__(self, gateway: str, reason: str, retriable: bool):
        super().__init__(f"{gateway}: {reason}")
        self.gateway = gateway
        self.reason = reason
        self.retriable = retriable


def call(
    *,
    gateway_id: str,
    base_url: str | None,
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
    if OpenAI is None:
        raise GatewayError(gateway_id, "openai SDK not installed", retriable=False)

    client = OpenAI(base_url=base_url, api_key=api_key, timeout=timeout)

    # GPT-5 family (and a few others) reject `max_tokens` and require
    # `max_completion_tokens` instead. Detect by model-name prefix; the
    # error otherwise is a hard 400 ("Unsupported parameter: 'max_tokens'
    # is not supported with this model").
    is_gpt5_family = model.startswith("gpt-5") or model.startswith("o1") or model.startswith("o3")
    create_kwargs: dict[str, Any] = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if is_gpt5_family:
        create_kwargs["max_completion_tokens"] = max_tokens
    else:
        create_kwargs["max_tokens"] = max_tokens

    try:
        resp = client.chat.completions.create(**create_kwargs)  # type: ignore[arg-type]
    except RateLimitError:
        raise GatewayError(gateway_id, "rate_limited", retriable=True)
    except APITimeoutError:
        raise GatewayError(gateway_id, "timeout", retriable=True)
    except APIStatusError as e:
        # 5xx → retry; 4xx (auth/bad-request) → fall through to next gateway
        retriable = e.status_code >= 500
        raise GatewayError(gateway_id, f"http_{e.status_code}", retriable=retriable)
    except APIError:
        raise GatewayError(gateway_id, "api_error", retriable=True)
    except Exception as e:
        # Defensive: some SDK errors fall outside the classes above. Strip
        # the full repr because it can include url+headers (though not key).
        raise GatewayError(gateway_id, f"{type(e).__name__}", retriable=True)

    choice = resp.choices[0]
    return {
        "content": choice.message.content or "",
        "finish_reason": choice.finish_reason,
        "usage": {
            "prompt_tokens": getattr(resp.usage, "prompt_tokens", 0),
            "completion_tokens": getattr(resp.usage, "completion_tokens", 0),
        },
    }
