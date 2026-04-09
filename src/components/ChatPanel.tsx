import { useState, useRef, useEffect } from 'react';
import { Role, ChatMessage } from '../types';

interface ChatPanelProps {
  role: Role;
  messages: ChatMessage[];
  onSend: (to: Role | 'all', content: string) => void;
  disabled?: boolean;
}

const ROLE_COLORS: Record<Role, string> = {
  planner: '#6366f1',
  executor: '#f59e0b',
  verifier: '#10b981',
  oracle: '#cba6f7',
};

const ROLE_LABELS: Record<Role, string> = {
  planner: 'Planner',
  executor: 'Executor',
  verifier: 'Verifier',
  oracle: 'Oracle',
};

export function ChatPanel({ role, messages, onSend, disabled }: ChatPanelProps) {
  const [text, setText] = useState('');
  const [target, setTarget] = useState<Role | 'all'>('all');
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = () => {
    if (!text.trim() || disabled) return;
    onSend(target, text.trim());
    setText('');
  };

  const otherRoles = (['planner', 'executor', 'verifier'] as Role[]).filter(r => r !== role);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: '#1e1e2e', borderRadius: 8 }}>
      <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', fontWeight: 600, color: '#cdd6f4' }}>
        Chat
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {messages.map(msg => (
          <div key={msg.id} style={{
            alignSelf: msg.from === role ? 'flex-end' : 'flex-start',
            maxWidth: '80%',
          }}>
            <div style={{ fontSize: 11, color: '#888', marginBottom: 2 }}>
              <span style={{ color: ROLE_COLORS[msg.from], fontWeight: 600 }}>
                {ROLE_LABELS[msg.from]}
              </span>
              {msg.to !== 'all' && (
                <span> &rarr; <span style={{ color: ROLE_COLORS[msg.to as Role] }}>{ROLE_LABELS[msg.to as Role]}</span></span>
              )}
              <span style={{ marginLeft: 8 }}>{new Date(msg.timestamp).toLocaleTimeString()}</span>
            </div>
            <div style={{
              background: msg.from === role ? '#45475a' : '#313244',
              color: '#cdd6f4',
              padding: '8px 12px',
              borderRadius: 8,
              fontSize: 13,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}>
              {msg.content}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: 8, borderTop: '1px solid #333', display: 'flex', gap: 6 }}>
        <select
          value={target}
          onChange={e => setTarget(e.target.value as Role | 'all')}
          style={{ background: '#313244', color: '#cdd6f4', border: '1px solid #555', borderRadius: 4, padding: '4px 8px', fontSize: 12 }}
        >
          <option value="all">Everyone</option>
          {otherRoles.map(r => (
            <option key={r} value={r}>{ROLE_LABELS[r]}</option>
          ))}
        </select>
        <input
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleSend()}
          placeholder={disabled ? 'Chat disabled in this phase' : 'Type a message...'}
          disabled={disabled}
          style={{
            flex: 1, background: '#313244', color: '#cdd6f4', border: '1px solid #555',
            borderRadius: 4, padding: '6px 10px', fontSize: 13, outline: 'none',
          }}
        />
        <button
          onClick={handleSend}
          disabled={disabled || !text.trim()}
          style={{
            background: ROLE_COLORS[role], color: '#fff', border: 'none', borderRadius: 4,
            padding: '6px 14px', cursor: disabled ? 'not-allowed' : 'pointer', fontWeight: 600, fontSize: 13,
          }}
        >
          Send
        </button>
      </div>
    </div>
  );
}
