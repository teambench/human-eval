import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, TaskConfig } from '../types';
import { TASK_CATALOG, TaskEntry, DEMO_TASK } from '../data/taskCatalog';

// ── Types ──
export interface UserProfile {
  name: string;
  email: string;
  institution: string;
  expertise: string;
  yearsExp: string;
}

interface LobbyViewProps {
  onJoin: (task: TaskConfig, role: Role, mode: SessionMode, name: string, profile: UserProfile) => void;
  joining?: boolean;
  waitingForTeam?: boolean;
  waitingSessionId?: string | null;
  participants?: Record<string, { name: string; joinedAt: number }>;
}

type Step = 'profile' | 'task' | 'mode' | 'waiting';

const DIFFICULTY_COLORS: Record<string, string> = {
  easy: '#a6e3a1', medium: '#f9e2af', hard: '#f38ba8', expert: '#cba6f7',
};

const EXPERTISE_OPTIONS = [
  'Software Engineering',
  'Machine Learning / AI',
  'Data Science',
  'Security / Cryptography',
  'Systems / Infrastructure',
  'Full-Stack Development',
  'Other',
];

const TEAM_ROLES: { role: Role; label: string; color: string; icon: string; short: string }[] = [
  { role: 'planner', label: 'Planner', color: '#6366f1', icon: '\u{1F4CB}', short: 'Read spec, create plan, guide the team' },
  { role: 'executor', label: 'Executor', color: '#f59e0b', icon: '\u{1F4BB}', short: 'Write code, run commands, implement fixes' },
  { role: 'verifier', label: 'Verifier', color: '#10b981', icon: '\u{1F50D}', short: 'Review work against spec, pass or fail' },
];

// ── Main Component ──
const PROFILE_KEY = 'teambench_profile_v1';

function loadPersistedProfile(): UserProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      // Minimal shape guard; fill missing fields with ''.
      return {
        name: p.name ?? '', email: p.email ?? '',
        institution: p.institution ?? '', expertise: p.expertise ?? '',
        yearsExp: p.yearsExp ?? '',
      };
    }
  } catch { /* ignore */ }
  return { name: '', email: '', institution: '', expertise: '', yearsExp: '' };
}

