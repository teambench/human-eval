import { useState, useEffect } from 'react';
import { ref, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, TaskConfig } from '../types';
import { TASK_CATALOG, TaskEntry, DEMO_TASK } from '../data/taskCatalog';
import { subscribeToUserSolved, SolvedByModeMap, statusFor, ModeStatus, loadSolvedFromLocal, subscribeToTaskStats, TaskStats } from '../lib/solvedTasks';
import {
  findJoinableTeam, getActiveSessionsForEmail, cancelOtherSession,
  JoinablePeek, ActiveSessionRef,
} from '../lib/lobbyChecks';

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

type Step = 'consent' | 'profile' | 'task' | 'mode' | 'waiting';

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
// Bump the version suffix when the info sheet text changes — forces every
// returning participant to re-acknowledge the updated notice.
const CONSENT_KEY = 'teambench_consent_v1';

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
  // COUHES Exempt Category 2 requires an information sheet be presented to
  // participants even though signed consent is waived. We gate the flow on
  // a localStorage ack; returning participants skip once they've acknowledged.
  const consentAcked = (() => {
    try { return localStorage.getItem(CONSENT_KEY) === 'acked'; } catch { return false; }
  })();
  // If we landed here after a completed task (?start_task=1) and have a saved
  // profile, skip the Profile step so the user doesn't have to retype.
  const initialStep: Step =
    !consentAcked ? 'consent'
    : profileAlreadyValid ? 'task'
    : 'profile';
  const [step, setStep] = useState<Step>(initialStep);
  const [profile, setProfile] = useState<UserProfile>(persistedProfile);
  // Solved / attempted map, keyed by taskId. Source of truth is Firebase at
  // teambench/users/{sanitized_email}/solved, with localStorage as an instant
  // cache so badges render immediately on page load.
  const [userSolved, setUserSolved] = useState<SolvedByModeMap>(loadSolvedFromLocal());
  useEffect(() => {
    if (!profile.email?.trim()) return;
    return subscribeToUserSolved(profile.email, setUserSolved);
  }, [profile.email]);
  const [selectedTask, setSelectedTask] = useState<TaskEntry | null>(null);
  const [mode, setMode] = useState<SessionMode | null>(null);
  const [selectedRole, setSelectedRole] = useState<Role | null>(null);
  const [waitingRoles, setWaitingRoles] = useState<Record<string, boolean>>({});
  // Filters + live global task stats for the picker step. Difficulty is
  // a pill group (4 fixed values); category is a dropdown (derived from
  // TASK_CATALOG). Stats are keyed by taskId and refresh in real time as
  // any participant completes a grading attempt anywhere.
  type DiffFilter = 'all' | TaskEntry['difficulty'];
  const [diffFilter, setDiffFilter] = useState<DiffFilter>('all');
  const [catFilter, setCatFilter] = useState<string>('all');
  const [taskStats, setTaskStats] = useState<Record<string, TaskStats>>({});
  useEffect(() => subscribeToTaskStats(setTaskStats), []);

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

  // Pre-join confirmation state. Two independent gates:
  //   (1) activeSessionsWarning  — user has another active session somewhere.
  //   (2) teamPeek               — team mode is about to attach to an existing
  //                                waiting room; show roster first.
  // rejectedTeamSessions accumulates "find a different team" choices so peek
  // skips them on the next gate run.
  const [activeSessionsWarning, setActiveSessionsWarning] = useState<ActiveSessionRef[] | null>(null);
  const [teamPeek, setTeamPeek] = useState<JoinablePeek | null>(null);
  const [rejectedTeamSessions, setRejectedTeamSessions] = useState<Set<string>>(new Set());
  const [checkingPreJoin, setCheckingPreJoin] = useState(false);

  function buildTaskConfig(): TaskConfig | null {
    if (!selectedTask) return null;
    const isDemo = selectedTask.taskId === 'DEMO_api_fix';
    return isDemo
      ? { ...DEMO_TASK }
      : {
          taskId: selectedTask.taskId,
          displayName: selectedTask.displayName,
          category: selectedTask.category,
          difficulty: selectedTask.difficulty,
          timeLimit: 1800,
          specMd: `# ${selectedTask.displayName}\n\nRead \`brief.md\` in the workspace terminal for the full task description.`,
          briefMd: `# ${selectedTask.displayName}\n\nLoading task from backend... See \`brief.md\` in /workspace.`,
          files: [],
        };
  }

  function commitJoin() {
    const taskConfig = buildTaskConfig();
    if (!taskConfig || !selectedRole) return;
    onJoin(taskConfig, selectedRole, mode || 'team', profile.name.trim(), profile);
  }

  // Run the two pre-join gates. `skipActiveCheck` true on re-entry from
  // the active-sessions modal "Continue here" button. `extraRejected`
  // applies a freshly-rejected sessionId before state propagation.
  async function runPreJoinGates(skipActiveCheck = false, extraRejected: string[] = []) {
    if (!selectedTask || !selectedRole || !profileValid) return;
    setCheckingPreJoin(true);
    try {
      // Gate 1 — multi-session sanity check (all modes).
      if (!skipActiveCheck) {
        const active = await getActiveSessionsForEmail(profile.email);
        if (active.length > 0) {
          setActiveSessionsWarning(active);
          return;
        }
      }
      // Gate 2 — team-mode pre-entry confirmation, only if a real team is
      // joinable. Solo and hybrid skip this gate entirely.
      if (mode === 'team') {
        const exclude = new Set([...rejectedTeamSessions, ...extraRejected]);
        const peek = await findJoinableTeam(
          selectedTask.taskId, selectedRole, profile.email, exclude,
        );
        if (peek && peek.participants.length > 0) {
          setTeamPeek(peek);
          return;
        }
      }
      // No gate triggered → commit join.
      commitJoin();
    } finally {
      setCheckingPreJoin(false);
    }
  }

  const handleJoin = () => {
    void runPreJoinGates();
  };

  function handleActiveSessionsContinue() {
    setActiveSessionsWarning(null);
    void runPreJoinGates(/*skipActiveCheck=*/true);
  }

  function handleActiveSessionsCancel() {
    setActiveSessionsWarning(null);
  }

  async function handleActiveSessionsLeaveAndContinue() {
    const sessions = activeSessionsWarning || [];
    setActiveSessionsWarning(null);
    setCheckingPreJoin(true);
    try {
      for (const s of sessions) {
        await cancelOtherSession(s);
      }
    } finally {
      setCheckingPreJoin(false);
    }
    void runPreJoinGates(/*skipActiveCheck=*/true);
  }

  function handleTeamPeekConfirm() {
    setTeamPeek(null);
    commitJoin();
  }

  function handleTeamPeekReject() {
    const rejected = teamPeek?.sessionId;
    setTeamPeek(null);
    if (rejected) {
      setRejectedTeamSessions(prev => new Set([...prev, rejected]));
    }
    void runPreJoinGates(/*skipActiveCheck=*/true, rejected ? [rejected] : []);
  }

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
    <>
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

          {/* ── Step 0: Information Sheet (COUHES Exempt E-7676) ── */}
          {step === 'consent' && (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 8px', textAlign: 'center' }}>
                Study Information
              </h2>
              <p style={{ color: '#585b70', fontSize: 12, textAlign: 'center', margin: '0 0 20px' }}>
                Please read before continuing.
              </p>

              <div style={{
                background: '#181825', border: '1px solid #313244', borderRadius: 10,
                padding: 20, color: '#cdd6f4', fontSize: 13, lineHeight: 1.6,
                maxHeight: 420, overflowY: 'auto',
              }}>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Study:</strong> TeamBench — Evaluating Agent Collaboration via Role Separation
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Principal Investigator:</strong> Hae Won Park, Program in Media Arts and Sciences, MIT<br/>
                  <strong>Faculty Sponsor:</strong> Cynthia Breazeal<br/>
                  <strong>IRB:</strong> MIT COUHES, Exempt ID E-7676 (Category 2)
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>What you will do:</strong> you will attempt one or more software-engineering
                  tasks in a web-based coding interface. Each task takes up to about 30 minutes. You may
                  do the task alone ("Solo") or together with other participants in assigned roles ("Team").
                  After each task you will answer a short survey about your experience.
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Data collected:</strong> name, email, institution, years of experience, area of
                  expertise, the code and commands you write during the task, chat messages in team mode,
                  grader scores, timing, and your survey responses. Your email is used to link your
                  sessions across tasks and is not published or shared outside the research team.
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Risks and benefits:</strong> there is no more than minimal risk. There is no
                  direct benefit to you. Research results may inform how AI agents and people collaborate
                  on software work.
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Voluntary participation:</strong> participation is entirely voluntary. You may
                  stop at any time by closing the browser or clicking "Back" inside a task; partial data
                  up to that point may be retained unless you contact the team to have it deleted.
                </p>
                <p style={{ margin: '0 0 10px' }}>
                  <strong>Confidentiality:</strong> data is stored on project infrastructure (Firebase,
                  MIT servers). Published results report aggregates and de-identified excerpts only.
                </p>
                <p style={{ margin: '0 0 0' }}>
                  <strong>Questions:</strong> contact the research team at <em>teambench@mit.edu</em>.
                  For questions about your rights as a research participant, contact MIT COUHES at
                  <em> couhes@mit.edu</em> or +1 (617) 253-6787.
                </p>
                <p style={{ margin: '12px 0 0', color: '#f9e2af', fontSize: 12 }}>
                  <em>This is a placeholder — replace with the exact text approved by COUHES once the
                  amendment is finalized. Bump CONSENT_KEY to "v2" to force all returning participants
                  to re-acknowledge.</em>
                </p>
              </div>

              <button
                onClick={() => {
                  try { localStorage.setItem(CONSENT_KEY, 'acked'); } catch {}
                  setStep(profileAlreadyValid ? 'task' : 'profile');
                }}
                style={{
                  marginTop: 20, width: '100%', padding: '12px', background: '#89b4fa',
                  color: '#000', border: 'none', borderRadius: 8,
                  fontWeight: 700, fontSize: 15, cursor: 'pointer',
                }}
              >
                I have read this information — continue
              </button>
              <p style={{ color: '#585b70', fontSize: 11, textAlign: 'center', margin: '10px 0 0' }}>
                Clicking continue indicates that you have read the information above. No signature
                required under Exempt Category 2.
              </p>
            </FadeIn>
          )}

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
          {step === 'task' && (() => {
            // Category list derived from the catalog so adding a task
            // never requires touching the filter UI. Difficulty order is
            // fixed (easy first so participants see the gentle onramp).
            const DIFF_ORDER: Record<TaskEntry['difficulty'], number> =
              { easy: 0, medium: 1, hard: 2, expert: 3 };
            const categories = Array.from(new Set(TASK_CATALOG.map(t => t.category))).sort();
            const filteredTasks = TASK_CATALOG
              .filter(t => diffFilter === 'all' || t.difficulty === diffFilter)
              .filter(t => catFilter === 'all' || t.category === catFilter)
              .slice()
              .sort((a, b) =>
                DIFF_ORDER[a.difficulty] - DIFF_ORDER[b.difficulty]
                || a.category.localeCompare(b.category)
                || a.displayName.localeCompare(b.displayName),
              );
            const DIFF_PILLS: Array<DiffFilter> = ['all', 'easy', 'medium', 'hard', 'expert'];
            const DIFF_COLORS_BG: Record<TaskEntry['difficulty'], string> = {
              easy: '#a6e3a1', medium: '#f9e2af', hard: '#fab387', expert: '#f38ba8',
            };
            return (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 12px', textAlign: 'center' }}>
                Task
              </h2>

              {/* Filter bar: difficulty pills + category dropdown */}
              <div style={{
                display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center',
                padding: '8px 10px', background: '#181825', borderRadius: 8,
                marginBottom: 10, fontSize: 12,
              }}>
                <span style={{ color: '#6c7086', fontSize: 11, fontWeight: 600, marginRight: 2 }}>
                  Difficulty:
                </span>
                {DIFF_PILLS.map(d => {
                  const active = diffFilter === d;
                  const color = d === 'all' ? '#89b4fa' : DIFF_COLORS_BG[d];
                  return (
                    <button
                      key={d}
                      onClick={() => setDiffFilter(d)}
                      style={{
                        padding: '3px 10px', borderRadius: 4,
                        border: `1px solid ${active ? color : '#313244'}`,
                        background: active ? color : 'transparent',
                        color: active ? '#000' : '#a6adc8',
                        fontSize: 11, fontWeight: 700, cursor: 'pointer',
                        textTransform: 'uppercase',
                      }}
                    >
                      {d}
                    </button>
                  );
                })}
                <span style={{ flex: 1 }} />
                <span style={{ color: '#6c7086', fontSize: 11, fontWeight: 600 }}>Category:</span>
                <select
                  value={catFilter}
                  onChange={e => setCatFilter(e.target.value)}
                  style={{
                    background: '#313244', color: '#cdd6f4',
                    border: '1px solid #45475a', borderRadius: 4,
                    padding: '3px 6px', fontSize: 12, maxWidth: 220,
                  }}
                >
                  <option value="all">All categories</option>
                  {categories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
                <span style={{ color: '#6c7086', fontSize: 11, marginLeft: 4 }}>
                  {filteredTasks.length} / {TASK_CATALOG.length}
                </span>
              </div>

              <div style={{
                maxHeight: 420, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 6,
                paddingRight: 4,
              }}>
                {filteredTasks.length === 0 ? (
                  <div style={{
                    padding: 24, textAlign: 'center', color: '#6c7086', fontSize: 13,
                    background: '#181825', borderRadius: 6,
                  }}>
                    No tasks match the current filters.
                  </div>
                ) : filteredTasks.map(task => (
                  <TaskRow
                    key={task.taskId}
                    task={task}
                    stats={taskStats[task.taskId]}
                    isSelected={selectedTask?.taskId === task.taskId}
                    onClick={() => setSelectedTask(task)}
                  />
                ))}
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
            );
          })()}

          {/* ── Step 3: Mode + Role ── */}
          {step === 'mode' && (
            <FadeIn>
              <h2 style={{ color: '#cdd6f4', fontSize: 22, fontWeight: 700, margin: '0 0 6px', textAlign: 'center' }}>
                Mode
              </h2>
              <p style={{ color: '#585b70', fontSize: 13, textAlign: 'center', margin: '0 0 20px' }}>
                <span style={{ color: '#89b4fa' }}>{selectedTask?.displayName}</span>
                {' '}&middot;{' '}
                <span style={{ color: DIFFICULTY_COLORS[selectedTask?.difficulty || 'medium'] }}>
                  {selectedTask?.difficulty}
                </span>
              </p>

              {/* Mode cards — per-mode status badges (DONE / ATTEMPTED / NOT STARTED)
                  reflect THIS user's progress on the selected task in that specific
                  mode. Emojis: 3 humans for Team, 1 human for Solo, 2 robots + 1
                  human for Hybrid. */}
              <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
                <ModeCard
                  selected={mode === 'team'}
                  onClick={() => { setMode('team'); setSelectedRole(null); }}
                  color="#89b4fa"
                  title="Team Mode"
                  subtitle="3 humans"
                  desc="Collaborate with a Planner and Verifier. Each role has different access."
                  emojis={pickEmojis(`${selectedTask?.taskId || ''}|team`, 'team')}
                  status={statusFor(userSolved[selectedTask?.taskId || '']?.team)}
                />
                <ModeCard
                  selected={mode === 'oracle'}
                  onClick={() => { setMode('oracle'); setSelectedRole('oracle'); }}
                  color="#cba6f7"
                  title="Solo Mode"
                  subtitle="1 human"
                  desc="Full access to everything. Spec, code, terminal, and verification."
                  emojis={pickEmojis(`${selectedTask?.taskId || ''}|oracle`, 'humans')}
                  status={statusFor(userSolved[selectedTask?.taskId || '']?.oracle)}
                />
                <ModeCard
                  selected={mode === 'hybrid'}
                  onClick={() => { setMode('hybrid'); setSelectedRole('verifier'); }}
                  color="#10b981"
                  title="Hybrid Mode"
                  subtitle="1 human + 2 AI"
                  desc="The Human is the Verifier. AI Planner + AI Executor write code; the Human grades it."
                  emojis={pickEmojis(`${selectedTask?.taskId || ''}|hybrid`, 'hybrid')}
                  status={statusFor(userSolved[selectedTask?.taskId || '']?.hybrid)}
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
                      : mode === 'hybrid' ? '#10b981'
                      : TEAM_ROLES.find(r => r.role === selectedRole)?.color || '#89b4fa',
                    color: selectedRole === 'planner' || mode === 'oracle' ? '#fff' : '#000',
                    border: 'none', borderRadius: 8, fontWeight: 700, fontSize: 15,
                    cursor: selectedRole && !joining ? 'pointer' : 'not-allowed',
                  }}
                >
                  {joining ? 'Joining...'
                    : mode === 'oracle' ? 'Start Mission'
                    : mode === 'hybrid' ? 'Start Hybrid Mission'
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

    {/* ── Pre-join confirmation modals ───────────────────────────────── */}
    {activeSessionsWarning && (
      <ModalShell title="You already have an active session">
        <p style={{ color: '#cdd6f4', fontSize: 14, marginBottom: 12 }}>
          We see {activeSessionsWarning.length === 1 ? 'an active session' : `${activeSessionsWarning.length} active sessions`} in your account already. Continuing here will leave {activeSessionsWarning.length === 1 ? 'it' : 'them'} orphaned (the other tab will keep showing the lobby/task UI but won't be cleaned up).
        </p>
        <ul style={{ margin: '0 0 16px 16px', padding: 0, color: '#a6adc8', fontSize: 13 }}>
          {activeSessionsWarning.map(s => (
            <li key={s.sessionId} style={{ marginBottom: 6 }}>
              <strong style={{ color: '#cdd6f4' }}>{s.taskId}</strong>
              {' '}({s.mode}, role: {s.role}, status: {s.status})
            </li>
          ))}
        </ul>
        <p style={{ color: '#f9e2af', fontSize: 13, marginBottom: 16 }}>
          Recommended: switch back to your existing tab and finish (or cancel) that session first.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={handleActiveSessionsCancel} style={modalSecondaryBtnStyle}>
            Cancel — go back to that session
          </button>
          <button onClick={handleActiveSessionsLeaveAndContinue} style={modalPrimaryBtnStyle}>
            Leave that session and continue here
          </button>
          <button onClick={handleActiveSessionsContinue} style={modalDangerBtnStyle}>
            Continue here anyway (leave orphan)
          </button>
        </div>
      </ModalShell>
    )}

    {teamPeek && (
      <ModalShell title="Join this team?">
        <p style={{ color: '#cdd6f4', fontSize: 14, marginBottom: 12 }}>
          You're about to join an existing team for{' '}
          <strong>{teamPeek.taskId}</strong> as <strong>{selectedRole}</strong>:
        </p>
        <ul style={{ margin: '0 0 16px 16px', padding: 0, color: '#a6adc8', fontSize: 13 }}>
          {teamPeek.participants.map(p => (
            <li key={p.role} style={{ marginBottom: 6 }}>
              <span style={{
                display: 'inline-block', minWidth: 70, fontWeight: 600,
                color: TEAM_ROLES.find(r => r.role === p.role)?.color || '#cdd6f4',
                textTransform: 'capitalize',
              }}>{p.role}</span>
              <strong style={{ color: '#cdd6f4' }}>{p.name}</strong>
              {p.institution && <span style={{ color: '#6c7086' }}> · {p.institution}</span>}
            </li>
          ))}
        </ul>
        <p style={{ color: '#6c7086', fontSize: 12, marginBottom: 16 }}>
          If you'd rather not join this group, choose "Find a different team" — we'll create a fresh waiting room for you.
        </p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={handleTeamPeekReject} style={modalSecondaryBtnStyle}>Find a different team</button>
          <button onClick={handleTeamPeekConfirm} style={modalPrimaryBtnStyle}>Join this team</button>
        </div>
      </ModalShell>
    )}

    {checkingPreJoin && !activeSessionsWarning && !teamPeek && (
      <div style={{
        position: 'fixed', inset: 0, background: 'rgba(17,17,27,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 9999,
      }}>
        <div style={{ color: '#cdd6f4', fontSize: 14 }}>Checking lobby state…</div>
      </div>
    )}
    </>
  );
}

// ── Modal shared bits ────────────────────────────────────────────────────
function ModalShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      position: 'fixed', inset: 0, background: 'rgba(17,17,27,0.85)',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      zIndex: 10000, padding: 16,
    }}>
      <div style={{
        background: '#1e1e2e', border: '1px solid #313244',
        borderRadius: 12, padding: 24, maxWidth: 540, width: '100%',
        boxShadow: '0 8px 24px rgba(0,0,0,0.4)',
      }}>
        <h3 style={{ margin: 0, marginBottom: 12, color: '#cdd6f4', fontSize: 17, fontWeight: 700 }}>
          {title}
        </h3>
        {children}
      </div>
    </div>
  );
}

const modalPrimaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: '#10b981', color: '#11111b',
  border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700,
  cursor: 'pointer',
};
const modalSecondaryBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: '#313244', color: '#cdd6f4',
  border: '1px solid #45475a', borderRadius: 6, fontSize: 13, fontWeight: 600,
  cursor: 'pointer',
};
const modalDangerBtnStyle: React.CSSProperties = {
  padding: '8px 14px', background: '#f38ba8', color: '#11111b',
  border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 700,
  cursor: 'pointer',
};

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

  // Auto-kick after 15 minutes. If teammates never show, keeping the user
  // frozen in the waiting room is worse than dropping them back to the
  // lobby where they can pick a different task or switch to Solo Mode.
  useEffect(() => {
    if (waitSeconds >= 900 && onCancel) onCancel();
  }, [waitSeconds, onCancel]);

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
            {waitSeconds > 180 && waitSeconds <= 900 && ' Consider switching to Solo Mode if teammates are unavailable.'}
            {waitSeconds > 840 && waitSeconds <= 900 && ` Auto-leaving in ${900 - waitSeconds}s.`}
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

// Single human icon across all modes — using multiple varied emojis looked
// like role labels and was confusing per user feedback.
const HUMAN_EMOJI = '🧑‍💻';
const ROBOT_EMOJI = '🤖';

