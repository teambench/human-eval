import { useCallback, useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Timer } from '../components/Timer';
import { Resizer } from '../components/Resizer';
import { Onboarding, PLANNER_STEPS } from '../components/Onboarding';
import { useInitialWorkspace } from '../hooks/useInitialWorkspace';
import { SessionState, Role, FileEntry } from '../types';

interface PlannerViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
  onLeave: () => void;
}

export function PlannerView({ session, files, messages, onSendMessage, onPhaseChange, onLog, onLeave }: PlannerViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'spec' | 'files'>('spec');
  // Planner's file-list width is user-resizable. Task paths like
  // `scipy/spatial/transform/_rotation_cy.pyx` overrun the old fixed 200px.
  const [fileTreeWidth, setFileTreeWidth] = useState(260);
  // IMPORTANT: this useCallback MUST live at the top level of the component,
  // not inside the `activeTab === 'files'` branch of the JSX. A conditional
  // hook call (e.g. useCallback inside a ternary that only renders one side)
  // changes React's hook-call order between renders and throws on tab
  // switches — users reported clicking the Files tab blanked the page.
  const handleResize = useCallback(
    (d: number) => setFileTreeWidth(w => Math.max(140, Math.min(500, w + d))),
    [],
  );

  const currentFile = files.find(f => f.path === selectedFile);

  // Subscribe to the pre-execution snapshot so we can mark which files
  // the Executor has touched in the Files tab. Same source the Verifier
  // uses — populated by useFirebaseSession's fetchOnce on first staging.
  const initialFiles = useInitialWorkspace(session.sessionId, true);
  const modifiedPaths = new Set(
    files
      .filter(f => initialFiles[f.path] == null || initialFiles[f.path] !== f.content)
      .map(f => f.path),
  );

  // Chat is the Planner's primary action — drawing attention there is
  // more intuitive than glowing the Hand Off button (the button glow
  // made participants think "click this first" without writing a plan).
  // Derive from messages so reloads preserve state.
  const hasSentPlanMessage = messages.some((m: any) => m.from === 'planner');
  const needsChatAttention = session.phase === 'planning' && !hasSentPlanMessage;

  const handleSubmitPlan = () => {
    onLog('submit_plan');
    onPhaseChange('execution');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      <Onboarding steps={PLANNER_STEPS} storageKey={`onboarding_planner_${session.sessionId}`} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #6366f1',
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
            background: '#6366f1', color: '#fff', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            PLANNER
          </span>
          <span style={{ color: '#cdd6f4', fontSize: 14 }}>
            {session.taskConfig.displayName ?? session.taskConfig.taskId} &middot; {session.taskConfig.category} &middot; {session.taskConfig.difficulty}
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
            {(['spec', 'files'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => { onLog('tab_switch', { view: 'planner', from: activeTab, to: tab }); setActiveTab(tab); }}
                style={{
                  padding: '8px 20px', background: activeTab === tab ? '#1e1e2e' : 'transparent',
                  color: activeTab === tab ? '#cdd6f4' : '#888', border: 'none',
                  borderBottom: activeTab === tab ? '2px solid #6366f1' : '2px solid transparent',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize',
                }}
              >
                {tab === 'spec' ? 'Specification' : 'Files (Read-Only)'}
              </button>
            ))}
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
                <div style={{ flex: 1 }}>
                  {currentFile ? (
                    <CodeEditor path={currentFile.path} content={currentFile.content} language={currentFile.language} readOnly />
                  ) : (
                    <div style={{ padding: 24, color: '#888' }}>Select a file to view</div>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Submit Plan */}
          {session.phase === 'planning' && (
            <div style={{ padding: 12, background: '#1e1e2e', borderTop: '1px solid #333', textAlign: 'center' }}>
              <p style={{ color: '#6c7086', fontSize: 11, margin: '0 0 8px' }}>
                Share your analysis + plan via chat first, then click below to hand off to the Executor.
              </p>
              <button
                onClick={handleSubmitPlan}
                style={{
                  background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '10px 32px', cursor: 'pointer', fontWeight: 700, fontSize: 14,
                }}
              >
                Hand Off to Executor →
              </button>
            </div>
          )}
          {/* Phase-gating banner for post-planning phases so the Planner
              knows their active work is done and what to do next. */}
          {session.phase === 'execution' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(245,158,11,0.12)',
              borderTop: '1px solid rgba(245,158,11,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#fbbf24' }}>Executor is implementing.</strong>{' '}
              Your plan has been handed off. Answer follow-up questions via chat if the Executor gets stuck.
            </div>
          )}
          {session.phase === 'verification' && (
            <div style={{
              padding: '10px 14px', background: 'rgba(16,185,129,0.1)',
              borderTop: '1px solid rgba(16,185,129,0.3)',
              color: '#cdd6f4', fontSize: 12, lineHeight: 1.5,
            }}>
              <strong style={{ color: '#86efac' }}>Verifier is reviewing.</strong>{' '}
              The task is being graded. You can continue to chat if the Verifier flags something that needs discussion.
            </div>
          )}
        </div>

        {/* Right: Chat */}
        <div
          className={needsChatAttention ? 'tb-spotlight-strong' : undefined}
          style={{
            width: 340, borderLeft: '1px solid #333',
            display: 'flex', flexDirection: 'column',
            ['--tb-spot-rgb' as any]: '99, 102, 241',
          }}
        >
          <div style={{ flex: 1, minHeight: 0 }}>
            <ChatPanel
              role="planner"
              messages={messages}
              onSend={onSendMessage}
              disabled={session.phase === 'lobby' || session.phase === 'completed'}
              systemNote={
                session.phase === 'planning'
                  ? '💡 You are the Planner. Analyze the Specification on the left, then post your plan here. Your messages are the plan — the Executor will read them and implement the fix. Click "Hand Off to Executor →" below when your plan is complete.'
                  : undefined
              }
            />
          </div>
        </div>
      </div>
    </div>
  );
}