export function LobbyView({ onJoin, joining, waitingForTeam, waitingSessionId, participants }: LobbyViewProps) {
  const persistedProfile = loadPersistedProfile();
  const profileAlreadyValid =
    persistedProfile.name.trim() && persistedProfile.email.trim() && persistedProfile.expertise;
  // If we landed here after a completed task (?start_task=1) and have a saved
  // profile, skip the Profile step so the user doesn't have to retype.
  const initialStep: Step =
    profileAlreadyValid ? 'task' : 'profile';
  const [step, setStep] = useState<Step>(initialStep);
  const [profile, setProfile] = useState<UserProfile>(persistedProfile);
  const [selectedTask, setSelectedTask] = useState<TaskEntry | null>(null);
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [waitingRoles, setWaitingRoles] = useState<Record<string, boolean>>({});

  // Subscribe to waiting queue for selected task
  useEffect(() => {
    if (!selectedTask || mode !== 'team') return;
    const waitingRef = ref(db, `teambench/waiting/${selectedTask.taskId}`);
    const unsub = onValue(waitingRef, (snap) => {
      if (!snap.exists()) { setWaitingRoles({}); return; }
      const data = snap.val() as Record<string, { roles: Record<string, boolean> }>;
      const taken: Record<string, boolean> = {};
      for (const team of Object.values(data)) {
        if (team.roles) for (const [r, v] of Object.entries(team.roles)) if (v) taken[r] = true;
      }
      setWaitingRoles(taken);
    });
    return () => unsub();
  }, [selectedTask, mode]);

  // Switch to waiting when Firebase says so
  useEffect(() => {
    if (waitingForTeam) setStep('waiting');
  }, [waitingForTeam]);

  const profileValid = profile.name.trim() && profile.email.trim() && profile.expertise;

  const handleJoin = () => {
    if (!selectedTask || !selectedRole || !profileValid) return;
    // Use DEMO_TASK only for the demo; all other tasks start empty and load
    // files from the backend after session creation (generator-staged).
    const isDemo = selectedTask.taskId === 'DEMO_api_fix';
    const taskConfig: TaskConfig = isDemo
      ? { ...DEMO_TASK }
      : {
          taskId: selectedTask.taskId,
          category: selectedTask.category,
          difficulty: selectedTask.difficulty,
          timeLimit: 1800,
          specMd: `# ${selectedTask.taskId}\n\nRead \`brief.md\` in the workspace terminal for the full task description.`,
          briefMd: `# ${selectedTask.taskId}\n\nLoading task from backend... See \`brief.md\` in /workspace.`,
          files: [],
        };
    onJoin(taskConfig, selectedRole, mode || 'team', profile.name.trim(), profile);
  };

  // ── Step: Waiting Room ──
  if (step === 'waiting' && waitingSessionId) {
    return <WaitingRoom
      sessionId={waitingSessionId}
      participants={participants || {}}
      taskId={selectedTask?.taskId || ''}
      onCancel={() => {
        // Clean up localStorage + Firebase waiting queue, then reload to reset state.
        if (selectedTask?.taskId && selectedRole) {
          localStorage.removeItem(`teambench_session_${selectedTask.taskId}_${selectedRole}_team`);
        }
        // Remove self from the Firebase waiting queue so other participants see accurate counts.
        if (selectedTask?.taskId && selectedRole) {
          import('firebase/database').then(({ ref: fbRef, remove }) => {
            remove(fbRef(db, `teambench/waiting/${selectedTask.taskId}/${selectedRole}`)).catch(() => {});
          });
        }
        window.location.reload();
      }}
    />;
  }

  return (
    <div style={{ minHeight: '100vh', background: '#11111b', display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      {/* Top bar */}
      <div style={{
        width: '100%', padding: '16px 24px', borderBottom: '1px solid #222',
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ fontSize: 20, fontWeight: 800, color: '#cdd6f4', letterSpacing: -0.5 }}>TeamBench</span>
          <span style={{ fontSize: 12, color: '#585b70', padding: '2px 8px', background: '#1e1e2e', borderRadius: 4 }}>
            Human Evaluation
          </span>
        </div>
        <StepIndicator current={step} />
      </div>

      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', width: '100%', padding: '24px 16px' }}>
        <div style={{ maxWidth: 640, width: '100%' }}>

          {/* ── Step 1: Profile ── */}
          {step === 'profile' && (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 24px', textAlign: 'center' }}>
                Profile
              </h2>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Name *" value={profile.name} onChange={v => setProfile(p => ({ ...p, name: v }))} placeholder="Jane Doe" />
                  <Field label="Email *" value={profile.email} onChange={v => setProfile(p => ({ ...p, email: v }))} placeholder="jane@university.edu" type="email" />
                </div>
                <div style={{ display: 'flex', gap: 12 }}>
                  <Field label="Institution" value={profile.institution} onChange={v => setProfile(p => ({ ...p, institution: v }))} placeholder="University / Company" />
                  <Field label="Years of experience" value={profile.yearsExp} onChange={v => setProfile(p => ({ ...p, yearsExp: v }))} placeholder="e.g. 3" type="number" />
                </div>
                <ExpertisePicker
                  value={profile.expertise}
                  onChange={v => setProfile(p => ({ ...p, expertise: v }))}
                />
              </div>

              <button
                onClick={() => {
                  if (!profileValid) return;
                  // Persist so subsequent tasks skip this step.
                  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch {}
                  setStep('task');
                }}
                disabled={!profileValid}
                style={{
                  marginTop: 28, width: '100%', padding: '12px', background: profileValid ? '#89b4fa' : '#333',
                  color: profileValid ? '#000' : '#666', border: 'none', borderRadius: 8,
                  fontWeight: 700, fontSize: 15, cursor: profileValid ? 'pointer' : 'not-allowed',
                }}
              >
                Continue
              </button>
            </FadeIn>
          )}

          {/* ── Step 2: Task Selection ── */}
          {step === 'task' && (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 20px', textAlign: 'center' }}>
                Task
              </h2>

              <div style={{
                maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6,
                paddingRight: 4,
              }}>
                {(() => {
                  let solved: Record<string, { bestPartial: number; pass: boolean }> = {};
                  try { solved = JSON.parse(localStorage.getItem('teambench_solved_v1') || '{}'); } catch {}
                  return TASK_CATALOG.map(task => (
                    <TaskRow
                      key={task.taskId}
                      task={task}
                      isSelected={selectedTask?.taskId === task.taskId}
                      solvedStatus={solved[task.taskId]}
                      onClick={() => setSelectedTask(task)}
                    />
                  ));
                })()}
              </div>

              <div style={{ display: 'flex', gap: 10, marginTop: 20 }}>
                <button onClick={() => setStep('profile')} style={backBtnStyle}>Back</button>
                <button
                  onClick={() => selectedTask && setStep('mode')}
                  disabled={!selectedTask}
                  style={{
                    flex: 1, padding: '12px', background: selectedTask ? '#89b4fa' : '#333',
                    color: selectedTask ? '#000' : '#666', border: 'none', borderRadius: 8,
                    fontWeight: 700, fontSize: 15, cursor: selectedTask ? 'pointer' : 'not-allowed',
                  }}
                >
                  Continue
                </button>
              </div>
            </FadeIn>
          )}

          {/* ── Step 3: Mode + Role ── */}
          {step === 'mode' && (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>
                Mode
              </h2>
              <p style={{ color: '#585b70', fontSize: 13, textAlign: 'center', margin: '0 0 20px' }}>
                <span style={{ color: '#89b4fa' }}>{selectedTask?.taskId}</span>
                {' '}&middot;{' '}
                <span style={{ color: DIFFICULTY_COLORS[selectedTask?.difficulty || 'medium'] }}>
                  {selectedTask?.difficulty}
                </span>
              </p>

              {/* Mode cards */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <ModeCard
                  selected={mode === 'team'}
                  onClick={() => { setMode('team'); setSelectedRole(null); }}
                  color="#89b4fa"
                  title="Team Mode"
                  subtitle="3 players"
                  desc="Collaborate with a Planner and Verifier. Each role has different access."
                />
                <ModeCard
                  selected={mode === 'oracle'}
                  onClick={() => { setMode('oracle'); setSelectedRole('oracle'); }}
                  color="#cba6f7"
                  title="Solo Mode"
                  subtitle="1 player"
                  desc="Full access to everything. Spec, code, terminal, and verification."
                />
              </div>

              {/* Role selection for team mode */}
              {mode === 'team' && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ color: '#a6adc8', fontSize: 13, fontWeight: 600, margin: '0 0 10px' }}>Pick your role:</p>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {TEAM_ROLES.map(r => {
                      const hasWaiting = waitingRoles[r.role];
                      const isSelected = selectedRole === r.role;
                      return (
                        <div
                          key={r.role}
                          onClick={() => setSelectedRole(r.role)}
                          style={{
                            flex: 1, padding: 12, background: '#181825', borderRadius: 10, cursor: 'pointer',
                            border: `2px solid ${isSelected ? r.color : 'transparent'}`,
                            textAlign: 'center', transition: 'all 0.15s',
                          }}
                        >
                          <div style={{ fontSize: 24, marginBottom: 4 }}>{r.icon}</div>
                          <div style={{
                            color: r.color, fontWeight: 700, fontSize: 13, marginBottom: 4,
                          }}>
                            {r.label}
                          </div>
                          <div style={{ color: '#a6adc8', fontSize: 11, lineHeight: 1.4 }}>{r.short}</div>
                          {hasWaiting && (
                            <div style={{
                              marginTop: 6, fontSize: 10, color: '#a6e3a1', fontWeight: 600,
                              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
                            }}>
                              <span style={{
                                width: 6, height: 6, borderRadius: '50%', background: '#a6e3a1',
                                display: 'inline-block', animation: 'pulse 1.5s infinite',
                              }} />
                              Player waiting
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', gap: 10 }}>
                <button onClick={() => { setStep('task'); setMode(null); setSelectedRole(null); }} style={backBtnStyle}>Back</button>
                <button
                  onClick={handleJoin}
                  disabled={!selectedRole || !mode || joining}
                  style={{
                    flex: 1, padding: '12px',
                    background: !selectedRole || joining ? '#333'
                      : mode === 'oracle' ? '#cba6f7'
                      : TEAM_ROLES.find(r => r.role === selectedRole)?.color || '#89b4fa',
                    color: selectedRole === 'planner' || mode === 'oracle' ? '#fff' : '#000',
                    border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15,
                    cursor: selectedRole && !joining ? 'pointer' : 'not-allowed',
                  }}
                >
                  {joining ? 'Joining...'
                    : mode === 'oracle' ? 'Start Mission'
                    : selectedRole ? `Join as ${TEAM_ROLES.find(r => r.role === selectedRole)?.label}` : 'Select a role'}
                </button>
              </div>

              <style>{`
                @keyframes pulse {
                  0%, 100% { opacity: 1; }
                  50% { opacity: 0.3; }
                }
              `}</style>
            </FadeIn>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Waiting Room (game-lobby style) ──
function WaitingRoom({ sessionId, participants: initialParticipants, taskId, onCancel }: {
  sessionId: string;
  participants: Record<string, { name: string; joinedAt: number }>;
  taskId: string;
  onCancel?: () => void;
}) {
  const [participants, setParticipants] = useState(initialParticipants);
  const [waitSeconds, setWaitSeconds] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setWaitSeconds(s => s + 1), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const unsub = onValue(ref(db, `teambench/sessions/${sessionId}/participants`), (snap) => {
      if (snap.exists()) setParticipants(snap.val());
    });
    return () => unsub();
  }, [sessionId]);

  const count = Object.keys(participants).length;

  return (
    <div style={{
      minHeight: '100vh', background: '#11111b', display: 'flex',
      alignItems: 'center', justifyContent: 'center',
    }}>
      <div style={{ maxWidth: 440, width: '100%', padding: 32, textAlign: 'center' }}>
        {/* Animated ring */}
        <div style={{
          width: 100, height: 100, margin: '0 auto 24px', borderRadius: '50%',
          border: '3px solid #333', borderTopColor: '#89b4fa',
          animation: 'spin 2s linear infinite',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <span style={{ fontSize: 32, fontWeight: 800, color: '#cdd6f4' }}>{count}/3</span>
        </div>

        <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 6px' }}>
          Assembling your team...
        </h2>
        <p style={{ color: '#a6adc8', fontSize: 13, margin: '0 0 28px' }}>
          Mission: <span style={{ color: '#89b4fa', fontWeight: 600 }}>{taskId}</span>
          <br />Session starts when all 3 roles are filled.
        </p>

        {/* Player slots */}
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          {TEAM_ROLES.map(r => {
            const p = participants[r.role];
            const filled = !!p;
            return (
              <div key={r.role} style={{
                width: 120, padding: '16px 8px', background: '#181825', borderRadius: 12,
                border: `2px solid ${filled ? r.color : '#333'}`,
                textAlign: 'center', transition: 'all 0.3s',
              }}>
                <div style={{
                  width: 44, height: 44, borderRadius: '50%', margin: '0 auto 8px',
                  background: filled ? r.color : '#313244',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  fontSize: 20, transition: 'all 0.3s',
                }}>
                  {filled ? r.icon : '?'}
                </div>
                <div style={{
                  fontSize: 12, fontWeight: 700,
                  color: filled ? r.color : '#585b70',
                }}>
                  {r.label}
                </div>
                <div style={{
                  fontSize: 11, marginTop: 4,
                  color: filled ? '#cdd6f4' : '#585b70',
                }}>
                  {filled ? p.name : 'Waiting...'}
                </div>
              </div>
            );
          })}
        </div>

        <p style={{ color: '#585b70', fontSize: 11, marginTop: 24 }}>
          Share this page with your teammates. They should pick the same task and a different role.
        </p>

        {waitSeconds > 60 && (
          <p style={{ color: '#f9e2af', fontSize: 12, marginTop: 12 }}>
            Waiting for {Math.floor(waitSeconds / 60)}m {waitSeconds % 60}s...
            {waitSeconds > 180 && ' Consider switching to Solo Mode if teammates are unavailable.'}
          </p>
        )}

        {onCancel && (
          <button
            onClick={onCancel}
            style={{
              marginTop: 20, background: 'transparent', color: '#f38ba8',
              border: '1px solid #f38ba8', borderRadius: 8, padding: '10px 32px',
              cursor: 'pointer', fontSize: 13, fontWeight: 600,
            }}
          >
            Leave & Go Back
          </button>
        )}

        <style>{`
          @keyframes spin {
            to { transform: rotate(360deg); }
          }
        `}</style>
      </div>
    </div>
  );
}

// ── Reusable Components ──

function Field({ label, value, onChange, placeholder, type }: {
  label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string;
}) {
  return (
    <div style={{ flex: 1 }}>
      <label style={{ color: '#a6adc8', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>{label}</label>
      <input
        value={value} onChange={e => onChange(e.target.value)}
        placeholder={placeholder} type={type || 'text'}
        style={{
          width: '100%', padding: '9px 12px', background: '#1e1e2e', color: '#cdd6f4',
          border: '1px solid #333', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box',
        }}
      />
    </div>
  );
}

function ModeCard({ selected, onClick, color, title, subtitle, desc }: {
  selected: boolean; onClick: () => void; color: string; title: string; subtitle: string; desc: string;
}) {
  return (
    <div onClick={onClick} style={{
      flex: 1, padding: 16, background: '#181825', borderRadius: 12, cursor: 'pointer',
      border: `2px solid ${selected ? color : 'transparent'}`, textAlign: 'center',
      transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: 18, fontWeight: 800, color: selected ? color : '#cdd6f4', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: '#585b70', marginBottom: 8 }}>{subtitle}</div>
      <div style={{ fontSize: 12, color: '#a6adc8', lineHeight: 1.4 }}>{desc}</div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'profile', label: 'Profile' },
    { key: 'task', label: 'Task' },
    { key: 'mode', label: 'Mode' },
  ];
  const idx = steps.findIndex(s => s.key === current);
  return (
    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
      {steps.map((s, i) => (
        <div key={s.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <div style={{
            width: 22, height: 22, borderRadius: '50%', fontSize: 11, fontWeight: 700,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: i <= idx ? '#89b4fa' : '#313244',
            color: i <= idx ? '#000' : '#585b70',
          }}>
            {i < idx ? '\u2713' : i + 1}
          </div>
          <span style={{ fontSize: 11, color: i <= idx ? '#cdd6f4' : '#585b70', fontWeight: i === idx ? 600 : 400 }}>
            {s.label}
          </span>
          {i < steps.length - 1 && (
            <div style={{ width: 16, height: 1, background: i < idx ? '#89b4fa' : '#333' }} />
          )}
        </div>
      ))}
    </div>
  );
}

function FadeIn({ children }: { children: React.ReactNode }) {
  return <div style={{ animation: 'fadeIn 0.3s ease' }}>
    {children}
    <style>{`@keyframes fadeIn { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }`}</style>
  </div>;
}

function TaskRow({ task, isSelected, onClick, solvedStatus }: {
  task: TaskEntry;
  isSelected: boolean;
  onClick: () => void;
  solvedStatus?: { bestPartial: number; pass: boolean; attempts?: number };
}) {
  const solvedFull = solvedStatus?.pass === true;
  const bestPartial = solvedStatus?.bestPartial ?? 0;
  const attempts = solvedStatus?.attempts ?? (solvedStatus ? 1 : 0);
  // Any prior submission (graded at least once) gets a badge, not only ≥70%.
  const attempted = !solvedFull && attempts > 0;
  return (
    <div
      onClick={onClick}
      style={{
        padding: '10px 14px', background: isSelected ? '#1e1e2e' : '#181825',
        borderRadius: 8, cursor: 'pointer',
        border: `2px solid ${isSelected ? '#89b4fa' : 'transparent'}`,
        transition: 'all 0.15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
            color: '#000', background: DIFFICULTY_COLORS[task.difficulty],
          }}>
            {task.difficulty.toUpperCase()}
          </span>
          <span style={{ color: '#cdd6f4', fontWeight: 600, fontSize: 13 }}>{task.taskId}</span>
          {solvedFull && (
            <span title={`Passed in a previous session (${attempts} attempt${attempts > 1 ? 's' : ''})`} style={{
              fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
              color: '#000', background: '#a6e3a1',
            }}>
              ✓ SOLVED
            </span>
          )}
          {attempted && (
            <span
              title={`Attempted ${attempts} time${attempts > 1 ? 's' : ''} — best score: ${Math.round(bestPartial * 100)}%`}
              style={{
                fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
                color: '#000',
                background: bestPartial >= 0.7 ? '#f9e2af' : '#fab387',
              }}
            >
              ATTEMPTED · {Math.round(bestPartial * 100)}%
            </span>
          )}
        </div>
        <span style={{ color: '#585b70', fontSize: 11 }}>{task.category}</span>
      </div>
      {/* Show description when selected */}
      {isSelected && (
        <div style={{
          marginTop: 8, padding: '10px 12px', background: '#313244',
          borderRadius: 6, borderLeft: '3px solid #89b4fa',
        }}>
          <p style={{ color: '#cdd6f4', fontSize: 13, margin: '0 0 6px', lineHeight: 1.5 }}>
            {task.description}
          </p>
          <div style={{ display: 'flex', gap: 12, fontSize: 11, color: '#a6adc8' }}>
            <span>Category: <span style={{ color: '#89b4fa' }}>{task.category}</span></span>
            <span>Difficulty: <span style={{ color: DIFFICULTY_COLORS[task.difficulty] }}>{task.difficulty}</span></span>
            <span>Files: {task.fileCount || '2-4'} files</span>
          </div>
        </div>
      )}
    </div>
  );
}

function ExpertisePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const isOther = value !== '' && !EXPERTISE_OPTIONS.slice(0, -1).includes(value);
  const [otherText, setOtherText] = useState(isOther ? value : '');
  const showInput = value === 'Other' || isOther;

  return (
    <div>
      <label style={{ color: '#a6adc8', fontSize: 12, fontWeight: 600, display: 'block', marginBottom: 4 }}>
        Primary expertise *
      </label>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {EXPERTISE_OPTIONS.map(e => {
          const active = e === 'Other' ? showInput : value === e;
          return (
            <button key={e} onClick={() => {
              if (e === 'Other') {
                onChange(otherText || 'Other');
              } else {
                onChange(e);
              }
            }} style={{
              padding: '6px 12px', fontSize: 12, borderRadius: 20, cursor: 'pointer',
              background: active ? '#89b4fa' : '#1e1e2e',
              color: active ? '#000' : '#a6adc8',
              border: `1px solid ${active ? '#89b4fa' : '#333'}`,
              fontWeight: active ? 700 : 400,
            }}>
              {e}
            </button>
          );
        })}
      </div>
      {showInput && (
        <input
          value={otherText}
          onChange={e => { setOtherText(e.target.value); onChange(e.target.value || 'Other'); }}
          placeholder="Specify your expertise..."
          autoFocus
          style={{
            marginTop: 8, width: '100%', padding: '8px 12px', background: '#1e1e2e', color: '#cdd6f4',
            border: '1px solid #89b4fa', borderRadius: 6, fontSize: 13, outline: 'none', boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}

const backBtnStyle: React.CSSProperties = {
  padding: '12px 20px', background: '#1e1e2e', color: '#a6adc8',
  border: '1px solid #333', borderRadius: 8, fontWeight: 600, fontSize: 14, cursor: 'pointer',
};