function pickEmojis(_seed: string, kind: 'humans' | 'team' | 'hybrid'): string {
  if (kind === 'team') return `${HUMAN_EMOJI} ${HUMAN_EMOJI} ${HUMAN_EMOJI}`;
  if (kind === 'hybrid') return `${ROBOT_EMOJI} ${HUMAN_EMOJI} ${ROBOT_EMOJI}`;
  return HUMAN_EMOJI; // solo
}

const STATUS_LABEL: Record<ModeStatus, { label: string; color: string }> = {
  done:        { label: 'DONE',        color: '#a6e3a1' },
  attempted:   { label: 'ATTEMPTED',   color: '#f9e2af' },
  not_started: { label: 'NOT STARTED', color: '#6c7086' },
};

function ModeCard({
  selected, onClick, color, title, subtitle, desc, emojis, status,
}: {
  selected: boolean; onClick: () => void; color: string;
  title: string; subtitle: string; desc: string;
  emojis: string;
  status: ModeStatus;
}) {
  const statusInfo = STATUS_LABEL[status];
  return (
    <div onClick={onClick} style={{
      flex: 1, padding: 16, background: '#181825', borderRadius: 12, cursor: 'pointer',
      border: `2px solid ${selected ? color : 'transparent'}`, textAlign: 'center',
      transition: 'all 0.15s',
    }}>
      <div style={{ fontSize: 22, marginBottom: 6, letterSpacing: 2 }}>{emojis}</div>
      <div style={{ fontSize: 18, fontWeight: 800, color: selected ? color : '#cdd6f4', marginBottom: 2 }}>{title}</div>
      <div style={{ fontSize: 11, color: '#585b70', marginBottom: 8 }}>{subtitle}</div>
      <div style={{ fontSize: 12, color: '#a6adc8', lineHeight: 1.4, marginBottom: 8 }}>{desc}</div>
      <div style={{
        display: 'inline-block', fontSize: 10, fontWeight: 700,
        padding: '2px 8px', borderRadius: 4,
        color: '#000', background: statusInfo.color,
      }}>
        {statusInfo.label}
      </div>
    </div>
  );
}

