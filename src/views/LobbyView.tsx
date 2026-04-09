import { useState } from 'react';
import { Role } from '../types';

interface LobbyViewProps {
  taskId: string;
  onJoin: (role: Role, name: string) => void;
  joining?: boolean;
  waitingForTeam?: boolean;
  participants?: Record<string, { name: string; joinedAt: number }>;
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

export function LobbyView({ taskId, onJoin, joining, waitingForTeam, participants }: LobbyViewProps) {
  const [name, setName] = useState('');
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  const takenRoles = new Set(Object.keys(participants || {}));

  // Waiting screen
  if (waitingForTeam) {
    const filledRoles = Object.entries(participants || {});
    return (
      <div style={{
        minHeight: '100vh', background: '#11111b', display: 'flex',
        alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{ maxWidth: 500, width: '100%', padding: 32, textAlign: 'center' }}>
          <h1 style={{ color: '#cdd6f4', fontSize: 28, fontWeight: 700, margin: '0 0 8px' }}>
            Waiting for teammates...
          </h1>
          <p style={{ color: '#a6adc8', fontSize: 14, marginBottom: 32 }}>
            Task: {taskId} &mdash; The session will start automatically when all 3 roles are filled.
          </p>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
            {ROLES.map(r => {
              const participant = (participants || {})[r.role];
              const isFilled = !!participant;
              return (
                <div key={r.role} style={{
                  padding: '12px 16px', background: '#1e1e2e', borderRadius: 8,
                  border: `2px solid ${isFilled ? r.color : '#333'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      background: isFilled ? r.color : '#313244',
                      color: isFilled ? (r.role === 'planner' ? '#fff' : '#000') : '#888',
                      padding: '2px 10px', borderRadius: 4, fontWeight: 700, fontSize: 12,
                    }}>
                      {r.label.toUpperCase()}
                    </span>
                    {isFilled && (
                      <span style={{ color: '#cdd6f4', fontSize: 14 }}>{participant.name}</span>
                    )}
                  </div>
                  <span style={{
                    fontSize: 12, fontWeight: 600,
                    color: isFilled ? '#a6e3a1' : '#f9e2af',
                  }}>
                    {isFilled ? 'Joined' : 'Waiting...'}
                  </span>
                </div>
              );
            })}
          </div>

          <div style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            color: '#f9e2af', fontSize: 13,
          }}>
            <span style={{
              display: 'inline-block', width: 8, height: 8, borderRadius: '50%',
              background: '#f9e2af', animation: 'pulse 1.5s infinite',
            }} />
            {filledRoles.length}/3 teammates joined
          </div>

          <style>{`
            @keyframes pulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.3; }
            }
          `}</style>
        </div>
      </div>
    );
  }

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
            {ROLES.map(r => {
              const taken = takenRoles.has(r.role);
              return (
                <div
                  key={r.role}
                  onClick={() => !taken && setSelectedRole(r.role)}
                  style={{
                    padding: 16, background: '#1e1e2e', borderRadius: 8,
                    cursor: taken ? 'not-allowed' : 'pointer',
                    opacity: taken ? 0.5 : 1,
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
                    {taken && (
                      <span style={{ fontSize: 11, color: '#f38ba8', fontWeight: 600 }}>
                        Already taken
                      </span>
                    )}
                  </div>
                  <p style={{ color: '#a6adc8', fontSize: 13, margin: 0, lineHeight: 1.5 }}>
                    {r.description}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Join button */}
        <button
          onClick={() => selectedRole && name.trim() && onJoin(selectedRole, name.trim())}
          disabled={!selectedRole || !name.trim() || joining}
          style={{
            width: '100%', padding: '12px 0',
            background: selectedRole && !joining ? ROLES.find(r => r.role === selectedRole)!.color : '#555',
            color: selectedRole === 'planner' ? '#fff' : '#000',
            border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15,
            cursor: selectedRole && name.trim() && !joining ? 'pointer' : 'not-allowed',
          }}
        >
          {joining ? 'Joining...' : `Join as ${selectedRole ? ROLES.find(r => r.role === selectedRole)!.label : '...'}`}
        </button>

        {/* Info */}
        <p style={{ color: '#585b70', fontSize: 12, textAlign: 'center', marginTop: 16 }}>
          Each team member opens this page in their own browser.
          You will be automatically matched with teammates who select different roles.
          Sessions can be resumed if you disconnect.
        </p>
      </div>
    </div>
  );
}
