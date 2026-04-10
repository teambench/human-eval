import { useState } from 'react';
import { ChatPanel } from '../components/ChatPanel';
import { MarkdownViewer } from '../components/MarkdownViewer';
import { FileTree } from '../components/FileTree';
import { CodeEditor } from '../components/CodeEditor';
import { Timer } from '../components/Timer';
import { Onboarding, VERIFIER_STEPS } from '../components/Onboarding';
import { SessionState, Role, FileEntry } from '../types';

interface VerifierViewProps {
  session: SessionState;
  files: FileEntry[];
  messages: ReturnType<typeof Array<any>>;
  onSendMessage: (to: Role | 'all', content: string) => void;
  onPhaseChange: (phase: SessionState['phase']) => void;
  onLog: (action: string, detail?: Record<string, unknown>) => void;
}

export function VerifierView({ session, files, messages, onSendMessage, onPhaseChange, onLog }: VerifierViewProps) {
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'spec' | 'files'>('spec');
  const [verdict, setVerdict] = useState<'pass' | 'fail' | ''>('');
  const [notes, setNotes] = useState('');

  const currentFile = files.find(f => f.path === selectedFile);
  const canVerify = session.phase === 'verification';

  const handleSubmitVerdict = () => {
    if (!verdict) return;
    onLog('submit_verdict', { verdict, notes });
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
            {(['spec', 'files'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                style={{
                  padding: '8px 20px', background: activeTab === tab ? '#1e1e2e' : 'transparent',
                  color: activeTab === tab ? '#cdd6f4' : '#888', border: 'none',
                  borderBottom: activeTab === tab ? '2px solid #10b981' : '2px solid transparent',
                  cursor: 'pointer', fontSize: 13, fontWeight: 600, textTransform: 'capitalize',
                }}
              >
                {tab === 'spec' ? 'Specification' : 'Workspace (Read-Only)'}
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

          {/* Verdict panel */}
          {canVerify && (
            <div style={{
              padding: 16, background: '#1e1e2e', borderTop: '1px solid #333',
            }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#cdd6f4', marginBottom: 8 }}>
                Submit Verification Verdict
              </div>
              <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
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
                style={{
                  marginTop: 8, background: verdict ? '#10b981' : '#555', color: '#000',
                  border: 'none', borderRadius: 6, padding: '10px 32px', cursor: verdict ? 'pointer' : 'not-allowed',
                  fontWeight: 700, fontSize: 14,
                }}
              >
                {verdict === 'fail' ? 'Send Back to Executor' : 'Submit & Complete'}
              </button>
            </div>
          )}
        </div>

        {/* Right: Chat */}
        <div style={{ width: 340, borderLeft: '1px solid #333' }}>
          <ChatPanel
            role="verifier"
            messages={messages}
            onSend={onSendMessage}
            disabled={session.phase === 'lobby' || session.phase === 'completed'}
          />
        </div>
      </div>
    </div>
  );
}
