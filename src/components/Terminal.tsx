import { useEffect, useRef, useState } from 'react';

// Backend URL — Cloudflare tunnel provides HTTPS/WSS for free
const TUNNEL_HOST = import.meta.env.VITE_BACKEND_HOST || 'abilities-sparc-mediterranean-resource.trycloudflare.com';
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

      cleanupFn = () => {
        resizeObserver.disconnect();
        wsRef.current?.close();
        term.dispose();
      };

      // Try connecting to real backend
      setStatus('connecting');
      term.write('Connecting to sandbox...\r\n');

      try {
        // Send files to backend so they appear in the Docker workspace
        const fileMap: Record<string, string> = {};
        if (initialFiles) {
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
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        const ws = new WebSocket(`${BACKEND_URL}/ws/terminal/${sessionId}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (cancelled) return;
          setStatus('connected');
          term.clear();
          ws.send(JSON.stringify({ type: 'resize', rows: term.rows, cols: term.cols }));
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') term.write(msg.data);
        };

        ws.onclose = () => {
          if (!cancelled) {
            setStatus('disconnected');
            term.write('\r\n\x1b[31m[Disconnected]\x1b[0m\r\n');
          }
        };

        ws.onerror = () => { if (!cancelled) { setFallback(true); setStatus('disconnected'); } };

        term.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data }));
        });
        term.onResize(({ rows, cols }: { rows: number; cols: number }) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', rows, cols }));
        });

      } catch {
        // Fallback: local echo terminal
        setFallback(true);
        setStatus('disconnected');
        term.clear();
        term.write('\x1b[33mSandbox unavailable — using local mode.\x1b[0m\r\n');
        term.write('Commands are logged. Start backend for real execution.\r\n\r\n');
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

// Grading API — call from views when submitting
export async function gradeSession(sessionId: string): Promise<{
  status: string; exit_code?: number; output?: string; score?: any;
}> {
  try {
    const resp = await fetch(`${API_URL}/api/session/${sessionId}/grade`, { method: 'POST' });
    return await resp.json();
  } catch {
    return { status: 'error', output: 'Backend not available' };
  }
}