function StepIndicator({ current }: { current: Step }) {
  const steps: { key: Step; label: string }[] = [
    { key: 'consent', label: 'Info' },
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

function TaskRow({ task, isSelected, onClick, stats }: {
  task: TaskEntry;
  isSelected: boolean;
  onClick: () => void;
  stats?: TaskStats;
}) {
  // Per-task progress badges removed by request — progress is shown
  // per-mode on the Mode selection screen (a participant can have
  // different status in Solo vs Team vs Hybrid for the same task).
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
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
          <span style={{
            fontSize: 10, fontWeight: 700, padding: '2px 7px', borderRadius: 4,
            color: '#000', background: DIFFICULTY_COLORS[task.difficulty], flexShrink: 0,
          }}>
            {task.difficulty.toUpperCase()}
          </span>
          <span style={{
            color: '#cdd6f4', fontWeight: 600, fontSize: 13,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {task.displayName}
          </span>
          <span
            title={task.taskId}
            style={{
              color: '#585b70', fontSize: 10, fontFamily: 'ui-monospace, monospace',
              flexShrink: 0,
            }}
          >
            {task.taskId}
          </span>
        </div>
        <span style={{
          display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, marginLeft: 8,
          color: '#585b70', fontSize: 11,
        }}>
          {stats && stats.attempters > 0 && (
            <span
              title={`${stats.attempters} participant${stats.attempters === 1 ? '' : 's'} attempted, ${stats.completers} completed`}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '1px 6px', borderRadius: 10,
                background: '#313244', fontFamily: 'ui-monospace, monospace',
              }}
            >
              <span>👥 {stats.attempters}</span>
              <span style={{ color: '#a6e3a1' }}>✓ {stats.completers}</span>
            </span>
          )}
          <span>{task.category}</span>
        </span>
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
