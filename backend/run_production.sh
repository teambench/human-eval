#!/bin/bash
# ============================================
# TeamBench Human Eval — Production Launcher
# ============================================
# Creates a tmux session with backend + Cloudflare tunnel.
#
# USAGE:
#   ./run_production.sh          # Start everything
#   ./run_production.sh stop     # Stop everything
#   ./run_production.sh status   # Check if running
#   ./run_production.sh restart  # Restart everything
#   ./run_production.sh logs     # Attach to tmux to see logs
#
# AFTER RESTART / REBOOT:
#   cd /tmp/human-eval/backend && ./run_production.sh
#
# The tmux session has 2 windows:
#   [0] backend  — FastAPI server on port 8443
#   [1] tunnel   — Cloudflare tunnel (prints the public URL)
#
# To see the tunnel URL:
#   tmux attach -t teambench
#   Then Ctrl+B, 1  (switch to tunnel window)
#   The URL looks like: https://xxxx-xxxx-xxxx.trycloudflare.com
#
# IMPORTANT: After getting a new tunnel URL, update it in:
#   src/components/Terminal.tsx → TUNNEL_HOST variable
#   Then: cd /tmp/human-eval && npm run build && git add -A && git commit && git push
# ============================================

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SESSION="teambench"
PORT=8443
CLOUDFLARED="/tmp/cloudflared"

# Ensure cloudflared exists
if [ ! -f "$CLOUDFLARED" ]; then
    echo "Downloading cloudflared..."
    curl -sL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o "$CLOUDFLARED"
    chmod +x "$CLOUDFLARED"
fi

# Ensure venv exists
if [ ! -d "${SCRIPT_DIR}/venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv "${SCRIPT_DIR}/venv"
    "${SCRIPT_DIR}/venv/bin/pip" install -q -r "${SCRIPT_DIR}/requirements.txt"
fi

case "${1:-start}" in
    start)
        # Check if already running
        if tmux has-session -t "$SESSION" 2>/dev/null; then
            echo "Session '$SESSION' already running."
            echo "Use: ./run_production.sh logs   (to view)"
            echo "     ./run_production.sh restart (to restart)"
            exit 0
        fi

        echo "Starting TeamBench Human Eval..."

        # Create tmux session with backend
        tmux new-session -d -s "$SESSION" -n "backend" \
            "cd ${SCRIPT_DIR} && ${SCRIPT_DIR}/venv/bin/uvicorn server:app --host 0.0.0.0 --port ${PORT} --log-level info; read"

        # Add tunnel window
        tmux new-window -t "$SESSION" -n "tunnel" \
            "${CLOUDFLARED} tunnel --url http://localhost:${PORT}; read"

        echo ""
        echo "=== TeamBench Human Eval Started ==="
        echo ""
        echo "tmux session: $SESSION"
        echo "  Window 0: backend (port $PORT)"
        echo "  Window 1: tunnel  (Cloudflare)"
        echo ""
        echo "To see the tunnel URL:"
        echo "  tmux attach -t $SESSION"
        echo "  Then press Ctrl+B, 1"
        echo ""
        echo "The public URL will appear as:"
        echo "  https://xxxx-xxxx-xxxx.trycloudflare.com"
        echo ""
        echo "Update src/components/Terminal.tsx with the new URL,"
        echo "then rebuild and push."
        echo ""
        ;;

    stop)
        echo "Stopping TeamBench Human Eval..."
        tmux kill-session -t "$SESSION" 2>/dev/null
        # Clean up any orphan Docker containers
        docker ps -q --filter "name=tb-human-" | xargs -r docker rm -f 2>/dev/null
        echo "Stopped."
        ;;

    restart)
        "$0" stop
        sleep 1
        "$0" start
        ;;

    status)
        if tmux has-session -t "$SESSION" 2>/dev/null; then
            echo "=== TeamBench Human Eval: RUNNING ==="
            tmux list-windows -t "$SESSION"
            echo ""
            echo "Active Docker containers:"
            docker ps --filter "name=tb-human-" --format "  {{.Names}} ({{.Status}})"
            echo ""
            echo "Backend API:"
            curl -s "http://localhost:${PORT}/api/sessions" 2>/dev/null | python3 -m json.tool 2>/dev/null || echo "  Not responding"
        else
            echo "=== TeamBench Human Eval: STOPPED ==="
            echo "Run: ./run_production.sh start"
        fi
        ;;

    logs)
        if tmux has-session -t "$SESSION" 2>/dev/null; then
            echo "Attaching to tmux session. Use Ctrl+B, D to detach."
            echo "  Ctrl+B, 0 = backend logs"
            echo "  Ctrl+B, 1 = tunnel logs (shows public URL)"
            tmux attach -t "$SESSION"
        else
            echo "Not running. Start with: ./run_production.sh start"
        fi
        ;;

    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
