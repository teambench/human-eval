import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, TaskConfig } from '../types';
import { TASK_CATALOG } from '../data/taskCatalog';

interface LobbyViewProps {
  onJoin: (task: TaskConfig, role: Role, mode: SessionMode, name: string) => void;
  joining?: boolean;
  waitingForTeam?: boolean;
  waitingSessionId?: string | null;
  participants?: Record<string, { name: string; joinedAt: number }>;
}

const TEAM_ROLES: { role: Role; label: string; color: string; description: string }[] = [
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

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: '#a6e3a1',
  medium: '#f9e2af',
  hard: '#f38ba8',
  expert: '#cba6f7',
};

export function LobbyView({ onJoin, joining, waitingForTeam, waitingSessionId, participants }: LobbyViewProps) {
  const [name, setName] = useState('');
  const [selectedTask, setSelectedTask] = useState<TaskConfig | null>(null);
  const [mode, setMode] = useState<SessionMode>('team');
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);

  // Subscribe to Firebase waiting queue to show which roles are taken in real-time
  const [waitingRoles, setWaitingRoles] = useState<Record<string, boolean>>({});
  useEffect(() => {
    if (!selectedTask) return;
    const waitingRef = ref(db, `teambench/waiting/${selectedTask.taskId}`);
    const unsub = onValue(waitingRef, (snap) => {
      if (!snap.exists()) {
        setWaitingRoles({});
        return;
      }
      const data = snap.val() as Record<string, { roles: Record<string, boolean> }>;
      // Merge all waiting teams' roles to show what's available
      const taken: Record<string, boolean> = {};
      for (const team of Object.values(data)) {
        if (team.roles) {
          for (const [role, val] of Object.entries(team.roles)) {
            if (val) taken[role] = true;
          }
        }
      }
      setWaitingRoles(taken);
    });
    return () => unsub();
  }, [selectedTask]);

  // Waiting screen — shown after joining, waiting for teammates
  if (waitingForTeam && waitingSessionId) {
    return (
      <WaitingScreen
        taskId={selectedTask?.taskId || ''}
        sessionId={waitingSessionId}
        participants={participants || {}}
      />
    );
  }

  return (
    <div style={{
      minHeight: '100vh', background: '#11111b', display: 'flex', alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: 750, width: '100%', padding: 32 }}>
        {/* Header */}
        <div style={{ textAlign: 'center', marginBottom: 32 }}>
          <h1 style={{ color: '#cdd6f4', fontSize: 32, fontWeight: 700, margin: 0 }}>
            TeamBench
          </h1>
          <p style={{ color: '#a6adc8', fontSize: 15, marginTop: 8 }}>
            Human Team Evaluation Platform
          </p>
        </div>

        {/* Step 1: Name */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 6 }}>
            1. Your Name
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

        {/* Step 2: Task selection */}
        <div style={{ marginBottom: 20 }}>
          <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>
            2. Select a Task
          </label>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {TASK_CATALOG.map(task => (
              <div
                key={task.taskId}
                onClick={() => { setSelectedTask(task); setSelectedRole(null); }}
                style={{
                  padding: '12px 16px', background: '#1e1e2e', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${selectedTask?.taskId === task.taskId ? '#89b4fa' : '#333'}`,
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                }}
              >
                <div>
                  <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 14 }}>{task.taskId}</span>
                  <span style={{ color: '#a6adc8', fontSize: 13, marginLeft: 10 }}>{task.category}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <span style={{
                    fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                    color: '#000', background: DIFFICULTY_COLORS[task.difficulty] || '#888',
                  }}>
                    {task.difficulty.toUpperCase()}
                  </span>
                  <span style={{ color: '#585b70', fontSize: 12 }}>
                    {Math.floor(task.timeLimit / 60)}min
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Step 3: Mode selection */}
        {selectedTask && (
          <div style={{ marginBottom: 20 }}>
            <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>
              3. Select Mode
            </label>
            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => { setMode('team'); setSelectedRole(null); }}
                style={{
                  flex: 1, padding: '12px', background: '#1e1e2e', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${mode === 'team' ? '#89b4fa' : '#333'}`, textAlign: 'left',
                }}
              >
                <div style={{ color: '#cdd6f4', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  Team (3 people)
                </div>
                <div style={{ color: '#a6adc8', fontSize: 12 }}>
                  Planner + Executor + Verifier with role separation
                </div>
              </button>
              <button
                onClick={() => { setMode('oracle'); setSelectedRole('oracle'); }}
                style={{
                  flex: 1, padding: '12px', background: '#1e1e2e', borderRadius: 8, cursor: 'pointer',
                  border: `2px solid ${mode === 'oracle' ? '#cba6f7' : '#333'}`, textAlign: 'left',
                }}
              >
                <div style={{ color: '#cba6f7', fontWeight: 700, fontSize: 14, marginBottom: 4 }}>
                  Oracle (solo)
                </div>
                <div style={{ color: '#a6adc8', fontSize: 12 }}>
                  Full access: spec + code editing + verification
                </div>
              </button>
            </div>
          </div>
        )}

        {/* Step 4: Role selection (team mode only) */}
        {selectedTask && mode === 'team' && (
          <div style={{ marginBottom: 24 }}>
            <label style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, display: 'block', marginBottom: 8 }}>
              4. Select Your Role
            </label>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {TEAM_ROLES.map(r => {
                const taken = waitingRoles[r.role] === true;
                return (
                  <div
                    key={r.role}
                    onClick={() => !taken && setSelectedRole(r.role)}
                    style={{
                      padding: 14, background: '#1e1e2e', borderRadius: 8,
                      cursor: taken ? 'not-allowed' : 'pointer',
                      opacity: taken ? 0.5 : 1,
                      border: `2px solid ${selectedRole === r.role ? r.color : '#333'}`,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                      <span style={{
                        background: r.color, color: r.role === 'planner' ? '#fff' : '#000',
                        padding: '2px 10px', borderRadius: 4, fontWeight: 700, fontSize: 12,
                      }}>
                        {r.label.toUpperCase()}
                      </span>
                      {taken && (
                        <span style={{ fontSize: 11, color: '#f9e2af', fontWeight: 600 }}>
                          Teammate waiting — join to pair up!
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
        )}

        {/* Join button */}
        {selectedTask && selectedRole && (
          <button
            onClick={() => name.trim() && onJoin(selectedTask, selectedRole, mode, name.trim())}
            disabled={!name.trim() || joining}
            style={{
              width: '100%', padding: '12px 0',
              background: joining ? '#555'
                : mode === 'oracle' ? '#cba6f7'
                : TEAM_ROLES.find(r => r.role === selectedRole)?.color || '#89b4fa',
              color: selectedRole === 'planner' || mode === 'oracle' ? '#fff' : '#000',
              border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15,
              cursor: name.trim() && !joining ? 'pointer' : 'not-allowed',
            }}
          >
            {joining ? 'Joining...'
              : mode === 'oracle' ? `Start as Oracle — ${selectedTask.taskId}`
              : `Join as ${TEAM_ROLES.find(r => r.role === selectedRole)?.label} — ${selectedTask.taskId}`}
          </button>
        )}

        <p style={{ color: '#585b70', fontSize: 12, textAlign: 'center', marginTop: 16 }}>
          <strong>Team mode:</strong> 3 people each open this page and pick different roles. You are auto-matched and the session starts when all roles are filled.
          <br />
          <strong>Oracle mode:</strong> One person with full access (spec + editing + verification). Used as the single-agent baseline.
        </p>
      </div>
    </div>
  );
}

// ── Waiting Screen (subscribes to Firebase for real-time participant updates) ──
function WaitingScreen({ taskId, sessionId, participants: initialParticipants }: {
  taskId: string;
  sessionId: string;
  participants: Record<string, { name: string; joinedAt: number }>;
}) {
  const [participants, setParticipants] = useState(initialParticipants);

  useEffect(() => {
    const participantsRef = ref(db, `teambench/sessions/${sessionId}/participants`);
    const unsub = onValue(participantsRef, (snap) => {
      if (snap.exists()) setParticipants(snap.val());
    });
    return () => unsub();
  }, [sessionId]);

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
          Task: {taskId} &mdash; Session starts automatically when all 3 roles are filled.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 24 }}>
          {TEAM_ROLES.map(r => {
            const participant = participants[r.role];
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
          {Object.keys(participants).length}/3 teammates joined
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
