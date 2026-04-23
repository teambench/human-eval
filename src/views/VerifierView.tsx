import { useCallback, useEffect, useRef, useState } from 'react';
import { onValue, ref, set } from 'firebase/database';
import { DiffEditor } from '@monaco-editor/react';
import { db } from '../firebase';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { gradeSession } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { Resizer } from '../components/Resizer';
import { Onboarding, VERIFIER_STEPS } from '../components/Onboarding';
import { SessionState, Role, FileEntry } from '../types';
import { recordTaskAttempt, ModeKey } from '../lib/solvedTasks';

// Subscribes to per-turn agent usage records — role + token counts. The
// gateway/model identifier is intentionally NOT exposed to the Verifier
// (studies require participants to be blind to which LLM wrote the code).
interface AgentUsage {
  role: 'planner' | 'executor';
  gateway: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  timestamp: number;
}
function useAgentActivity(sessionId: string, enabled: boolean) {
  const [entries, setEntries] = useState<AgentUsage[]>([]);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return onValue(ref(db, `teambench/sessions/${sessionId}/agentModelUsage`), snap => {
      if (!snap.exists()) { setEntries([]); return; }
      const vals = Object.values(snap.val() as Record<string, AgentUsage>);
      vals.sort((a, b) => a.timestamp - b.timestamp);
      setEntries(vals);
    });
  }, [sessionId, enabled]);
  return entries;
}

// Initial (pre-execution) workspace snapshot for the diff viewer.
interface InitialFile { path: string; content: string }
function useInitialWorkspace(sessionId: string, enabled: boolean) {
  const [files, setFiles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return onValue(ref(db, `teambench/sessions/${sessionId}/initialWorkspace`), snap => {
      if (!snap.exists()) { setFiles({}); return; }
      const out: Record<string, string> = {};
      const data = snap.val() as Record<string, InitialFile>;
      for (const v of Object.values(data)) {
        if (v?.path != null) out[v.path] = v.content ?? '';
      }
      setFiles(out);
    });
  }, [sessionId, enabled]);
  return files;
}

// Grader output (auto-run by executor after ### DONE). Undefined until
// the grader has run at least once.
interface LastGrade {
  ok?: boolean;
  verdict?: string;
  score?: number | null;
  scoreDetail?: Record<string, unknown> | null;
  exit_code?: number;
  output?: string;
  error?: string;
  status?: number;
  timestamp?: number;
}
function useLastGrade(sessionId: string, enabled: boolean): LastGrade | null {
  const [grade, setGrade] = useState<LastGrade | null>(null);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return onValue(ref(db, `teambench/sessions/${sessionId}/lastGrade`), snap => {
      setGrade(snap.exists() ? (snap.val() as LastGrade) : null);
    });
  }, [sessionId, enabled]);
  return grade;
}

// Per-agent "thinking" flag — set to 'thinking' by agent_runner while it's
// waiting on an LLM call, back to 'idle' otherwise. Renders the "AI is
// thinking..." indicator so the Verifier knows why the chat just went quiet.
type AgentState = 'thinking' | 'idle';
interface AgentStatusMap { planner?: { state?: AgentState }; executor?: { state?: AgentState } }
function useAgentStatus(sessionId: string, enabled: boolean): AgentStatusMap {
  const [status, setStatus] = useState<AgentStatusMap>({});
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return onValue(ref(db, `teambench/sessions/${sessionId}/agentStatus`), snap => {
      setStatus(snap.exists() ? (snap.val() as AgentStatusMap) : {});
    });
  }, [sessionId, enabled]);
  return status;
}

interface VerifierViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
  onLeave: () => void;
}

