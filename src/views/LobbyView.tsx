import { useState } from 'react';
import { Role } from '../types';

interface LobbyViewProps {
  taskId: string;
  onJoin: (role: Role, name: string) => void;
}

const ROLES: { role: Role; label: string; color: string; description: string }[] = [
  {
    role: 'planner',
    label: 'Planner',
    color: '#6366f1',
    description: 'Reads the full specification and creates a detailed plan. Cannot edit code or run commands. Sends instructions to the Executor via chat.',
  },
  {
    role: 'executor',
    label: 'Executor',
    color: '#f59e0b',
    description: 'Reads a brief summary and the Planner\'s instructions. Can edit code and run commands. Does NOT see the full specification.',
  },
  {
    role: 'verifier',
    label: 'Verifier',
    color: '#10b981',
    description: 'Reads the full specification and reviews the Executor\'s work. Can pass or fail the submission with feedback.',
  },
];

export function LobbyView({ taskId, onJoin }: LobbyViewProps) {
  const [name, setName] = useState('');
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  return (
    <div style={{
      minHeight: '100vh', background: '#11111b', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: 700, width: '100%', padding: 32 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 40 }}>
          <h1 style={{ color: '#cdd6f4', fontSize: 32, fontWeight: 700, margin: 0 }}>
            TeamBench
          </h1>
          <p style={{ color: '#a6adc8', fontSize: 15, marginTop: 8 }}>
            Human Team Evaluation Platform
          </p>
          <div style={{
            display: 'inline-block', background: '#313244', color: '#89b4fa',
            padding: '4px 12px', borderRadius: 4, fontSize: 13, fontWeight: 600, marginTop: 12,
          }}>
            Task: {taskId}
          </div>
        </div>

        {/* Name input */}
        <div style={{ marginBottom: 24 }}>
          <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            Your Name
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Enter your name..."
            style={{
              width: '100%', padding: '10px 14px', background: '#1e1e2e', color: '#cdd6f4',
              border: '1px solid #555', borderRadius: 6, fontSize: 14, outline: 'none',
              boxSizing: 'border-box',
            }}
          />
        </div>

        {/* Role selection */}
        <div style={{ marginBottom: 32 }}>
          <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 12 }}>
            Select Your Role
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {ROLES.map(r => (
              <div
                key={r.role}
                onClick={() => setSelectedRole(r.role)}
                style={{
                  padding: 16, background: '#1e1e2e', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${selectedRole === r.role ? r.color : '#333'}`,
                  transition: 'border-color 0.15s',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                  <span style={{
                    background: r.color, color: r.role === 'planner' ? '#fff' : '#000',
                    padding: '2px 10px', borderRadius: 4, fontWeight: 700, fontSize: 12,
                  }}>
                    {r.label.toUpperCase()}
                  </span>
                </div>
                <p style={{ color: '#a6adc8', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                  {r.description}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* Join button */}
        <button
          onClick={() => selectedRole && name.trim() && onJoin(selectedRole, name.trim())}
          disabled={!selectedRole || !name.trim()}
          style={{
            width: '100%', padding: '12px 0',
            background: selectedRole ? ROLES.find(r => r.role === selectedRole)!.color : '#555',
            color: selectedRole === 'planner' ? '#fff' : '#000',
            border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15,
            cursor: selectedRole && name.trim() ? 'pointer' : 'not-allowed',
          }}
        >
          Join as {selectedRole ? ROLES.find(r => r.role === selectedRole)!.label : '...'}
        </button>

        {/* Info */}
        <p style={{ color: '#585b70', fontSize: 12, textAlign: 'center', marginTop: 16 }}>
          Each team member should open this page in a separate browser window and select their assigned role.
          In the demo, all roles share the same browser state.
        </p>
      </div>
    </div>
  );
}
