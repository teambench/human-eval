import { useState } from 'react';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal } from '../components/Terminal';
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
  const [bottomTab, setBottomTab] = useState<'terminal' | 'none'>('terminal');
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  const [notes, setNotes] = useState('');

  const currentFile = files.find(f => f.path === selectedFile);
  const isActive = session.phase !== 'lobby' && session.phase !== 'completed';

  const handleComplete = () => {
    onLog('oracle_submit', { verdict, notes });
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

          {/* Verdict panel */}
          {isActive && (
            <div style={{ padding: 12, background: '#1e1e2e', borderTop: '1px solid #333' }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#cdd6f4', marginBottom: 8 }}>
                Self-Assessment
              </div>
              <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                <button
                  onClick={() => setVerdict('pass')}
                  style={{
                    flex: 1, padding: '6px', border: '2px solid',
                    borderColor: verdict === 'pass' ? '#10b981' : '#555',
                    background: verdict === 'pass' ? '#10b98133' : 'transparent',
                    color: '#10b981', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12,
                  }}
                >
                  PASS
                </button>
                <button
                  onClick={() => setVerdict('fail')}
                  style={{
                    flex: 1, padding: '6px', border: '2px solid',
                    borderColor: verdict === 'fail' ? '#f38ba8' : '#555',
                    background: verdict === 'fail' ? '#f38ba833' : 'transparent',
                    color: '#f38ba8', borderRadius: 6, cursor: 'pointer', fontWeight: 700, fontSize: 12,
                  }}
                >
                  FAIL
                </button>
              </div>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                placeholder="Notes on your solution..."
                style={{
                  width: '100%', height: 50, background: '#313244', color: '#cdd6f4',
                  border: '1px solid #555', borderRadius: 4, padding: 6, fontSize: 12,
                  resize: 'vertical', fontFamily: 'inherit', boxSizing: 'border-box',
                }}
              />
              <button
                onClick={handleComplete}
                style={{
                  marginTop: 6, width: '100%', background: '#cba6f7', color: '#fff',
                  border: 'none', borderRadius: 6, padding: '8px', cursor: 'pointer',
                  fontWeight: 700, fontSize: 13,
                }}
              >
                Submit & Complete
              </button>
            </div>
          )}
        </div>

        {/* Center: File tree + Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex' }}>
          {/* File tree */}
          <div style={{ width: 200 }}>
            <FileTree files={files} selectedPath={selectedFile} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
          </div>

          {/* Editor + Terminal */}
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
