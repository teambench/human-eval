import { useState, useCallback, useEffect } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Terminal } from '../components/Terminal';
import { Timer } from '../components/Timer';
import { Resizer } from '../components/Resizer';
import { Onboarding, EXECUTOR_STEPS } from '../components/Onboarding';
import { useInitialWorkspace } from '../hooks/useInitialWorkspace';
import { SessionState, Role, FileEntry } from '../types';

interface ExecutorViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onUpdateFile: (path: string, content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
  onLeave: () => void;
  saveStatus?: 'idle' | 'saving' | 'saved' | 'error';
}

export function ExecutorView({ session, files, messages, onSendMessage, onUpdateFile, onPhaseChange, onLog, onLeave, saveStatus }: ExecutorViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(files.find(f => !f.readOnly)?.path ?? null);
  // Auto-pick the first editable file once files arrive. In team mode files
  // are fetched AFTER the component mounts (waiting for Executor's container
  // to come up), so the initializer above runs on an empty list and leaves
  // selectedFile=null. Without this effect the file tree could be populated
  // but the editor pane would just say "Select a file to edit" forever.
  useEffect(() => {
    if (selectedFile) return;
    const pick = files.find(f => !f.readOnly) ?? files[0];
    if (pick) setSelectedFile(pick.path);
  }, [files, selectedFile]);
  const [bottomTab, setBottomTab] = useState<'terminal' | 'brief'>('brief');

  // Resizable panel sizes
  const [fileTreeWidth, setFileTreeWidth] = useState(200);
  const [chatWidth, setChatWidth] = useState(340);
  const [terminalHeight, setTerminalHeight] = useState(200);

  // Progress flags — drive the phase-aware spotlight hints. Local state
  // is fine: if the participant reloads mid-task the hints simply re-appear
  // once, which is no worse than the initial onboarding cue.
  const [hasEdited, setHasEdited] = useState(false);
  const [hasRunCommand, setHasRunCommand] = useState(false);

  const currentFile = files.find(f => f.path === selectedFile);
  const canEdit = session.phase === 'execution';

  // Mark in the file tree which files the Executor has already touched —
  // gives them a running "progress indicator" of what they've edited
  // without having to remember. Uses the same post-staging snapshot the
  // Planner and Verifier subscribe to, so all three roles see a
  // consistent "●" dot on modified paths.
  const initialFiles = useInitialWorkspace(session.sessionId, true);
  const modifiedPaths = new Set(
    files
      .filter(f => initialFiles[f.path] == null || initialFiles[f.path] !== f.content)
      .map(f => f.path),
  );

  const needsEditAttention = canEdit && !hasEdited;
  const needsTerminalAttention = canEdit && !hasRunCommand;
  // Mark Done pulses for the entire execution phase. Previously gated on
  // hasEdited + hasRunCommand, which meant a participant who thought the
  // code was already correct (no edits needed) never saw the glow and
  // didn't know how to finish. Always-on while canEdit makes the
  // completion step unambiguous.
  const needsMarkDoneAttention = canEdit;

  const handleMarkDone = () => {
    onLog('mark_done');
    onPhaseChange('verification');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      <Onboarding steps={EXECUTOR_STEPS} storageKey={`onboarding_executor_${session.sessionId}`} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #f59e0b',
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
            background: '#f59e0b', color: '#000', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            EXECUTOR
          </span>
          <span style={{ color: '#cdd6f4', fontSize: 14 }}>
            {session.taskConfig.displayName ?? session.taskConfig.taskId} &middot; {session.taskConfig.difficulty}
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
              className={needsMarkDoneAttention ? 'tb-spotlight-strong' : undefined}
              style={{
                background: '#f59e0b', color: '#000', border: 'none', borderRadius: 4,
                padding: '6px 16px', cursor: 'pointer', fontWeight: 700, fontSize: 12,
                // The button background is amber (#f59e0b). An amber outline
                // would be invisible against it, so use white for contrast.
                ['--tb-spot-rgb' as any]: '255, 255, 255',
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
        <div
          className={needsEditAttention ? 'tb-spotlight' : undefined}
          style={{
            width: fileTreeWidth, minWidth: 140, maxWidth: 500,
            display: 'flex', flexDirection: 'column',
            ['--tb-spot-rgb' as any]: '245, 158, 11',
          }}
        >
          {needsEditAttention && (
            <div className="tb-spot-hint" style={{ ['--tb-spot-rgb' as any]: '245, 158, 11' }}>
              📝 Edit the files listed below
            </div>
          )}
          <div style={{ flex: 1, minHeight: 0 }}>
            <FileTree files={files} selectedPath={selectedFile} modifiedPaths={modifiedPaths} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
          </div>
        </div>

        <Resizer direction="horizontal" onResize={useCallback((d: number) => setFileTreeWidth(w => Math.max(140, Math.min(500, w + d))), [])} />

        {/* Center: Editor + Terminal */}
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          {/* Editor header with save-sync indicator */}
          {currentFile && (
            <div style={{
              padding: '4px 12px', background: '#181825', fontSize: 11, color: '#585b70',
              borderBottom: '1px solid #333', display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            }}>
              <span>{currentFile.path}{currentFile.readOnly && <span style={{marginLeft:8,color:'#6c7086'}}>(read-only)</span>}</span>
              {!currentFile.readOnly && canEdit && (
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

          {/* Phase-gating banner: explain WHY the editor is read-only when
              it's not because of the file itself. Without this, the Executor
              tries to type, Monaco silently refuses, and they assume the tool
              is broken. */}
          {!canEdit && session.phase === 'planning' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(99,102,241,0.12)',
              borderBottom: '1px solid rgba(99,102,241,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#a5b4fc' }}>Waiting for the Planner.</strong>{' '}
              The Planner is analyzing the spec and will post an execution plan via chat.
              You'll be able to edit files and use the terminal once they click <em>Submit Plan</em>.
              In the meantime, read the <em>Task Brief</em> tab and follow the chat.
            </div>
          )}
          {!canEdit && session.phase === 'verification' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(16,185,129,0.1)',
              borderBottom: '1px solid rgba(16,185,129,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#86efac' }}>Handed off to the Verifier.</strong>{' '}
              You marked the task done. The Verifier is reviewing. If they send it back, the editor will become
              writable again.
            </div>
          )}
          {/* Editor */}
          <div style={{ flex: 1, overflow: 'hidden' }}>
            {currentFile ? (
              <CodeEditor
                path={currentFile.path}
                content={currentFile.content}
                language={currentFile.language}
                readOnly={!canEdit || currentFile.readOnly}
                onChange={canEdit && !currentFile.readOnly ? v => { if (!hasEdited) setHasEdited(true); onUpdateFile(currentFile.path, v); } : undefined}
              />
            ) : (
              <div style={{ padding: 24, color: '#888' }}>
                {!canEdit && session.phase === 'planning'
                  ? 'Files will appear here once the Planner submits the plan.'
                  : 'Select a file to edit'}
              </div>
            )}
          </div>

          <Resizer direction="vertical" onResize={useCallback((d: number) => setTerminalHeight(h => Math.max(80, Math.min(500, h - d))), [])} />

          {/* Bottom panel: Terminal / Brief */}
          <div style={{ height: terminalHeight, minHeight: 80, display: 'flex', flexDirection: 'column' }}>
            <div style={{ display: 'flex', background: '#181825', borderBottom: '1px solid #333' }}>
              {(['brief', 'terminal'] as const).map(tab => {
                const highlight = tab === 'terminal' && needsTerminalAttention;
                return (
                  <button
                    key={tab}
                    onClick={() => setBottomTab(tab)}
                    className={highlight ? 'tb-spotlight' : undefined}
                    style={{
                      padding: '6px 16px', background: bottomTab === tab ? '#1e1e2e' : 'transparent',
                      color: bottomTab === tab ? '#cdd6f4' : '#888', border: 'none',
                      borderBottom: bottomTab === tab ? '2px solid #f59e0b' : '2px solid transparent',
                      cursor: 'pointer', fontSize: 12, fontWeight: 600, textTransform: 'capitalize',
                      ['--tb-spot-rgb' as any]: '245, 158, 11',
                    }}
                  >
                    {tab === 'brief' ? 'Task Brief' : 'Terminal'}
                  </button>
                );
              })}
            </div>
            <div style={{ flex: 1, overflow: 'hidden' }}>
              {bottomTab === 'brief' ? (
                <MarkdownViewer content={session.taskConfig.briefMd} />
              ) : (
                <Terminal
                  sessionId={session.sessionId}
                  taskId={session.taskConfig.taskId}
                  files={files.map(f => ({ path: f.path, content: f.content }))}
                  disabled={false}
                  onCommand={cmd => { if (!hasRunCommand) setHasRunCommand(true); onLog('command_run', { command: cmd }); }}
                />
              )}
            </div>
          </div>
        </div>

        <Resizer direction="horizontal" onResize={useCallback((d: number) => setChatWidth(w => Math.max(250, Math.min(500, w - d))), [])} />

        {/* Right: Chat */}
        <div style={{ width: chatWidth, minWidth: 250, maxWidth: 500 }}>
          <ChatPanel
            role="executor"
            messages={messages}
            onSend={onSendMessage}
            disabled={session.phase === 'lobby' || session.phase === 'completed'}
            systemNote={
              session.phase === 'planning'
                ? '💡 You are the Executor. The Planner is analyzing the task. You will get a plan from them here shortly — read it, then edit the files and run tests to implement it. You can ask clarifying questions in chat.'
                : session.phase === 'execution'
                ? '💡 Execute the Planner\'s plan: edit the files on the left, run tests in the Terminal tab, then click "Mark Done" in the header when finished.'
                : undefined
            }
          />
        </div>
      </div>
    </div>
  );
}
