import { useEffect, useRef, useState } from 'react';

// Backend URL — Cloudflare tunnel provides HTTPS/WSS for free
const TUNNEL_HOST = import.meta.env.VITE_BACKEND_HOST || 'gif-won-insertion-texture.trycloudflare.com';
const BACKEND_URL = `wss://${TUNNEL_HOST}`;
const API_URL = `https://${TUNNEL_HOST}`;

interface TerminalProps {
  sessionId?: string;
  taskId?: string;
  files?: { path: string; content: string }[];
  disabled?: boolean;
  onCommand?: (cmd: string) => void;
}

export function Terminal({ sessionId, taskId, files: initialFiles, disabled, onCommand }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'no-session'>('no-session');
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!sessionId || disabled || !termRef.current) return;

    let cancelled = false;
    let cleanupFn: (() => void) | undefined;

    async function init() {
      const { Terminal: XTerm } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');
      await import('@xterm/xterm/css/xterm.css');

      if (cancelled || !termRef.current) return;

      const term = new XTerm({
        cursorBlink: true,
        fontSize: 13,
        fontFamily: 'ui-monospace, Consolas, monospace',
        theme: {
          background: '#11111b',
          foreground: '#cdd6f4',
          cursor: '#89b4fa',
          selectionBackground: '#45475a',
        },
        rows: 12,
      });

      const fitAddon = new FitAddon();
      term.loadAddon(fitAddon);
      term.open(termRef.current);
      fitAddon.fit();

      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(termRef.current!);

      // Try connecting to real backend
      setStatus('connecting');
      term.write('Connecting to sandbox...\r\n');

      try {
        // Send frontend-provided files only for the hardcoded DEMO task.
        // For all other tasks, the backend stages files from generators; sending
        // DEMO overlays would pollute the real workspace with src/server.py etc.
        const fileMap: Record<string, string> = {};
        if (taskId === 'DEMO_api_fix' && initialFiles) {
          for (const f of initialFiles) fileMap[f.path] = f.content;
        }
        const resp = await fetch(
          `${API_URL}/api/session/${sessionId}/create?task_id=${encodeURIComponent(taskId || 'DEMO_api_fix')}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: fileMap }),
          }
        );
        if (!resp.ok) {
          // Surface 503 explicitly so the participant knows to retry, not
          // that the platform is broken. Other 5xx surface generically.
          throw new Error(
            resp.status === 503
              ? `Backend is at capacity (${resp.status}). Please wait a minute and refresh.`
              : `HTTP ${resp.status}`
          );
        }

        const ws = new WebSocket(`${BACKEND_URL}/ws/terminal/${sessionId}`);
        wsRef.current = ws;

        let pingInterval: ReturnType<typeof setInterval> | null = null;
        let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
        let reconnectAttempts = 0;
        const MAX_RECONNECT = 10;

        const connectWs = () => {
          const ws = new WebSocket(`${BACKEND_URL}/ws/terminal/${sessionId}`);
          wsRef.current = ws;

          ws.onopen = () => {
            if (cancelled) return;
            setStatus('connected');
            reconnectAttempts = 0;
            if (reconnectAttempts === 0) term.clear();
            ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
            // Keepalive: ping every 30s to prevent Cloudflare idle timeout
            pingInterval = setInterval(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ping' }));
              }
            }, 30000);
          };

          ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'output') term.write(msg.data);
          };

          ws.onclose = () => {
            if (pingInterval) clearInterval(pingInterval);
            if (!cancelled && reconnectAttempts < MAX_RECONNECT) {
              setStatus('connecting');
              term.write('\r\n\x1b[33m[Reconnecting...]\x1b[0m\r\n');
              reconnectAttempts++;
              reconnectTimeout = setTimeout(connectWs, Math.min(1000 * reconnectAttempts, 5000));
            } else if (!cancelled) {
              setStatus('disconnected');
              term.write('\r\n\x1b[31m[Disconnected — reload page to reconnect]\x1b[0m\r\n');
            }
          };

          ws.onerror = () => { /* onclose will fire next */ };

          term.onData((data: string) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
          });
          term.onResize(({ rows, cols }: { rows: number; cols: number }) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', rows, cols }));
          });

          cleanupFn = () => {
            if (pingInterval) clearInterval(pingInterval);
            if (reconnectTimeout) clearTimeout(reconnectTimeout);
            resizeObserver.disconnect();
            ws.close();
            term.dispose();
          };
        };

        connectWs();

        term.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
        });
        term.onResize(({ rows, cols }: { rows: number; cols: number }) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', rows, cols }));
        });

      } catch (err) {
        // Fallback: local echo terminal. Surface the specific error so the
        // participant can tell whether to refresh (503 / capacity) or
        // report (backend down).
        setFallback(true);
        setStatus('disconnected');
        term.clear();
        const msg = err instanceof Error ? err.message : 'Backend unreachable';
        term.write(`\x1b[33m${msg}\x1b[0m\r\n`);
        term.write('Local mode — commands are logged only, no real execution.\r\n\r\n');
        term.write('$ ');

        let line = '';
        term.onData((data: string) => {
          if (data === '\r') {
            term.write('\r\n');
            if (line.trim()) {
              onCommand?.(line.trim());
              term.write(`\x1b[33m[logged] ${line.trim()}\x1b[0m\r\n`);
            }
            line = '';
            term.write('$ ');
          } else if (data === '\x7f') {
            if (line.length > 0) { line = line.slice(0, -1); term.write('\b \b'); }
          } else {
            line += data;
            term.write(data);
          }
        });
      }
    }

    init();
    return () => { cancelled = true; cleanupFn?.(); };
  }, [sessionId, taskId, disabled]);

  if (disabled) {
    return (
      <div style={{
        background: '#11111b', color: '#585b70', fontFamily: 'monospace', fontSize: 12,
        height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        Terminal not available for this role
      </div>
    );
  }

  return (
    <div style={{ height: '100%', display: 'flex', flexDirection: 'column', background: '#11111b' }}>
      <div style={{
        padding: '4px 12px', background: '#181825', fontSize: 11, color: '#585b70',
        borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      }}>
        <span>Terminal</span>
        <span style={{
          fontSize: 10, fontWeight: 600,
          color: status === 'connected' ? '#a6e3a1' : status === 'connecting' ? '#f9e2af' : '#f38ba8',
        }}>
          {status === 'connected' ? 'Connected'
            : status === 'connecting' ? 'Connecting...'
            : fallback ? 'Local mode'
            : 'Disconnected'}
        </span>
      </div>
      <div ref={termRef} style={{ flex: 1 }} />
    </div>
  );
}

// Grading API — call from views when submitting. Graders can take up to ~2 min
// (Go compile + race detector on CROSS1/GO1 hit ~90-120s), so allow generous
// timeout instead of the browser default (which is indefinite on slow networks).
export async function gradeSession(sessionId: string): Promise<{
  status: string; exit_code?: number; output?: string; score?: any;
}> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 180_000); // 3 minutes
  try {
    const resp = await fetch(`${API_URL}/api/session/${sessionId}/grade`, {
      method: 'POST',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) {
      return { status: 'error', output: `Grader returned HTTP ${resp.status}. Try again.` };
    }
    return await resp.json();
  } catch (err) {
    clearTimeout(timeout);
    const msg = err instanceof Error && err.name === 'AbortError'
      ? 'Grader timed out after 3 minutes. Your code may still be correct — try again.'
      : 'Backend not reachable. Check your network and retry.';
    return { status: 'error', output: msg };
  }
}

// Attempt best-effort session cleanup when the tab closes. Uses sendBeacon
// (works during page unload where fetch() is unreliable). This frees the
// container slot — without it, orphan sessions linger up to CONTAINER_TIMEOUT
// (1 hour) and can exhaust MAX_CONTAINERS=20 during the study.
export function registerSessionCleanup(sessionId: string) {
  if (typeof window === 'undefined' || !sessionId) return () => {};
  const handler = () => {
    try {
      // fetch with keepalive: true survives page unload in modern browsers.
      // sendBeacon only supports POST, so we use fetch+keepalive for DELETE.
      fetch(`${API_URL}/api/session/${sessionId}`, {
        method: 'DELETE', keepalive: true,
      }).catch(() => {});
    } catch { /* best-effort */ }
  };
  window.addEventListener('beforeunload', handler);
  window.addEventListener('pagehide', handler);
  return () => {
    window.removeEventListener('beforeunload', handler);
    window.removeEventListener('pagehide', handler);
  };
}
