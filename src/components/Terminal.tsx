import { useState, useRef, useEffect } from 'react';
import { TerminalLine } from '../types';

interface TerminalProps {
  disabled?: boolean;
  onCommand: (cmd: string) => void;
}

// Simulated terminal — in production this connects to backend via WebSocket
export function Terminal({ disabled, onCommand }: TerminalProps) {
  const [lines, setLines] = useState<TerminalLine[]>([
    { id: 0, type: 'output', content: 'TeamBench Sandbox Terminal (demo mode)', timestamp: Date.now() },
    { id: 1, type: 'output', content: 'Commands are logged but not executed in this demo.', timestamp: Date.now() },
    { id: 2, type: 'output', content: 'Connect a backend server for real execution.\n', timestamp: Date.now() },
  ]);
  const [input, setInput] = useState('');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [lines]);

  const handleSubmit = () => {
    if (!input.trim() || disabled) return;
    const cmd = input.trim();
    setLines(prev => [
      ...prev,
      { id: Date.now(), type: 'input', content: `$ ${cmd}`, timestamp: Date.now() },
      { id: Date.now() + 1, type: 'output', content: `[demo] Command logged: ${cmd}`, timestamp: Date.now() },
    ]);
    onCommand(cmd);
    setInput('');
  };

  return (
    <div style={{
      background: '#11111b', color: '#a6adc8', fontFamily: 'monospace', fontSize: 12,
      height: '100%', display: 'flex', flexDirection: 'column', borderRadius: 8, overflow: 'hidden',
    }}>
      <div style={{ padding: '6px 12px', background: '#181825', fontSize: 11, color: '#888', borderBottom: '1px solid #333' }}>
        Terminal {disabled && '(read-only)'}
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 8 }}>
        {lines.map(line => (
          <div key={line.id} style={{
            color: line.type === 'input' ? '#89b4fa' : line.type === 'error' ? '#f38ba8' : '#a6adc8',
            whiteSpace: 'pre-wrap', lineHeight: 1.5,
          }}>
            {line.content}
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      {!disabled && (
        <div style={{ display: 'flex', borderTop: '1px solid #333', background: '#181825' }}>
          <span style={{ padding: '6px 8px', color: '#89b4fa' }}>$</span>
          <input
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleSubmit()}
            style={{
              flex: 1, background: 'transparent', border: 'none', color: '#cdd6f4',
              fontFamily: 'monospace', fontSize: 12, padding: '6px 0', outline: 'none',
            }}
            placeholder="Type a command..."
          />
        </div>
      )}
    </div>
  );
}
