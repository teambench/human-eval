"""
TeamBench Human Eval — Backend Server

Provides:
1. WebSocket terminal proxy to Docker containers
2. Session/container lifecycle management
3. Grading endpoint using existing grade.sh scripts

Run: uvicorn server:app --host 0.0.0.0 --port 8443
"""

import asyncio
import json
import os
import shutil
import tempfile
import time
from pathlib import Path
from typing import Optional

import docker
from fastapi import FastAPI, WebSocket, WebSocketDisconnect, HTTPException
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
DOCKER_IMAGE = os.environ.get("DOCKER_IMAGE", "teambench-executor")
MAX_CONTAINERS = int(os.environ.get("MAX_CONTAINERS", "20"))
CONTAINER_TIMEOUT = int(os.environ.get("CONTAINER_TIMEOUT", "3600"))  # 1 hour

# Active sessions: sessionId -> container info
sessions: dict[str, dict] = {}
docker_client = docker.from_env()


def get_session(session_id: str) -> Optional[dict]:
    """Get session info, clean up expired sessions."""
    session = sessions.get(session_id)
    if session and time.time() - session["created_at"] > CONTAINER_TIMEOUT:
        cleanup_session(session_id)
        return None
    return session


def cleanup_session(session_id: str):
    """Stop and remove a session's container."""
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

    # Create a temporary workspace directory
    workspace_dir = tempfile.mkdtemp(prefix=f"tb_{session_id}_")
    ws_path = os.path.join(workspace_dir, "workspace")
    os.makedirs(ws_path, exist_ok=True)

    # Check if task has generated files (from generator or static)
    task_dir = Path(TEAMBENCH_ROOT) / "tasks" / task_id
    if task_dir.exists():
        static_workspace = task_dir / "workspace"
        if static_workspace.exists():
            shutil.copytree(static_workspace, ws_path, dirs_exist_ok=True)

    # Write files sent from the frontend (Monaco editor contents)
    for file_path, content in body.files.items():
        # Security: prevent path traversal
        safe_path = os.path.normpath(file_path).lstrip("/").lstrip("../")
        full_path = os.path.join(ws_path, safe_path)
        real_path = os.path.realpath(full_path)
        if not real_path.startswith(os.path.realpath(ws_path)):
            continue
        os.makedirs(os.path.dirname(full_path), exist_ok=True)
        with open(full_path, "w") as f:
            f.write(content)

    # Fix ownership: container runs as agent (uid 10001)
    os.system(f"chown -R 10001:10001 {ws_path}")

    try:
        container = docker_client.containers.run(
            DOCKER_IMAGE,
            command="sleep infinity",
            detach=True,
            name=f"tb-human-{session_id[:16]}",
            volumes={
                ws_path: {"bind": "/workspace", "mode": "rw"},
            },
            working_dir="/workspace",
            mem_limit="512m",
            cpu_period=100000,
            cpu_quota=50000,  # 0.5 CPU
            network_mode="bridge",
            remove=False,
        )
    except Exception as e:
        shutil.rmtree(workspace_dir, ignore_errors=True)
        raise HTTPException(500, f"Failed to create container: {e}")

    sessions[session_id] = {
        "container_id": container.id,
        "workspace_dir": workspace_dir,
        "task_id": task_id,
        "created_at": time.time(),
    }

    return {"status": "created", "session_id": session_id, "container_id": container.short_id}


@app.post("/api/session/{session_id}/write-file")
async def write_file(session_id: str, path: str, content: str):
    """Write a file to the session's workspace (called when executor edits in Monaco)."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    ws_path = os.path.join(session["workspace_dir"], "workspace")
    file_path = os.path.join(ws_path, path)

    # Security: prevent path traversal
    real_path = os.path.realpath(file_path)
    if not real_path.startswith(os.path.realpath(ws_path)):
        raise HTTPException(400, "Invalid path")

    os.makedirs(os.path.dirname(file_path), exist_ok=True)
    with open(file_path, "w") as f:
        f.write(content)

    return {"status": "ok"}


@app.post("/api/session/{session_id}/grade")
async def grade_session(session_id: str):
    """Run grade.sh for the session's task."""
    session = get_session(session_id)
    if not session:
        raise HTTPException(404, "Session not found")

    task_id = session["task_id"]
    task_dir = Path(TEAMBENCH_ROOT) / "tasks" / task_id
    grade_script = task_dir / "grade.sh"

    if not grade_script.exists():
        return {"status": "no_grader", "message": f"No grade.sh for {task_id}"}

    ws_path = os.path.join(session["workspace_dir"], "workspace")

    try:
        container = docker_client.containers.get(session["container_id"])
        # Copy grade.sh into container and run
        exec_result = container.exec_run(
            ["bash", "-c", f"cd /workspace && bash /tmp/grade.sh"],
            environment={
                "WORKSPACE": "/workspace",
                "TASK_DIR": str(task_dir),
            },
            workdir="/workspace",
        )
        output = exec_result.output.decode("utf-8", errors="replace")
        exit_code = exec_result.exit_code

        # Try to read score.json if grader wrote one
        score_path = os.path.join(ws_path, "score.json")
        score = None
        if os.path.exists(score_path):
            with open(score_path) as f:
                score = json.load(f)

        return {
            "status": "graded",
            "exit_code": exit_code,
            "output": output[-2000:],  # Last 2000 chars
            "score": score,
        }
    except Exception as e:
        return {"status": "error", "message": str(e)}


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
    # Get the raw socket
    raw_sock = sock._sock

    await websocket.send_json({"type": "output", "data": "Connected to sandbox terminal.\r\n"})

    async def read_from_container():
        """Read output from container and send to WebSocket."""
        loop = asyncio.get_event_loop()
        try:
            while True:
                data = await loop.run_in_executor(None, lambda: raw_sock.recv(4096))
                if not data:
                    break
                await websocket.send_json({"type": "output", "data": data.decode("utf-8", errors="replace")})
        except Exception:
            pass

    async def write_to_container():
        """Read input from WebSocket and send to container."""
        try:
            while True:
                msg = await websocket.receive_text()
                parsed = json.loads(msg)
                if parsed.get("type") == "input":
                    raw_sock.send(parsed["data"].encode("utf-8"))
                elif parsed.get("type") == "resize":
                    # Resize terminal
                    docker_client.api.exec_resize(
                        exec_instance["Id"],
                        height=parsed.get("rows", 24),
                        width=parsed.get("cols", 80),
                    )
        except WebSocketDisconnect:
            pass
        except Exception:
            pass

    # Run both directions concurrently
    reader = asyncio.create_task(read_from_container())
    writer = asyncio.create_task(write_to_container())

    try:
        await asyncio.gather(reader, writer, return_exceptions=True)
    finally:
        try:
            raw_sock.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass


@app.on_event("shutdown")
async def shutdown():
    """Clean up all containers on server shutdown."""
    for session_id in list(sessions.keys()):
        cleanup_session(session_id)


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8443)
