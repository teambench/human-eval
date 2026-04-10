#!/bin/bash
# Start the TeamBench Human Eval backend server
# Usage: ./start.sh [port]

PORT=${1:-8443}
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "=== TeamBench Human Eval Backend ==="
echo "Server: http://0.0.0.0:${PORT}"
echo "WebSocket: ws://0.0.0.0:${PORT}/ws/terminal/{sessionId}"
echo "Docker image: teambench-executor"
echo ""

# Install deps if needed
if [ ! -d "${SCRIPT_DIR}/venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "${SCRIPT_DIR}/venv"
    "${SCRIPT_DIR}/venv/bin/pip" install -r "${SCRIPT_DIR}/requirements.txt"
fi

# Activate and run
source "${SCRIPT_DIR}/venv/bin/pip" 2>/dev/null
exec "${SCRIPT_DIR}/venv/bin/uvicorn" server:app \
    --host 0.0.0.0 \
    --port "${PORT}" \
    --app-dir "${SCRIPT_DIR}" \
    --log-level info
