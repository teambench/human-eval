import { useFirebaseSession } from './hooks/useFirebaseSession';
import { LobbyView } from './views/LobbyView';
import { PlannerView } from './views/PlannerView';
import { ExecutorView } from './views/ExecutorView';
import { VerifierView } from './views/VerifierView';
import { OracleView } from './views/OracleView';
import { CompletedView } from './views/CompletedView';

export default function App() {
  const {
    task, sessionId, role, mode, phase,
    messages, files, participants,
    startTime, endTime,
    joining, waitingForTeam,
    join, sendMessage, updateFile, setPhase, exportLogs, addLog,
  } = useFirebaseSession();

  // Completed
  if (phase === 'completed' && task && sessionId) {
    return (
      <CompletedView
        taskId={task.taskId}
        startTime={startTime}
        endTime={endTime}
        onExportLogs={exportLogs}
      />
    );
  }

  // Lobby / Waiting / Task selection
  if (!role || !task || phase === 'lobby') {
    return (
      <LobbyView
        onJoin={join}
        joining={joining}
        waitingForTeam={waitingForTeam}
        waitingSessionId={sessionId}
        participants={participants}
      />
    );
  }

  // Build session object for views
  const session = {
    sessionId: sessionId!,
    taskConfig: task,
    participants: Object.entries(participants).map(([r, p]) => ({
      id: r, name: p.name, role: r as any, joinedAt: p.joinedAt,
    })),
    messages, files, logs: [],
    phase, startTime, endTime,
    mode,
  };

  // Oracle view — single person, full access
  if (role === 'oracle') {
    return (
      <OracleView
        session={session}
        files={files}
        onUpdateFile={(path, content) => updateFile(path, content)}
        onPhaseChange={setPhase}
        onLog={addLog}
      />
    );
  }

  // Team views
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
