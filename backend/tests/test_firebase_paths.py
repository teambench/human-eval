"""Path-builder unit tests. No network calls."""
from __future__ import annotations

import sys
import pathlib

# Allow `import firebase_rest` from the backend dir without packaging.
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

import firebase_rest as fb  # noqa: E402


def test_task_session_path():
    assert fb.task_session_path("API1", "team", "API1_team_a3f9") == \
        "teambench_new/tasks/API1/team/sessions/API1_team_a3f9"


def test_task_session_path_with_subparts():
    assert fb.task_session_path("API1", "team", "sid", "meta", "phase") == \
        "teambench_new/tasks/API1/team/sessions/sid/meta/phase"


def test_task_session_path_oracle_stays_oracle():
    # Frontend keeps SessionMode='oracle'; we do NOT rename to 'solo' in paths
    # so the live legacy path and the new tree share the same mode literal.
    assert fb.task_session_path("API1", "oracle", "sid") == \
        "teambench_new/tasks/API1/oracle/sessions/sid"


def test_task_session_path_hybrid():
    assert fb.task_session_path("API1", "hybrid", "sid") == \
        "teambench_new/tasks/API1/hybrid/sessions/sid"


def test_shared_artifacts_path():
    assert fb.shared_artifacts_path("API1", "hybrid", "sid", "messages") == \
        "teambench_new/tasks/API1/hybrid/sessions/sid/sharedArtifacts/messages"


def test_shared_ai_turns_path():
    assert fb.shared_artifacts_path("API1", "hybrid", "sid", "aiTurns") == \
        "teambench_new/tasks/API1/hybrid/sessions/sid/sharedArtifacts/aiTurns"


def test_participant_interactions_path():
    assert fb.participant_interactions_path("API1", "team", "sid", "pid12") == \
        "teambench_new/tasks/API1/team/sessions/sid/participants/pid12/interactions"


def test_participants_index_session_path():
    assert fb.participants_index_session_path("pid12", "sid") == \
        "teambench_new/participants/pid12/sessions/sid"


def test_meta_path():
    assert fb.meta_path("API1", "team", "sid") == \
        "teambench_new/tasks/API1/team/sessions/sid/meta"


def test_legacy_session_path_unchanged():
    # Backwards-compat: legacy helpers still produce the old paths so
    # existing live-UI consumers don't break.
    assert fb.session_path("sid", "messages") == \
        "teambench/sessions/sid/messages"
