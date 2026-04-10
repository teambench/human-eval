import { useEffect, useRef, useState } from 'react';

// Backend URL — Cloudflare tunnel provides HTTPS/WSS for free
const TUNNEL_HOST = import.meta.env.VITE_BACKEND_HOST || 'xhtml-thanksgiving-gourmet-requires.trycloudflare.com';
const BACKEND_URL = `wss://${TUNNEL_HOST}`;
const API_URL = `https://${TUNNEL_HOST}`;

interface TerminalProps {
  sessionId?: string;
  disabled?: boolean;
  onCommand?: (cmd: string) => void;
}

export function Terminal({ sessionId, disabled, onCommand }: TerminalProps) {
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const xtermRef = useRef<any>(null);
  const [status, setStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'no-session'>('no-session');
  const [fallback, setFallback] = useState(false);

  useEffect(() => {
    if (!sessionId || disabled || !termRef.current) return;

    let cancelled = false;

    async function init() {
      // Dynamically import xterm (keeps bundle smaller if terminal not used)
      const { Terminal: XTerm } = await import('@xterm/xterm');
      const { FitAddon } = await import('@xterm/addon-fit');

      // Import xterm CSS
      await import('@xterm/xterm/css/xterm.css');

      if (cancelled || !termRef.current) return;

      // Create terminal
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
      xtermRef.current = term;

      // Resize handler
      const resizeObserver = new ResizeObserver(() => fitAddon.fit());
      resizeObserver.observe(termRef.current);

      // Try to create container session via API
      setStatus('connecting');
      try {
        const resp = await fetch(`${API_URL}/api/session/${sessionId}/create?task_id=DEMO_api_fix`, {
          method: 'POST',
        });

        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

        // Connect WebSocket
        const ws = new WebSocket(`${BACKEND_URL}/ws/terminal/${sessionId}`);
        wsRef.current = ws;

        ws.onopen = () => {
          if (!cancelled) {
            setStatus('connected');
            // Send initial resize
            ws.send(JSON.stringify({
              type: 'resize',
              rows: term.rows,
              cols: term.cols,
            }));
          }
        };

        ws.onmessage = (event) => {
          const msg = JSON.parse(event.data);
          if (msg.type === 'output') {
            term.write(msg.data);
          }
        };

        ws.onclose = () => {
          if (!cancelled) {
            setStatus('disconnected');
            term.write('\r\n\x1b[31m[Terminal disconnected]\x1b[0m\r\n');
          }
        };

        ws.onerror = () => {
          if (!cancelled) {
            setStatus('disconnected');
            setFallback(true);
          }
        };

        // Send terminal input to WebSocket
        term.onData((data: string) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'input', data }));
          }
        });

        // Handle terminal resize
        term.onResize(({ rows, cols }: { rows: number; cols: number }) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'resize', rows, cols }));
          }
        });

      } catch (err) {
        console.warn('Backend not available, using fallback terminal:', err);
        setFallback(true);
        setStatus('disconnected');
        term.write('Backend server not running. Using local-only mode.\r\n');
        term.write('Commands are logged but not executed.\r\n');
        term.write('To enable real execution, start the backend:\r\n');
        term.write('  cd backend && ./start.sh\r\n\r\n');

        // Fallback: simple echo terminal
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
            // Backspace
            if (line.length > 0) {
              line = line.slice(0, -1);
              term.write('\b \b');
            }
          } else {
            line += data;
            term.write(data);
          }
        });
        term.write('$ ');
      }

      return () => {
        cancelled = true;
        resizeObserver.disconnect();
        wsRef.current?.close();
        term.dispose();
      };
    }

    const cleanup = init();
    return () => {
      cancelled = true;
      cleanup.then(fn => fn?.());
    };
  }, [sessionId, disabled]);

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
          {status === 'connected' ? 'Connected to sandbox'
            : status === 'connecting' ? 'Connecting...'
            : fallback ? 'Local mode (backend not running)'
            : 'Disconnected'}
        </span>
      </div>
      <div ref={termRef} style={{ flex: 1 }} />
    </div>
  );
}
