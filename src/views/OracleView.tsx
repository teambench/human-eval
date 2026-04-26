import { useState, useCallback, useEffect } from 'react';
import { push, ref, set } from 'firebase/database';
import { db } from '../firebase';
import { sharedLastGradePath } from '../lib/firebasePaths';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal, gradeSession } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { Resizer } from '../components/Resizer';
import { Onboarding, ORACLE_STEPS } from '../components/Onboarding';
import { SessionState, FileEntry } from '../types';
import { recordTaskAttempt } from '../lib/solvedTasks';

interface OracleViewProps {
  session: SessionState;
  files: FileEntry[];
  onUpdateFile: (path: string, content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
  onLeave: () => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

/**
 * Several spec.md files were authored for Team Mode and contain narrative
 * that assumes a Planner/Executor/Verifier split. Those asides are harmless
 * to the Planner (the intended audience) but confusing to an Oracle who is
 * playing all three roles.
 *
 * This scrub is conservative — it only removes known team-narrative
 * patterns, not content. Task requirements and acceptance criteria are
 * untouched. Known patterns handled:
 *   - "(Planner Only)" suffix in H1 titles (several GH-style tasks)
 *   - "[Code changes omitted — Planner should analyze the issue and guide
 *     the Executor]" placeholders (GH103)
 *   - Inline sentences like "The executor only sees the brief; the planner
 *     has this full analysis." (GO1, API1)
 */
function stripTeamNarrative(md: string): string {
  // Targeted literal strips. An earlier lazy-regex pass ate text inside
  // `backticked` spans (e.g. "compat_matrix.md" matched the first period)
  // and mangled surrounding prose. These patterns match only the exact
  // team-narrative sentences we have found in the 20 task specs.
  const patterns: [RegExp, string][] = [
    // Title decorations — "(Planner Only)" etc.
    [/\s*—?\s*Full Specification\s*\(Planner Only\)\s*/gi, ' — Full Specification'],
    [/\s*\(Planner Only\)\s*/gi, ''],
    // GH103 fix-location placeholders.
    [/^\s*\[Code changes omitted\s*—\s*Planner should analyze the issue and guide the Executor\]\s*$/gim, ''],
    // GO1 narrative aside.
    [/\s*The executor only sees the brief; the planner has this full analysis\.?/g, ''],
    // API1 narrative aside (multi-line — ends at "... instructions.").
    [/\s*The Executor only receives the brief; the Planner must read[\s\S]{1,120}?instructions\.?/g, ''],
    // Any other "Only the Planner who reads <X>" aside (API1 has one).
    [/\s*Only the Planner who reads [^\n]{1,160}\.?/g, ''],
  ];
  let out = md;
  for (const [re, rep] of patterns) out = out.replace(re, rep);
  return out;
}

export function OracleView({ session, files, onUpdateFile, onPhaseChange, onLog, onLeave, saveStatus }: OracleViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files.find(f => !f.readOnly)?.path ?? null);
  // See ExecutorView: files load after mount, so the initializer often runs
  // on an empty list. This backstop picks an editable file once they arrive.
  useEffect(() => {
    if (selectedFile) return;
    const pick = files.find(f => !f.readOnly) ?? files[0];
    if (pick) setSelectedFile(pick.path);
  }, [files, selectedFile]);
  const [grading, setGrading] = useState(false);
  const [gradeResult, setGradeResult] = useState<{ status: string; score?: any; output?: string } | null>(null);
  const [finished, setFinished] = useState(false);
  // Self-reported phase — optional tracking for solo mode. The participant
  // can click Plan/Execute/Verify to tag their workflow transitions; the
  // click emits a phase_change log event (with source='self_report'). It
  // does NOT change session.phase or any access control. Analysis uses
  // these events to compute per-phase durations comparable to team-mode
  // phase boundaries. Default 'execution' matches the session init phase.
  const [reportedPhase, setReportedPhase] = useState<'planning' | 'execution' | 'verification'>('execution');
  const reportPhase = useCallback((p: 'planning' | 'execution' | 'verification') => {
    setReportedPhase(prev => {
      if (prev === p) return prev;
      onLog('phase_change', { from: prev, to: p, source: 'self_report' });
      return p;
    });
  }, [onLog]);

  // Resizable panel sizes
  const [leftWidth, setLeftWidth] = useState(380);
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [terminalHeight, setTerminalHeight] = useState(180);

  // Spotlight progress: guide first-time solo participants from editing
  // through testing to grading. Local state resets on reload, so a
  // reloaded participant sees the onboarding hints once more — fine.
  const [hasEdited, setHasEdited] = useState(false);
  const [hasRunCommand, setHasRunCommand] = useState(false);

  const currentFile = files.find(f => f.path === selectedFile);
  // Terminal stays active until user clicks "Finish Session"
  const isActive = session.phase !== 'lobby' && !finished;

  const needsEditAttention = isActive && !gradeResult && !hasEdited;
  const needsTerminalAttention = isActive && !gradeResult && hasEdited && !hasRunCommand;
  const needsGradeAttention = isActive && !gradeResult && hasEdited && hasRunCommand;

  const handleSubmit = async () => {
    setGrading(true);
    onLog('oracle_submit_grade');
    const result = await gradeSession(session.sessionId);
    setGradeResult(result);
    onLog('oracle_grade_result', { ...result });
    // Persist a structured grade record to Firebase so solo-mode runs have
    // the same /lastGrade + /gradeHistory schema as team/hybrid. Post-hoc
    // analysis can read a uniform path across all three modes.
    try {
      const sc: any = result?.score ?? null;
      const pass = sc?.pass === true;
      const partial = typeof sc?.secondary?.partial_score === 'number'
        ? sc.secondary.partial_score : (pass ? 1 : 0);
      const payload = {
        ok: result?.status !== 'error',
        verdict: pass ? 'pass' : 'fail',
        score: partial,
        scoreDetail: sc,
        output: result?.output ?? '',
        // Verbose per-language re-runs only when the grader marked the
        // run as failed (backend emits null on pass).
        diagnostics: (result as any)?.diagnostics ?? null,
        error: result?.status === 'error' ? (result.output || 'grader error') : null,
        timestamp: Date.now(),
      };
      await set(ref(db, `teambench/sessions/${session.sessionId}/lastGrade`), payload);
      await push(ref(db, `teambench/sessions/${session.sessionId}/gradeHistory`), {
        ...payload,
        triggeredBy: 'oracle_submit',
        mode: 'oracle',
      });
      // v2 mirror — sharedArtifacts/lastGrade so analysis on the new tree
      // doesn't have to fall back to the legacy path. Best-effort.
      try {
        await set(
          ref(db, sharedLastGradePath(session.taskConfig.taskId, 'oracle', session.sessionId)),
          payload,
        );
      } catch (e) { console.warn('[v2 lastGrade]', e); }
    } catch (e) {
      console.warn('persist oracle grade failed', e);
    }
    // Persist attempt to Firebase (cross-device) + localStorage (instant cache).
    // Every grade increments attempts, regardless of score.
    try {
      const sc = result?.score || {};
      const sec = sc.secondary || {};
      const newPartial = typeof sec.partial_score === 'number'
        ? sec.partial_score : (sc.pass ? 1 : 0);
      // Profile was persisted by LobbyView on first submit (teambench_profile_v1).
      let email = '';
      try {
        const raw = localStorage.getItem('teambench_profile_v1');
        email = raw ? (JSON.parse(raw).email || '') : '';
      } catch { /* ignore */ }
      await recordTaskAttempt(email, session.taskConfig.taskId, 'oracle', newPartial, sc.pass === true);
    } catch (err) {
      console.warn('persist attempt failed', err);
    }
    setGrading(false);
  };

  const handleFinish = () => {
    setFinished(true);
    onPhaseChange('completed');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      <Onboarding steps={ORACLE_STEPS} storageKey={`onboarding_oracle_${session.sessionId}`} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #cba6f7',
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
            background: '#cba6f7', color: '#fff', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            ORACLE (Solo)
          </span>
          <span style={{ color: '#cdd6f4', fontSize: 14 }}>
            {session.taskConfig.displayName ?? session.taskConfig.taskId} &middot; {session.taskConfig.category} &middot; {session.taskConfig.difficulty}
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {/* Optional self-reported phase chips. Clicking tags the current
              workflow step (Plan → Execute → Verify) with a phase_change
              log event for post-hoc per-phase duration analysis. Does not
              gate access; participants may ignore these entirely. */}
          {isActive && (
            <div
              role="group"
              aria-label="Workflow phase (optional self-report)"
              title="Optional: tag your current step so we can measure phase durations"
              style={{
                display: 'flex', alignItems: 'center', gap: 4,
                background: '#181825', padding: '3px 4px', borderRadius: 6,
                border: '1px solid #313244',
              }}
            >
              {(['planning', 'execution', 'verification'] as const).map(p => {
                const label = p === 'planning' ? 'Plan' : p === 'execution' ? 'Execute' : 'Verify';
                const active = reportedPhase === p;
                return (
                  <button
                    key={p}
                    onClick={() => reportPhase(p)}
                    title={`Tag current step as ${label}`}
                    style={{
                      padding: '3px 10px', border: 'none', borderRadius: 4,
                      background: active ? '#cba6f7' : 'transparent',
                      color: active ? '#1e1e2e' : '#a6adc8',
                      fontSize: 11, fontWeight: 600, cursor: 'pointer',
                      transition: 'background 0.15s',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}
          <Timer startTime={session.startTime} timeLimit={session.taskConfig.timeLimit} />
          <span style={{
            background: '#313244', color: '#cdd6f4', padding: '4px 10px',
            borderRadius: 4, fontSize: 12, fontWeight: 600,
          }}>
            Full Access
          </span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left panel: Spec / Brief */}
        <div style={{ width: leftWidth, minWidth: 250, maxWidth: 600, display: 'flex', flexDirection: 'column' }}>
          {/* Solo mode only ever shows the full Specification — we used to
              also render a "Brief" tab, but briefs are written for Team Mode
              and frequently instruct the reader to "Follow the Planner's
              guidance." That's nonsense in solo mode where no Planner exists.
              The full spec is self-contained and role-agnostic. */}
          <div style={{
            padding: '8px 16px', background: '#181825', borderBottom: '1px solid #333',
            color: '#cdd6f4', fontSize: 13, fontWeight: 600,
          }}>
            Task Specification
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <MarkdownViewer
              content={stripTeamNarrative(session.taskConfig.specMd || '')}
            />
          </div>

          {/* Submit & Grade panel */}
          {isActive && !gradeResult && (
            <div style={{ padding: 12, background: '#1e1e2e', borderTop: '1px solid #333' }}>
              <button
                onClick={handleSubmit}
                disabled={grading}
                className={needsGradeAttention ? 'tb-spotlight' : undefined}
                style={{
                  width: '100%', background: grading ? '#555' : '#cba6f7', color: '#fff',
                  border: 'none', borderRadius: 6, padding: '10px', cursor: grading ? 'wait' : 'pointer',
                  fontWeight: 700, fontSize: 14,
                  ['--tb-spot-rgb' as any]: '203, 166, 247',
                }}
              >
                {grading ? 'Grading...' : 'Submit & Grade'}
              </button>
              <p style={{ color: '#585b70', fontSize: 11, margin: '6px 0 0', textAlign: 'center' }}>
                Auto-graded using the task's test suite.
              </p>
            </div>
          )}

          {/* Grade result */}
          {gradeResult && (() => {
            const sc = gradeResult.score || {};
            const sec = sc.secondary || {};
            const passed = sec.checks_passed;
            const total = sec.checks_total;
            const partial = sec.partial_score;
            const isError = gradeResult.status === 'error';
            const fullPass = sc.pass === true;
            const partialPass = !fullPass && partial !== undefined && partial >= 0.7;
            const headerColor = fullPass ? '#a6e3a1' : partialPass ? '#f9e2af' : '#f38ba8';
            const headerLabel = isError ? 'Grading unavailable'
              : fullPass ? 'PASSED'
              : partialPass ? 'PARTIAL'
              : 'FAILED';
            const failures: string[] = Array.isArray(sc.failure_modes) ? sc.failure_modes : [];
            return (
            <div style={{ padding: 12, background: '#1e1e2e', borderTop: '1px solid #333' }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                <span style={{ fontSize: 14, fontWeight: 700, color: headerColor }}>
                  {headerLabel}
                </span>
                {partial !== undefined && (
                  <span style={{ fontSize: 12, color: '#cdd6f4' }}>
                    {Math.round(partial * 100)}%{passed !== undefined && total ? ` (${passed}/${total} checks)` : ''}
                  </span>
                )}
              </div>
              {failures.length > 0 && (
                <div style={{
                  fontSize: 11, color: '#f9e2af', marginBottom: 6,
                  background: '#181825', padding: '4px 8px', borderRadius: 4,
                }}>
                  Failed checks: {failures.join(', ')}
                </div>
              )}
              {gradeResult.output ? (
                <pre style={{
                  fontSize: 11, color: '#a6adc8', background: '#181825',
                  padding: 8, borderRadius: 4, maxHeight: 120, overflowY: 'auto',
                  whiteSpace: 'pre-wrap', margin: 0,
                }}>
                  {gradeResult.output.slice(-800)}
                </pre>
              ) : (
                <div style={{ fontSize: 11, color: '#6c7086', fontStyle: 'italic' }}>
                  (no grader output — check your session logs)
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <button
                  onClick={() => setGradeResult(null)}
                  style={{
                    flex: 1, padding: '8px', background: '#313244', color: '#cdd6f4',
                    border: '1px solid #555', borderRadius: 6, cursor: 'pointer',
                    fontWeight: 600, fontSize: 12,
                  }}
                >
                  Keep Editing
                </button>
                <button
                  onClick={handleFinish}
                  style={{
                    flex: 1, padding: '8px', background: '#a6e3a1', color: '#000',
                    border: 'none', borderRadius: 6, cursor: 'pointer',
                    fontWeight: 700, fontSize: 12,
                  }}
                >
                  Finish Session
                </button>
              </div>
            </div>
            );
          })()}
        </div>

        <Resizer direction="horizontal" onResize={useCallback((d: number) => setLeftWidth(w => Math.max(250, Math.min(600, w + d))), [])} />

        {/* Center: File tree + Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
          <div
            className={needsEditAttention ? 'tb-spotlight' : undefined}
            style={{
              width: fileTreeWidth, minWidth: 120, maxWidth: 350,
              display: 'flex', flexDirection: 'column',
              ['--tb-spot-rgb' as any]: '203, 166, 247',
            }}
          >
            {needsEditAttention && (
              <div className="tb-spot-hint" style={{ ['--tb-spot-rgb' as any]: '203, 166, 247' }}>
                📝 Pick a file and start editing
              </div>
            )}
            <div style={{ flex: 1, minHeight: 0 }}>
              <FileTree
                files={files.filter(f => {
                  // Hide team-mode-only artefacts from the Solo file tree.
                  // brief.md is written for the Executor and frequently says
                  // "Follow the Planner's guidance precisely" — meaningless in
                  // Solo. analysis_guidance.md is written for the Planner.
                  // README_HUMAN.md is just generic terminal-usage instructions
                  // (Solo participants don't need them spelled out alongside
                  // the spec). The full spec is shown in the dedicated panel.
                  if (f.path === 'brief.md') return false;
                  if (f.path === 'analysis_guidance.md') return false;
                  if (f.path === 'README_HUMAN.md') return false;
                  return true;
                })}
                selectedPath={selectedFile}
                onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }}
              />
            </div>
          </div>

          <Resizer direction="horizontal" onResize={useCallback((d: number) => setFileTreeWidth(w => Math.max(120, Math.min(350, w + d))), [])} />

          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            {currentFile && (
              <div style={{
                padding: '4px 12px', background: '#181825', fontSize: 11, color: '#585b70',
                borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              }}>
                <span>{currentFile.path}{currentFile.readOnly && <span style={{marginLeft:8,color:'#6c7086'}}>(read-only)</span>}</span>
                {!currentFile.readOnly && isActive && (
                  <span style={{
                    fontSize: 10, fontWeight: 600,
                    color: saveStatus === 'saved' ? '#a6e3a1'
                      : saveStatus === 'saving' ? '#f9e2af'
                      : saveStatus === 'error' ? '#f38ba8'
                      : '#585b70',
                  }}>
                    {saveStatus === 'saving' ? '● Saving…'
                      : saveStatus === 'saved' ? '● Synced to container'
                      : saveStatus === 'error' ? '● Save failed'
                      : '○ Ready'}
                  </span>
                )}
              </div>
            )}
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {currentFile ? (
                <CodeEditor
                  path={currentFile.path}
                  content={currentFile.content}
                  language={currentFile.language}
                  readOnly={!isActive || currentFile.readOnly}
                  onChange={isActive && !currentFile.readOnly ? v => { if (!hasEdited) setHasEdited(true); onUpdateFile(currentFile.path, v); } : undefined}
                />
              ) : (
                <div style={{ padding: 24, color: '#888' }}>Select a file to edit</div>
              )}
            </div>

            <Resizer direction="vertical" onResize={useCallback((d: number) => setTerminalHeight(h => Math.max(80, Math.min(500, h - d))), [])} />

            <div
              className={needsTerminalAttention ? 'tb-spotlight' : undefined}
              style={{
                height: terminalHeight, minHeight: 80,
                display: 'flex', flexDirection: 'column',
                ['--tb-spot-rgb' as any]: '203, 166, 247',
              }}
            >
              {needsTerminalAttention && (
                <div className="tb-spot-hint" style={{ ['--tb-spot-rgb' as any]: '203, 166, 247' }}>
                  ▶ Run your tests here before grading (e.g. `pytest -x`)
                </div>
              )}
              <div style={{ flex: 1, minHeight: 0 }}>
                <Terminal
                  sessionId={session.sessionId}
                  taskId={session.taskConfig.taskId}
                  files={files.map(f => ({ path: f.path, content: f.content }))}
                  disabled={finished}
                  onCommand={cmd => { if (!hasRunCommand) setHasRunCommand(true); onLog('command_run', { command: cmd }); }}
                />
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
