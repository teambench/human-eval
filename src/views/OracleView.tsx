import { useState, useCallback } from 'react';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal, gradeSession } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { Resizer } from '../components/Resizer';
import { Onboarding, ORACLE_STEPS } from '../components/Onboarding';
import { SessionState, FileEntry } from '../types';

interface OracleViewProps {
  session: SessionState;
  files: FileEntry[];
  onUpdateFile: (path: string, content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

export function OracleView({ session, files, onUpdateFile, onPhaseChange, onLog, saveStatus }: OracleViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files.find(f => !f.readOnly)?.path ?? null);
  const [leftTab, setLeftTab] = useState<'spec' | 'brief'>('spec');
  const [grading, setGrading] = useState(false);
  const [gradeResult, setGradeResult] = useState<{ status: string; score?: any; output?: string } | null>(null);
  const [finished, setFinished] = useState(false);

  // Resizable panel sizes
  const [leftWidth, setLeftWidth] = useState(380);
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [terminalHeight, setTerminalHeight] = useState(180);

  const currentFile = files.find(f => f.path === selectedFile);
  // Terminal stays active until user clicks "Finish Session"
  const isActive = session.phase !== 'lobby' && !finished;

  const handleSubmit = async () => {
    setGrading(true);
    onLog('oracle_submit_grade');
    const result = await gradeSession(session.sessionId);
    setGradeResult(result);
    onLog('oracle_grade_result', { ...result });
    // Persist per-task best score so the task picker can show a solved badge.
    try {
      const sc = result?.score || {};
      const sec = sc.secondary || {};
      const newPartial = typeof sec.partial_score === 'number' ? sec.partial_score : (sc.pass ? 1 : 0);
      const key = 'teambench_solved_v1';
      const raw = localStorage.getItem(key);
      const store = raw ? JSON.parse(raw) : {};
      const prev = store[session.taskConfig.taskId] || { bestPartial: 0, pass: false };
      if (newPartial > prev.bestPartial || (sc.pass && !prev.pass)) {
        store[session.taskConfig.taskId] = {
          bestPartial: Math.max(newPartial, prev.bestPartial),
          pass: sc.pass === true || prev.pass === true,
          lastGradedISO: new Date().toISOString(),
        };
        localStorage.setItem(key, JSON.stringify(store));
      }
    } catch { /* ignore quota / parse errors */ }
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
          <span style={{
            background: '#cba6f7', color: '#fff', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            ORACLE (Solo)
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
            Full Access
          </span>
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left panel: Spec / Brief */}
        <div style={{ width: leftWidth, minWidth: 250, maxWidth: 600, display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', background: '#181825', borderBottom: '1px solid #333' }}>
            {(['spec', 'brief'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setLeftTab(tab)}
                style={{
                  flex: 1, padding: '8px 16px', background: leftTab === tab ? '#1e1e2e' : 'transparent',
                  color: leftTab === tab ? '#cdd6f4' : '#888', border: 'none',
                  borderBottom: leftTab === tab ? '2px solid #cba6f7' : '2px solid transparent',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600,
                }}
              >
                {tab === 'spec' ? 'Full Specification' : 'Brief'}
              </button>
            ))}
          </div>
          <div style={{ flex: 1, overflow: 'hidden' }}>
            <MarkdownViewer content={leftTab === 'spec' ? session.taskConfig.specMd : session.taskConfig.briefMd} />
          </div>

          {/* Submit & Grade panel */}
          {isActive && !gradeResult && (
            <div style={{ padding: 12, background: '#1e1e2e', borderTop: '1px solid #333' }}>
              <button
                onClick={handleSubmit}
                disabled={grading}
                style={{
                  width: '100%', background: grading ? '#555' : '#cba6f7', color: '#fff',
                  border: 'none', borderRadius: 6, padding: '10px', cursor: grading ? 'wait' : 'pointer',
                  fontWeight: 700, fontSize: 14,
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
          <div style={{ width: fileTreeWidth, minWidth: 120, maxWidth: 350 }}>
            <FileTree files={files} selectedPath={selectedFile} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
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
                  onChange={isActive && !currentFile.readOnly ? v => onUpdateFile(currentFile.path, v) : undefined}
                />
              ) : (
                <div style={{ padding: 24, color: '#888' }}>Select a file to edit</div>
              )}
            </div>

            <Resizer direction="vertical" onResize={useCallback((d: number) => setTerminalHeight(h => Math.max(80, Math.min(500, h - d))), [])} />

            <div style={{ height: terminalHeight, minHeight: 80 }}>
              <Terminal
                sessionId={session.sessionId}
                taskId={session.taskConfig.taskId}
                files={files.map(f => ({ path: f.path, content: f.content }))}
                disabled={finished}
                onCommand={cmd => onLog('command_run', { command: cmd })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
