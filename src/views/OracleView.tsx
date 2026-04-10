import { useState } from 'react';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal, gradeSession } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { SessionState, FileEntry } from '../types';

interface OracleViewProps {
  session: SessionState;
  files: FileEntry[];
  onUpdateFile: (path: string, content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
}

export function OracleView({ session, files, onUpdateFile, onPhaseChange, onLog }: OracleViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files.find(f => !f.readOnly)?.path ?? null);
  const [leftTab, setLeftTab] = useState<'spec' | 'brief'>('spec');
  const [grading, setGrading] = useState(false);
  const [gradeResult, setGradeResult] = useState<{ status: string; score?: any; output?: string } | null>(null);

  const currentFile = files.find(f => f.path === selectedFile);
  const isActive = session.phase !== 'lobby' && session.phase !== 'completed';

  const handleSubmit = async () => {
    setGrading(true);
    onLog('oracle_submit_grade');

    // Run auto-grading via backend
    const result = await gradeSession(session.sessionId);
    setGradeResult(result);
    onLog('oracle_grade_result', { ...result });
    setGrading(false);

    // Mark completed regardless of grade
    onPhaseChange('completed');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
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
        <div style={{ width: 380, display: 'flex', flexDirection: 'column', borderRight: '1px solid #333' }}>
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
            <MarkdownViewer
              content={leftTab === 'spec' ? session.taskConfig.specMd : session.taskConfig.briefMd}
            />
          </div>

          {/* Submit & Grade panel */}
          {isActive && (
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
                Your code will be automatically graded using the task's test suite.
              </p>
            </div>
          )}

          {/* Grade result */}
          {gradeResult && (
            <div style={{
              padding: 12, background: '#1e1e2e', borderTop: '1px solid #333',
            }}>
              <div style={{
                fontSize: 13, fontWeight: 700, marginBottom: 6,
                color: gradeResult.score?.pass ? '#a6e3a1' : '#f38ba8',
              }}>
                {gradeResult.score?.pass ? 'PASSED' : gradeResult.status === 'error' ? 'Grading unavailable' : 'FAILED'}
              </div>
              {gradeResult.output && (
                <pre style={{
                  fontSize: 11, color: '#a6adc8', background: '#181825',
                  padding: 8, borderRadius: 4, maxHeight: 100, overflowY: 'auto',
                  whiteSpace: 'pre-wrap', margin: 0,
                }}>
                  {gradeResult.output.slice(-500)}
                </pre>
              )}
            </div>
          )}
        </div>

        {/* Center: File tree + Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex' }}>
          <div style={{ width: 200 }}>
            <FileTree files={files} selectedPath={selectedFile} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {currentFile ? (
                <CodeEditor
                  content={currentFile.content}
                  language={currentFile.language}
                  readOnly={!isActive || currentFile.readOnly}
                  onChange={isActive && !currentFile.readOnly ? v => onUpdateFile(currentFile.path, v) : undefined}
                />
              ) : (
                <div style={{ padding: 24, color: '#888' }}>Select a file to edit</div>
              )}
            </div>
            <div style={{ height: 180, borderTop: '1px solid #333' }}>
              <Terminal
                sessionId={session.sessionId}
                taskId={session.taskConfig.taskId}
                disabled={!isActive}
                onCommand={cmd => onLog('command_run', { command: cmd })}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