export function VerifierView({ session, files, messages, onSendMessage, onPhaseChange, onLog, onLeave }: VerifierViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'spec' | 'files'>('spec');
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  const [notes, setNotes] = useState('');
  const [viewedWorkspace, setViewedWorkspace] = useState(false);
  const [fileTreeWidth, setFileTreeWidth] = useState(260);
  const [chatWidth, setChatWidth] = useState(340);
  // Top-level so hook-call order is constant — same bug as PlannerView.
  const handleResize = useCallback(
    (d: number) => setFileTreeWidth(w => Math.max(140, Math.min(500, w + d))),
    [],
  );
  const handleChatResize = useCallback(
    // Drag is applied inside-out: dragging the resizer left widens the chat.
    (d: number) => setChatWidth(w => Math.max(260, Math.min(700, w - d))),
    [],
  );

  const currentFile = files.find(f => f.path === selectedFile);
  const canVerify = session.phase === 'verification';
  const isHybrid = session.mode === 'hybrid';
  const agentActivity = useAgentActivity(session.sessionId, isHybrid);
  const agentStatus = useAgentStatus(session.sessionId, isHybrid);
  // Initial workspace subscription: enabled for ALL team-style modes (team
  // + hybrid) so the Verifier can see a +/- diff against the pre-execution
  // baseline. Populated by useFirebaseSession's fetchOnce on first staging
  // complete. Solo mode has no Verifier role so this is never reached.
  const initialFiles = useInitialWorkspace(session.sessionId, true);
  // Enabled for all modes — the Verifier needs to see grader output
  // regardless of whether teammates were human or AI. For team mode,
  // the grader is auto-run on entering verification phase (below).
  const lastGrade = useLastGrade(session.sessionId, true);
  // Default ON whenever a baseline exists — in team mode the Verifier
  // should see diffs in real time as the Executor edits, not have to
  // hunt for a toggle.
  const [showDiff, setShowDiff] = useState(false);
  useEffect(() => {
    if (Object.keys(initialFiles).length > 0) setShowDiff(true);
  }, [initialFiles]);
  const fileIsChanged = !!(currentFile && initialFiles[currentFile.path] != null
                           && initialFiles[currentFile.path] !== currentFile.content);
  // Every path that differs from the baseline, for the FileTree to color
  // and dot-mark. Recomputed each render from the two prop snapshots —
  // cheap for workspaces <100 files.
  const modifiedPaths = new Set(
    files
      .filter(f => initialFiles[f.path] == null || initialFiles[f.path] !== f.content)
      .map(f => f.path),
  );

  // Team-mode auto-grading: when the Executor hands off, the Verifier
  // needs to see the grader's output to decide PASS/FAIL. Hybrid mode's
  // backend agent_runner writes lastGrade itself; in team mode no one
  // does, so the Verifier's tab runs the grader once on entering
  // verification phase and writes the result to Firebase under the same
  // `lastGrade` path. Guarded to fire AT MOST ONCE per session via a
  // ref — re-entering verification after a fail verdict still won't
  // re-grade (the Verifier clicks FAIL to send the Executor back; if
  // they want fresh grader output after the Executor's next hand-off,
  // they can reload — the ref resets then).
  const [autoGrading, setAutoGrading] = useState(false);
  const autoGradedRef = useRef(false);
  useEffect(() => {
    if (isHybrid) return;                // hybrid backend writes lastGrade
    if (!canVerify) return;
    if (lastGrade) return;               // already have a grade for this session
    if (autoGradedRef.current) return;   // already fired once this mount
    autoGradedRef.current = true;
    setAutoGrading(true);
    (async () => {
      try {
        const r = await gradeSession(session.sessionId);
        const sc: any = r?.score ?? null;
        const pass = sc?.pass === true;
        const partial = typeof sc?.secondary?.partial_score === 'number'
          ? sc.secondary.partial_score
          : (pass ? 1 : 0);
        const payload = {
          ok: r?.status !== 'error',
          verdict: pass ? 'pass' : 'fail',
          score: partial,
          scoreDetail: sc,
          exit_code: typeof r?.exit_code === 'number' ? r.exit_code : null,
          output: r?.output ?? '',
          error: r?.status === 'error' ? (r.output || 'grader error') : null,
          timestamp: Date.now(),
        };
        await set(ref(db, `teambench/sessions/${session.sessionId}/lastGrade`), payload);
      } catch (e) {
        console.warn('auto-grade failed:', e);
      } finally {
        setAutoGrading(false);
      }
    })();
  }, [isHybrid, canVerify, lastGrade, session.sessionId]);

  // Spotlights for the Verifier: (1) the Workspace tab (they start on Spec),
  // (2) the verdict buttons once they've inspected the work, (3) the submit
  // button once they've chosen PASS/FAIL.
  const needsWorkspaceAttention = canVerify && !viewedWorkspace;
  const needsVerdictAttention = canVerify && viewedWorkspace && !verdict;
  const needsSubmitAttention = canVerify && !!verdict;

  const handleSubmitVerdict = () => {
    if (!verdict) return;
    onLog('submit_verdict', { verdict, notes });

    // Record per-mode attempt so the lobby's mode cards reflect that this
    // user has done/attempted this task in this specific mode. Pull email
    // from localStorage (same pattern as OracleView).
    if (verdict === 'pass' || verdict === 'fail') {
      let email = '';
      try {
        const raw = localStorage.getItem('teambench_profile_v1');
        email = raw ? (JSON.parse(raw).email || '') : '';
      } catch { /* ignore */ }
      const partial = verdict === 'pass'
        ? 1.0
        : (typeof lastGrade?.score === 'number' ? lastGrade.score : 0.0);
      // Only record team/oracle/hybrid here; oracle has its own path in OracleView.
      const m = session.mode as ModeKey;
      if (m === 'team' || m === 'hybrid') {
        recordTaskAttempt(email, session.taskConfig.taskId, m, partial, verdict === 'pass')
          .catch(e => console.warn('recordTaskAttempt failed:', e));
      }
    }

    if (verdict === 'fail') {
      // Send feedback to executor, go back to execution
      onSendMessage('executor', `[VERIFICATION FAILED]\n\n${notes}`);
      onPhaseChange('execution');
    } else {
      onPhaseChange('completed');
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      <Onboarding steps={VERIFIER_STEPS} storageKey={`onboarding_verifier_${session.sessionId}`} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #10b981',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={onLeave}
            title="Leave this task and return to the lobby"
            style={{
              background: 'transparent', color: '#a6adc8', border: '1px solid #45475a',
              borderRadius: 4, padding: '4px 10px', fontSize: 12, cursor: 'pointer',
            }}
          >
            ← Back
          </button>
          <span style={{
            background: '#10b981', color: '#000', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            VERIFIER
          </span>
          <span style={{ color: '#cdd6f4', fontSize: 14 }}>
            {session.taskConfig.taskId} &middot; {session.taskConfig.category} &middot; {session.taskConfig.difficulty}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Timer startTime={session.startTime} timeLimit={session.taskConfig.timeLimit} />
          <span style={{
            background: '#313244', color: '#cdd6f4', padding: '4px 10px',
            borderRadius: 4, fontSize: 12, fontWeight: 600,
          }}>
            Phase: {session.phase}
          </span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: Spec + Files */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Tabs */}
          <div style={{ display: 'flex', background: '#181825', borderBottom: '1px solid #333' }}>
            {(['spec', 'files'] as const).map(tab => {
              const highlight = tab === 'files' && needsWorkspaceAttention;
              return (
                <button
                  key={tab}
                  onClick={() => {
                    setActiveTab(tab);
                    if (tab === 'files' && !viewedWorkspace) setViewedWorkspace(true);
                  }}
                  className={highlight ? 'tb-spotlight' : undefined}
                  style={{
                    padding: '8px 20px', background: activeTab === tab ? '#1e1e2e' : 'transparent',
                    color: activeTab === tab ? '#cdd6f4' : '#888', border: 'none',
                    borderBottom: activeTab === tab ? '2px solid #10b981' : '2px solid transparent',
                    cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize',
                    ['--tb-spot-rgb' as any]: '16, 185, 129',
                  }}
                >
                  {tab === 'spec' ? 'Specification' : 'Workspace (Read-Only)'}
                </button>
              );
            })}
          </div>

          {/* Content */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {activeTab === 'spec' ? (
              <MarkdownViewer content={session.taskConfig.specMd} title="Full Task Specification" />
            ) : (
              <div style={{ display: 'flex', height: '100%' }}>
                <div style={{ width: fileTreeWidth, minWidth: 140, maxWidth: 500, overflow: 'hidden' }}>
                  <FileTree files={files} selectedPath={selectedFile} modifiedPaths={modifiedPaths} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
                </div>
                <Resizer direction="horizontal" onResize={handleResize} />
                <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                  {currentFile && Object.keys(initialFiles).length > 0 && (
                    <div style={{
                      padding: '4px 10px', background: '#181825', borderBottom: '1px solid #313244',
                      fontSize: 11, display: 'flex', alignItems: 'center', gap: 10, color: '#a6adc8',
                    }}>
                      <span>{currentFile.path}</span>
                      {fileIsChanged ? (
                        <span style={{ color: '#fbbf24', fontWeight: 600 }}>● modified{isHybrid ? ' by AI' : ' by Executor'}</span>
                      ) : initialFiles[currentFile.path] != null ? (
                        <span style={{ color: '#6c7086' }}>unchanged</span>
                      ) : (
                        <span style={{ color: '#f38ba8' }}>+ new file</span>
                      )}
                      <label style={{ marginLeft: 'auto', cursor: 'pointer', fontSize: 11 }}>
                        <input
                          type="checkbox"
                          checked={showDiff}
                          onChange={e => setShowDiff(e.target.checked)}
                          style={{ marginRight: 4, verticalAlign: 'middle' }}
                        />
                        Show diff
                      </label>
                    </div>
                  )}
                  <div style={{ flex: 1 }}>
                    {currentFile ? (
                      showDiff && Object.keys(initialFiles).length > 0 ? (
                        <DiffEditor
                          original={initialFiles[currentFile.path] ?? ''}
                          modified={currentFile.content}
                          language={currentFile.language}
                          theme="vs-dark"
                          options={{
                            readOnly: true,
                            renderSideBySide: false,
                            minimap: { enabled: false },
                            fontSize: 13,
                            lineNumbers: 'on',
                            scrollBeyondLastLine: false,
                          }}
                        />
                      ) : (
                        <CodeEditor path={currentFile.path} content={currentFile.content} language={currentFile.language} readOnly />
                      )
                    ) : (
                      <div style={{ padding: 24, color: '#888' }}>Select a file to view</div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Hybrid banner: tell the human their teammates are AI agents. */}
          {session.mode === 'hybrid' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(16,185,129,0.12)',
              borderTop: '1px solid rgba(16,185,129,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#10b981' }}>Hybrid mode.</strong>{' '}
              Your Planner and Executor are AI agents. Watch their work in chat + Workspace,
              then grade the result. If you submit FAIL, your notes will be sent back to
              the AI Executor for another attempt (up to 2 remediations).
              {agentActivity.length > 0 && (
                <details style={{ marginTop: 6 }}>
                  <summary style={{ cursor: 'pointer', color: '#86efac', fontSize: 11 }}>
                    AI Activity ({agentActivity.length} {agentActivity.length === 1 ? 'turn' : 'turns'})
                  </summary>
                  <table style={{
                    width: '100%', marginTop: 6, fontSize: 10, fontFamily: 'ui-monospace, monospace',
                    borderCollapse: 'collapse',
                  }}>
                    <thead>
                      <tr style={{ color: '#6c7086', textAlign: 'left' }}>
                        <th style={{ padding: '2px 6px' }}>Role</th>
                        <th style={{ padding: '2px 6px', textAlign: 'right' }}>In→Out tokens</th>
                        <th style={{ padding: '2px 6px' }}>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {agentActivity.map((e, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #313244' }}>
                          <td style={{ padding: '2px 6px', color: e.role === 'planner' ? '#a5b4fc' : '#fbbf24' }}>
                            {e.role}
                          </td>
                          <td style={{ padding: '2px 6px', textAlign: 'right', color: '#cdd6f4' }}>
                            {e.usage?.prompt_tokens ?? 0}→{e.usage?.completion_tokens ?? 0}
                          </td>
                          <td style={{ padding: '2px 6px', color: '#6c7086' }}>
                            {new Date(e.timestamp).toLocaleTimeString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </details>
              )}
            </div>
          )}
          {/* Phase-gating banner for non-verification phases. Without this,
              the Verifier sits and waits without any cue as to what the
              other roles are doing. */}
          {!canVerify && session.phase === 'planning' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(99,102,241,0.12)',
              borderTop: '1px solid rgba(99,102,241,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#a5b4fc' }}>
                {session.mode === 'hybrid' ? 'AI Planner is analyzing.' : 'Planner is analyzing.'}
              </strong>{' '}
              You can read the Specification now. Once the Executor marks the task done, you'll
              review their work and submit a verdict.
            </div>
          )}
          {!canVerify && session.phase === 'execution' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(245,158,11,0.12)',
              borderTop: '1px solid rgba(245,158,11,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#fbbf24' }}>
                {session.mode === 'hybrid' ? 'AI Executor is implementing.' : 'Executor is implementing.'}
              </strong>{' '}
              Follow along in the Workspace tab — files update in real time. You can ask
              clarifying questions via chat. You'll submit your verdict after the Executor
              marks done.
            </div>
          )}
          {/* Grading in progress (team mode auto-grader). */}
          {autoGrading && !lastGrade && (
            <div style={{
              padding: '10px 14px', background: '#181825',
              borderTop: '1px solid #313244', fontSize: 11, color: '#a6adc8',
              flexShrink: 0,
            }}>
              <span style={{ color: '#fbbf24', fontWeight: 600 }}>● Running grader…</span>
              {' '}This may take up to a minute (some graders compile code).
            </div>
          )}
          {/* Test output panel — surfaces the auto-grader's stdout so the
              Verifier can judge based on real test results, not vibes. */}
          {lastGrade && (
            <div style={{
              padding: '10px 14px', background: '#181825',
              borderTop: '1px solid #313244', fontSize: 11, color: '#cdd6f4',
              // Bound the whole panel so opening the details doesn't push the
              // Verdict panel off-screen or shrink the file viewer to zero.
              maxHeight: 300, overflowY: 'auto', flexShrink: 0,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                <strong style={{ color: '#cdd6f4' }}>Auto-grader output</strong>
                {lastGrade.verdict && (
                  <span style={{
                    padding: '1px 8px', borderRadius: 3, fontWeight: 700, fontSize: 10,
                    background: lastGrade.verdict === 'pass' ? '#10b98133' : '#f38ba833',
                    color: lastGrade.verdict === 'pass' ? '#10b981' : '#f38ba8',
                  }}>
                    {lastGrade.verdict.toUpperCase()}
                  </span>
                )}
                {lastGrade.score != null && (
                  <span style={{ color: '#a6adc8', fontSize: 10 }}>
                    score: {(() => {
                      const s: any = lastGrade.score;
                      if (typeof s === 'number') return s.toFixed(2);
                      if (typeof s === 'string') return s;
                      // The grader can return a dict like {overall: 0.8, ...}.
                      // Show the "overall" field if present; else JSON-stringify.
                      if (s && typeof s === 'object') {
                        if (typeof s.overall === 'number') return s.overall.toFixed(2);
                        if (typeof s.score === 'number') return s.score.toFixed(2);
                        return JSON.stringify(s).slice(0, 60);
                      }
                      return String(s);
                    })()}
                  </span>
                )}
                {!lastGrade.ok && (
                  <span style={{ color: '#f38ba8', fontSize: 10 }}>
                    grader error{lastGrade.error ? `: ${lastGrade.error}` : ''}
                  </span>
                )}
              </div>
              <details open>
                <summary style={{ cursor: 'pointer', color: '#89b4fa', fontSize: 11 }}>
                  grader output ({(lastGrade.output?.length || 0)} chars
                  {lastGrade.exit_code != null ? `, exit ${lastGrade.exit_code}` : ''})
                </summary>
                <pre style={{
                  margin: '6px 0 0', padding: 8, background: '#11111b', borderRadius: 4,
                  fontSize: 10, fontFamily: 'ui-monospace, monospace',
                  maxHeight: 220, overflow: 'auto', whiteSpace: 'pre-wrap',
                  color: '#cdd6f4',
                }}>
                  {lastGrade.output || '(grader produced no output)'}
                </pre>
                {lastGrade.scoreDetail && (
                  <pre style={{
                    margin: '6px 0 0', padding: 6, background: '#11111b', borderRadius: 4,
                    fontSize: 10, fontFamily: 'ui-monospace, monospace',
                    color: '#a6adc8',
                  }}>
                    {JSON.stringify(lastGrade.scoreDetail, null, 2)}
                  </pre>
                )}
              </details>
            </div>
          )}
          {/* Verdict panel */}
          {canVerify && (
            <div style={{
              padding: 16, background: '#1e1e2e', borderTop: '1px solid #333',
              flexShrink: 0,
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 4 }}>
                Submit Verification Verdict
              </div>
              <p style={{ fontSize: 11, color: '#6c7086', margin: '0 0 10px', lineHeight: 1.5 }}>
                {isHybrid ? (
                  <>
                    <strong style={{ color: '#a6adc8' }}>Your role:</strong> don't just rubber-stamp the auto-grader.
                    Your job is to catch what the tests CAN'T: brittle fixes, wrong-but-passing solutions,
                    security regressions, code that happens to satisfy the existing tests but doesn't
                    actually solve the problem in the spec. Check the <strong style={{ color: '#a6adc8' }}>diff</strong>{' '}
                    and the <strong style={{ color: '#a6adc8' }}>grader output</strong>, then decide: PASS if the
                    fix is genuinely correct; FAIL if it isn't (even if tests pass). On FAIL your notes go
                    back to the AI Executor for one more attempt.
                  </>
                ) : (
                  <>
                    Use <strong style={{ color: '#a6adc8' }}>Show diff</strong> above to see what changed,
                    and the <strong style={{ color: '#a6adc8' }}>Auto-grader output</strong> for test results.
                    Pick <span style={{ color: '#10b981', fontWeight: 600 }}>PASS</span> if the fix is correct
                    and complete, <span style={{ color: '#f38ba8', fontWeight: 600 }}>FAIL</span> if something
                    is missing or wrong. On FAIL, your notes are sent back to the Executor for one more attempt.
                  </>
                )}
              </p>
              <div
                className={needsVerdictAttention ? 'tb-spotlight' : undefined}
                style={{
                  display: 'flex', gap: 8, marginBottom: 8, padding: 4,
                  ['--tb-spot-rgb' as any]: '16, 185, 129',
                }}
              >
                <button
                  onClick={() => setVerdict('pass')}
                  style={{
                    padding: '8px 20px', border: '2px solid',
                    borderColor: verdict === 'pass' ? '#10b981' : '#555',
                    background: verdict === 'pass' ? '#10b98133' : 'transparent',
                    color: '#10b981', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
                  }}
                >
                  PASS
                </button>
                <button
                  onClick={() => setVerdict('fail')}
                  style={{
                    padding: '8px 20px', border: '2px solid',
                    borderColor: verdict === 'fail' ? '#f38ba8' : '#555',
                    background: verdict === 'fail' ? '#f38ba833' : 'transparent',
                    color: '#f38ba8', borderRadius: 6, cursor: 'pointer', fontWeight: 700,
                  }}
                >
                  FAIL
                </button>
              </div>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder={verdict === 'fail' ? 'Explain what needs to be fixed...' : 'Optional notes...'}
                style={{
                  width: '100%', height: 60, background: '#313244', color: '#cdd6f4',
                  border: '1px solid #555', borderRadius: 4, padding: 8, fontSize: 13,
                  resize: 'vertical', fontFamily: 'inherit',
                }}
              />
              <button
                onClick={handleSubmitVerdict}
                disabled={!verdict}
                className={needsSubmitAttention ? 'tb-spotlight' : undefined}
                style={{
                  marginTop: 8, background: verdict ? '#10b981' : '#555', color: '#000',
                  border: 'none', borderRadius: 6, padding: '10px 32px', cursor: verdict ? 'pointer' : 'not-allowed',
                  fontWeight: 700, fontSize: 14,
                  ['--tb-spot-rgb' as any]: '16, 185, 129',
                }}
              >
                {verdict === 'fail' ? 'Send Back to Executor' : 'Submit & Complete'}
              </button>
            </div>
          )}
        </div>

        {/* Resizer + Chat — draggable width so the Verifier can widen chat
            when the AI pastes a long reply. */}
        <Resizer direction="horizontal" onResize={handleChatResize} />
        <div style={{
          width: chatWidth, minWidth: 260, maxWidth: 700,
          borderLeft: '1px solid #333', display: 'flex', flexDirection: 'column',
        }}>
          {/* "AI is thinking…" indicators — shown at the top of chat so the
              Verifier knows why the panel just went quiet. */}
          {isHybrid && (agentStatus.planner?.state === 'thinking' || agentStatus.executor?.state === 'thinking') && (
            <div style={{
              padding: '6px 12px', background: 'rgba(147, 197, 253, 0.08)',
              borderBottom: '1px solid rgba(147, 197, 253, 0.22)',
              fontSize: 11, color: '#a6adc8', display: 'flex', gap: 10,
            }}>
              {agentStatus.planner?.state === 'thinking' && (
                <span><span style={{ color: '#a5b4fc' }}>AI Planner</span> is thinking<span className="tb-dots">…</span></span>
              )}
              {agentStatus.executor?.state === 'thinking' && (
                <span><span style={{ color: '#fbbf24' }}>AI Executor</span> is thinking<span className="tb-dots">…</span></span>
              )}
            </div>
          )}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <ChatPanel
              role="verifier"
              messages={messages}
              onSend={onSendMessage}
              disabled={session.phase === 'lobby' || session.phase === 'completed'}
              systemNote={
                isHybrid && session.phase === 'verification'
                  ? '💡 The auto-grader has run. Your job is to DECIDE whether to trust it — humans catch things tests miss (brittle fixes, security holes, wrong-but-passes-tests solutions). Review the diff on the left, then PASS or FAIL.'
                  : session.phase === 'planning'
                  ? '💡 You are the Verifier. Read the Specification while the Planner writes the plan. You can ask clarifying questions in chat.'
                  : session.phase === 'execution'
                  ? '💡 The Executor is implementing the plan. They need to click "Mark Done" to hand off to you. Watch the Workspace tab to follow their edits in real time.'
                  : session.phase === 'verification'
                  ? '💡 Your turn. The grader is running (or already ran). Review the diff on the left, check the grader output below, then click PASS or FAIL.'
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
