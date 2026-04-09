import { useFirebaseSession } from './hooks/useFirebaseSession';
import { SAMPLE_TASK } from './data/sampleTask';
import { LobbyView } from './views/LobbyView';
import { PlannerView } from './views/PlannerView';
import { ExecutorView } from './views/ExecutorView';
import { VerifierView } from './views/VerifierView';
import { CompletedView } from './views/CompletedView';

export default function App() {
  const {
    sessionId,
    role,
    phase,
    messages,
    files,
    participants,
    startTime,
    endTime,
    joining,
    waitingForTeam,
    join,
    sendMessage,
    updateFile,
    setPhase,
    exportLogs,
    addLog,
  } = useFirebaseSession(SAMPLE_TASK);

  // Completed state
  if (phase === 'completed' && sessionId) {
    return (
      <CompletedView
        taskId={SAMPLE_TASK.taskId}
        startTime={startTime}
        endTime={endTime}
        onExportLogs={exportLogs}
      />
    );
  }

  // Lobby / Waiting
  if (!role || phase === 'lobby') {
    return (
      <LobbyView
        taskId={SAMPLE_TASK.taskId}
        onJoin={join}
        joining={joining}
        waitingForTeam={waitingForTeam}
        participants={participants}
      />
    );
  }

  // Build session-like object for views
  const session = {
    sessionId: sessionId!,
    taskConfig: SAMPLE_TASK,
    participants: Object.entries(participants).map(([r, p]) => ({
      id: r, name: p.name, role: r as any, joinedAt: p.joinedAt,
    })),
    messages,
    files,
    logs: [],
    phase,
    startTime,
    endTime,
  };

  const onSend = (to: any, content: string) => sendMessage(to, content);

  switch (role) {
    case 'planner':
      return (
        <PlannerView
          session={session}
          files={files}
          messages={messages}
          onSendMessage={onSend}
          onPhaseChange={setPhase}
          onLog={addLog}
        />
      );
    case 'executor':
      return (
        <ExecutorView
          session={session}
          files={files}
          messages={messages}
          onSendMessage={onSend}
          onUpdateFile={(path, content) => updateFile(path, content)}
          onPhaseChange={setPhase}
          onLog={addLog}
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
          onLog={addLog}
        />
      );
  }
}
