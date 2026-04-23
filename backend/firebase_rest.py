"""Firebase Realtime Database REST client (no auth).

Matches how the frontend writes — unauthenticated HTTPS calls against the
public database URL. Relies on the project's Realtime Database rules
being permissive for the `teambench/sessions` path.

If you later tighten the rules to require auth, migrate this to
firebase-admin + service-account JSON. The call-site API (`get`, `set`,
`push`, `update`) stays the same.
"""
from __future__ import annotations

import os
import time
from typing import Any

import httpx

DB_URL = os.environ.get(
    "FIREBASE_DB_URL",
    "https://ivory-plane-406700-default-rtdb.firebaseio.com",
)

_client: httpx.Client | None = None


def _http() -> httpx.Client:
    global _client
    if _client is None:
        _client = httpx.Client(timeout=10.0)
    return _client


def _url(path: str) -> str:
    path = path.lstrip("/")
    return f"{DB_URL}/{path}.json"


def get(path: str) -> Any:
    r = _http().get(_url(path))
    r.raise_for_status()
    return r.json()


def set(path: str, value: Any) -> None:
    r = _http().put(_url(path), json=value)
    r.raise_for_status()


def push(path: str, value: Any) -> str:
    r = _http().post(_url(path), json=value)
    r.raise_for_status()
    return r.json().get("name", "")


def update(path: str, value: dict[str, Any]) -> None:
    r = _http().patch(_url(path), json=value)
    r.raise_for_status()


def delete(path: str) -> None:
    r = _http().delete(_url(path))
    r.raise_for_status()


# ── Convenience paths for session coordination ───────────────────────────

SESSIONS = "teambench/sessions"


def session_path(session_id: str, *parts: str) -> str:
    return "/".join([SESSIONS, session_id, *parts])


def post_message(
    session_id: str, from_role: str, to: str, content: str
) -> str:
    msg = {
        "id": _genid(),
        "from": from_role,
        "to": to,
        "content": content,
        "timestamp": int(time.time() * 1000),
    }
    return push(session_path(session_id, "messages"), msg)


def get_session(session_id: str) -> dict[str, Any] | None:
    return get(session_path(session_id))


def set_phase(session_id: str, phase: str) -> None:
    payload: dict[str, Any] = {"phase": phase}
    if phase in ("completed", "cancelled"):
        payload["endTime"] = int(time.time() * 1000)
        payload["status"] = phase
    else:
        payload["status"] = "active"
    update(session_path(session_id), payload)


def set_participant(
    session_id: str, role: str, info: dict[str, Any]
) -> None:
    set(session_path(session_id, "participants", role), info)


def write_file_echo(
    session_id: str, path: str, content: str, language: str = ""
) -> None:
    """Mirror a file edit into Firebase so Planner/Verifier subscribers see it.

    Uses the same key-escape scheme as the frontend (see useFirebaseSession).
    """
    key = _escape_path(path)
    update(
        session_path(session_id, "files", key),
        {"path": path, "content": content, "language": language, "readOnly": False},
    )


# ── Helpers ──────────────────────────────────────────────────────────────


def _escape_path(p: str) -> str:
    # Firebase keys can't contain .  / [ ] # $
    out = []
    for ch in p:
        if ch in "./[]#$":
            out.append("_")
        else:
            out.append(ch)
    return "".join(out)


def _genid() -> str:
    import random

    return "".join(random.choices("abcdefghijklmnopqrstuvwxyz0123456789", k=8))
