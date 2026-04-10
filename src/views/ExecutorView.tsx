import { useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { SessionState, Role, FileEntry } from '../types';

interface ExecutorViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onUpdateFile: (path: string, content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
}

export function ExecutorView({ session, files, messages, onSendMessage, onUpdateFile, onPhaseChange, onLog }: ExecutorViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files.find(f => !f.readOnly)?.path ?? null);
  const [bottomTab, setBottomTab] = useState<'terminal' | 'brief'>('brief');

  const currentFile = files.find(f => f.path === selectedFile);
  const canEdit = session.phase === 'execution';

  const handleMarkDone = () => {
    onLog('mark_done');
    onPhaseChange('verification');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #f59e0b',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            background: '#f59e0b', color: '#000', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            EXECUTOR
          </span>
          <span style={{ color: '#cdd6f4', fontSize: 14 }}>
            {session.taskConfig.taskId} &middot; {session.taskConfig.difficulty}
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
          {canEdit && (
            <button
              onClick={handleMarkDone}
              style={{
                background: '#f59e0b', color: '#000', border: 'none', borderRadius: 4,
                padding: '6px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 12,
              }}
            >
              Mark Done
            </button>
          )}
        </div>
      </div>

      {/* Main content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Left: File tree */}
        <div style={{ width: 200 }}>
          <FileTree files={files} selectedPath={selectedFile} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
        </div>

        {/* Center: Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Editor */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {currentFile ? (
              <CodeEditor
                content={currentFile.content}
                language={currentFile.language}
                readOnly={!canEdit || currentFile.readOnly}
                onChange={canEdit && !currentFile.readOnly ? v => onUpdateFile(currentFile.path, v) : undefined}
              />
            ) : (
              <div style={{ padding: 24, color: '#888' }}>Select a file to edit</div>
            )}
          </div>

          {/* Bottom panel: Terminal / Brief */}
          <div style={{ height: 200, borderTop: '1px solid #333', display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', background: '#181825', borderBottom: '1px solid #333' }}>
              {(['brief', 'terminal'] as const).map(tab => (
                <button
                  key={tab}
                  onClick={() => setBottomTab(tab)}
                  style={{
                    padding: '6px 16px', background: bottomTab === tab ? '#1e1e2e' : 'transparent',
                    color: bottomTab === tab ? '#cdd6f4' : '#888', border: 'none',
                    borderBottom: bottomTab === tab ? '2px solid #f59e0b' : '2px solid transparent',
                    cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                  }}
                >
                  {tab === 'brief' ? 'Task Brief' : 'Terminal'}
                </button>
              ))}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {bottomTab === 'brief' ? (
                <MarkdownViewer content={session.taskConfig.briefMd} />
              ) : (
                <Terminal
                  sessionId={session.sessionId}
                  taskId={session.taskConfig.taskId}
                  disabled={!canEdit}
                  onCommand={cmd => onLog('command_run', { command: cmd })}
                />
              )}
            </div>
          </div>
        </div>

        {/* Right: Chat */}
        <div style={{ width: 340, borderLeft: '1px solid #333' }}>
          <ChatPanel
            role="executor"
            messages={messages}
            onSend={onSendMessage}
            disabled={session.phase === 'lobby' || session.phase === 'completed'}
          />
        </div>
      </div>
    </div>
  );
}
