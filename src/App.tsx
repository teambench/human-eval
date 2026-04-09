import { useState } from 'react';
import { Role } from './types';
import { useSession } from './hooks/useSession';
import { SAMPLE_TASK } from './data/sampleTask';
import { LobbyView } from './views/LobbyView';
import { PlannerView } from './views/PlannerView';
import { ExecutorView } from './views/ExecutorView';
import { VerifierView } from './views/VerifierView';
import { CompletedView } from './views/CompletedView';

export default function App() {
  const [role, setRole] = useState<Role | null>(null);
  const [_name, setName] = useState('');

  const {
    session,
    sendMessage,
    updateFile,
    setPhase,
    getVisibleFiles,
    getVisibleMessages,
    addLog,
    exportLogs,
  } = useSession(SAMPLE_TASK);

  const handleJoin = (selectedRole: Role, participantName: string) => {
    setRole(selectedRole);
    setName(participantName);
    addLog(selectedRole, 'join', { name: participantName });
    if (session.phase === 'lobby') {
      setPhase('planning');
    }
  };

  // Completed state
  if (session.phase === 'completed') {
    return (
      <CompletedView
        taskId={session.taskConfig.taskId}
        startTime={session.startTime}
        endTime={session.endTime}
        onExportLogs={exportLogs}
      />
    );
  }

  // Lobby
  if (!role) {
    return <LobbyView taskId={SAMPLE_TASK.taskId} onJoin={handleJoin} />;
  }

  // Role-specific views
  const files = getVisibleFiles(role);
  const messages = getVisibleMessages(role);
  const onSend = (to: Role | 'all', content: string) => sendMessage(role, to, content);
  const onLog = (action: string, detail?: Record<string, unknown>) => addLog(role, action, detail ?? {});

  switch (role) {
    case 'planner':
      return (
        <PlannerView
          session={session}
          files={files}
          messages={messages}
          onSendMessage={onSend}
          onPhaseChange={setPhase}
          onLog={onLog}
        />
      );
    case 'executor':
      return (
        <ExecutorView
          session={session}
          files={files}
          messages={messages}
          onSendMessage={onSend}
          onUpdateFile={(path, content) => updateFile(path, content, role)}
          onPhaseChange={setPhase}
          onLog={onLog}
        />
      );
    case 'verifier':
      return (
        <VerifierView
          session={session}
          files={files}
          messages={messages}
          onSendMessage={onSend}
          onPhaseChange={setPhase}
          onLog={onLog}
        />
      );
  }
}
