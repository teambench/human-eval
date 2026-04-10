import { useState } from 'react';
import { useFirebaseSession } from './hooks/useFirebaseSession';
import { LobbyView } from './views/LobbyView';
import { PlannerView } from './views/PlannerView';
import { ExecutorView } from './views/ExecutorView';
import { VerifierView } from './views/VerifierView';
import { OracleView } from './views/OracleView';
import { CompletedView } from './views/CompletedView';
import { SurveyView } from './views/SurveyView';

export default function App() {
  const {
    task, sessionId, role, mode, phase,
    messages, files, participants,
    startTime, endTime,
    joining, waitingForTeam,
    join, sendMessage, updateFile, setPhase, exportLogs, addLog,
  } = useFirebaseSession();

  const [surveyCompleted, setSurveyCompleted] = useState(false);

  // Completed — show survey first, then completion screen
  if (phase === 'completed' && task && sessionId && role) {
    if (!surveyCompleted) {
      return (
        <SurveyView
          sessionId={sessionId}
          taskId={task.taskId}
          role={role}
          mode={mode}
          participants={participants}
          onComplete={() => setSurveyCompleted(true)}
        />
      );
    }
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
        onJoin={(selectedTask, selectedRole, selectedMode, name, profile) =>
          join(selectedTask, selectedRole, selectedMode, name, profile)
        }
        joining={joining}
        waitingForTeam={waitingForTeam}
        waitingSessionId={sessionId}
        participants={participants}
      />
    );
  }

  const session = {
    sessionId: sessionId!,
    taskConfig: task,
    participants: Object.entries(participants).map(([r, p]) => ({
      id: r, name: p.name, role: r as any, joinedAt: p.joinedAt,
    })),
    messages, files, logs: [],
    phase, startTime, endTime, mode,
  };

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

  const onSend = (to: any, content: string) => sendMessage(to, content);

  switch (role) {
    case 'planner':
      return (
        <PlannerView session={session} files={files} messages={messages}
          onSendMessage={onSend} onPhaseChange={setPhase} onLog={addLog} />
      );
    case 'executor':
      return (
        <ExecutorView session={session} files={files} messages={messages}
          onSendMessage={onSend} onUpdateFile={(p, c) => updateFile(p, c)}
          onPhaseChange={setPhase} onLog={addLog} />
      );
    case 'verifier':
      return (
        <VerifierView session={session} files={files} messages={messages}
          onSendMessage={onSend} onPhaseChange={setPhase} onLog={addLog} />
      );
  }
}
