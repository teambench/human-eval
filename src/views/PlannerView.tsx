import { useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Timer } from '../components/Timer';
import { SessionState, Role, FileEntry } from '../types';

interface PlannerViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
}

export function PlannerView({ session, files, messages, onSendMessage, onPhaseChange, onLog }: PlannerViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'spec' | 'files'>('spec');

  const currentFile = files.find(f => f.path === selectedFile);

  const handleSubmitPlan = () => {
    onLog('submit_plan');
    onPhaseChange('execution');
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#11111b' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between',
        padding: '8px 16px', background: '#1e1e2e', borderBottom: '2px solid #6366f1',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{
            background: '#6366f1', color: '#fff', padding: '4px 12px',
            borderRadius: 4, fontWeight: 700, fontSize: 13,
          }}>
            PLANNER
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
            {(['spec', 'files'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
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
                <div style={{ width: 200 }}>
                  <FileTree files={files} selectedPath={selectedFile} onSelect={p => { setSelectedFile(p); onLog('file_open', { path: p }); }} />
                </div>
                <div style={{ flex: 1 }}>
                  {currentFile ? (
                    <CodeEditor content={currentFile.content} language={currentFile.language} readOnly />
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
              <button
                onClick={handleSubmitPlan}
                style={{
                  background: '#6366f1', color: '#fff', border: 'none', borderRadius: 6,
                  padding: '10px 32px', cursor: 'pointer', fontWeight: 700, fontSize: 14,
                }}
              >
                Submit Plan & Advance to Execution
              </button>
            </div>
          )}
        </div>

        {/* Right: Chat */}
        <div style={{ width: 340, borderLeft: '1px solid #333' }}>
          <ChatPanel
            role="planner"
            messages={messages}
            onSend={onSendMessage}
            disabled={session.phase === 'lobby' || session.phase === 'completed'}
          />
        </div>
      </div>
    </div>
  );
}
