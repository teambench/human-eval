"""Gemini-native gateway (google-genai SDK).

Separate from openai_compat because the SDK, message schema, and error
classes differ. We still return the same `{content, finish_reason, usage}`
shape so the model_pool code path is provider-agnostic.

Security: same rules — API key only from the caller, never logged.
"""
from __future__ import annotations

from typing import Any

try:
    from google import genai
    from google.genai import types as genai_types
    from google.genai.errors import APIError as GenaiAPIError
except ImportError:  # google-genai not installed
    genai = None  # type: ignore
    genai_types = None  # type: ignore
    GenaiAPIError = Exception  # type: ignore

from .openai_compat import GatewayError


def _messages_to_gemini(messages: list[dict[str, Any]]) -> tuple[str | None, list[Any]]:
    """Split OpenAI-style messages into (system_instruction, contents[]).

    Gemini puts system prompt in a dedicated field, not in the chat log.
    """
    system_parts: list[str] = []
    contents: list[Any] = []
    for m in messages:
        role = m.get("role")
        content = m.get("content", "") or ""
        if role == "system":
            system_parts.append(content)
            continue
        # Gemini uses "user" and "model" (not "assistant").
        gem_role = "model" if role == "assistant" else "user"
        contents.append(
            genai_types.Content(role=gem_role, parts=[genai_types.Part(text=content)])
        )
    system = "\n\n".join(system_parts) if system_parts else None
    return system, contents


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
    if genai is None:
        raise GatewayError(gateway_id, "google-genai SDK not installed", retriable=False)

    client = genai.Client(api_key=api_key, http_options=genai_types.HttpOptions(timeout=int(timeout * 1000)))
    system, contents = _messages_to_gemini(messages)

    config = genai_types.GenerateContentConfig(
        temperature=temperature,
        max_output_tokens=max_tokens,
        system_instruction=system,
    )

    try:
        resp = client.models.generate_content(
            model=model,
            contents=contents,
            config=config,
        )
    except GenaiAPIError as e:
        code = getattr(e, "code", 0) or 0
        retriable = code == 0 or code >= 500 or code == 429
        reason = f"http_{code}" if code else "api_error"
        raise GatewayError(gateway_id, reason, retriable=retriable)
    except Exception as e:
        raise GatewayError(gateway_id, f"{type(e).__name__}", retriable=True)

    # Defensive: SDK returns text via .text helper; fall back to part text.
    text = getattr(resp, "text", None) or ""
    if not text and getattr(resp, "candidates", None):
        cand = resp.candidates[0]
        parts = getattr(getattr(cand, "content", None), "parts", []) or []
        text = "".join(getattr(p, "text", "") for p in parts)

    usage = getattr(resp, "usage_metadata", None)
    return {
        "content": text,
        "finish_reason": "stop",
        "usage": {
            "prompt_tokens": getattr(usage, "prompt_token_count", 0) if usage else 0,
            "completion_tokens": getattr(usage, "candidates_token_count", 0) if usage else 0,
        },
    }
