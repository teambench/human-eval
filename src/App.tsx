import { useState, useEffect, ReactNode } from 'react';
import { useFirebaseSession } from './hooks/useFirebaseSession';
import { LobbyView } from './views/LobbyView';
import { PlannerView } from './views/PlannerView';
import { ExecutorView } from './views/ExecutorView';
import { VerifierView } from './views/VerifierView';
import { OracleView } from './views/OracleView';
import { CompletedView } from './views/CompletedView';
import { SurveyView } from './views/SurveyView';
import { registerSessionCleanup } from './components/Terminal';
import { getRegion, getHostSync, setRegion, REGIONS, RegionId } from './lib/regionRouter';
import { EventLoggerProvider, SessionTrackers, LoggerContextValue } from './lib/eventLogger';

export default function App() {
  const {
    task, sessionId, role, mode, pid, phase,
    messages, files, participants,
    startTime, endTime,
    joining, waitingForTeam, saveStatus,
    join, sendMessage, updateFile, setPhase, exportLogs, leaveSession, addLog,
  } = useFirebaseSession();

  // Logger context — only meaningful once a session is fully joined. Idle/focus/raw-click
  // trackers no-op while ctx is null (lobby, onboarding).
  const loggerCtx: LoggerContextValue | null = (sessionId && role && task && pid)
    ? { taskId: task.taskId, mode, sessionId, pid, role }
    : null;
  const wrap = (children: ReactNode) => (
    <EventLoggerProvider value={loggerCtx}>
      <SessionTrackers />
      {children}
    </EventLoggerProvider>
  );

  // Confirmation wrapper: guards against accidental clicks on Back.
  // Team mode additionally warns about cancelling for teammates.
  const confirmLeave = () => {
    const msg = mode === 'team'
      ? 'Leave this task? Your teammate will see the session as cancelled.'
      : 'Leave this task? Unsaved progress will be lost.';
    if (window.confirm(msg)) leaveSession();
  };

  const [surveyCompleted, setSurveyCompleted] = useState(false);

  // Free the container slot when the participant closes the tab or navigates
  // away. Without this, orphaned sessions linger for CONTAINER_TIMEOUT=1h
  // and can exhaust MAX_CONTAINERS=20 during the study.
  useEffect(() => {
    if (!sessionId) return;
    return registerSessionCleanup(sessionId);
  }, [sessionId]);

  // Kick off region auto-detect on first load. Most users never see the
  // picker; this just ensures the cached region is set so subsequent
  // fetches / WebSocket opens use the nearer backend.
  const [currentRegion, setCurrentRegion] = useState<RegionId>(
    (localStorage.getItem('teambench_region_v1') as RegionId) || 'sgp'
  );
  useEffect(() => { getRegion().then(setCurrentRegion); }, []);

  // Floating region badge — top-center of the viewport. Earlier positions
  // (bottom-right, bottom-left) overlapped with chat Send buttons and the
  // Resizer handles of the three-pane role views. Top-center is clear
  // across every view: the headers have left-aligned role badges and
  // right-aligned Timer+Phase, nothing in the middle.
  const regionBadge = (
    <div style={{
      position: 'fixed', top: 6, left: '50%', transform: 'translateX(-50%)',
      zIndex: 9999,
      background: '#1e1e2e', color: '#cdd6f4',
      border: '1px solid #313244', borderRadius: 6,
      padding: '2px 8px', fontSize: 10, fontFamily: 'monospace',
      display: 'flex', alignItems: 'center', gap: 6,
      boxShadow: '0 2px 4px rgba(0,0,0,0.3)',
      opacity: 0.9,
    }}>
      <span title="Backend server (auto-detected; lower-latency region wins)">
        {REGIONS[currentRegion].label}
      </span>
      <select
        value={currentRegion}
        onChange={e => setRegion(e.target.value as RegionId)}
        title="Switch backend region (reloads page)"
        style={{
          background: '#313244', color: '#cdd6f4', border: 'none',
          borderRadius: 3, fontSize: 10, padding: '2px 4px', cursor: 'pointer',
        }}
      >
        <option value="sgp">sgp</option>
        <option value="nyc">nyc</option>
      </select>
    </div>
  );

  // Completed — show survey first, then completion screen
  if (phase === 'completed' && task && sessionId && role) {
    if (!surveyCompleted) {
      return wrap(
        <>{regionBadge}
          <SurveyView
            sessionId={sessionId}
            taskId={task.taskId}
            role={role}
            mode={mode}
            pid={pid || ''}
            participants={participants}
            onComplete={() => setSurveyCompleted(true)}
          /></>
      );
    }
    return wrap(
      <>{regionBadge}<CompletedView
        taskId={task.taskId}
        startTime={startTime}
        endTime={endTime}
        onExportLogs={exportLogs}
      /></>
    );
  }

  // Lobby / Waiting / Task selection
  if (!role || !task || phase === 'lobby') {
    return wrap(
      <>{regionBadge}<LobbyView
        onJoin={(selectedTask, selectedRole, selectedMode, name, profile) =>
          join(selectedTask, selectedRole, selectedMode, name, profile)
        }
        joining={joining}
        waitingForTeam={waitingForTeam}
        waitingSessionId={sessionId}
        participants={participants}
      /></>
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
    return wrap(
      <>{regionBadge}<OracleView
        session={session}
        files={files}
        onUpdateFile={(path, content) => updateFile(path, content)}
        onPhaseChange={setPhase}
        onLog={addLog}
        onLeave={confirmLeave}
        saveStatus={saveStatus}
      /></>
    );
  }

  const onSend = (to: any, content: string) => sendMessage(to, content);

  switch (role) {
    case 'planner':
      return wrap(
        <>{regionBadge}<PlannerView session={session} files={files} messages={messages}
          onSendMessage={onSend} onPhaseChange={setPhase} onLog={addLog}
          onLeave={confirmLeave} /></>
      );
    case 'executor':
      return wrap(
        <>{regionBadge}<ExecutorView session={session} files={files} messages={messages}
          onSendMessage={onSend} onUpdateFile={(p, c) => updateFile(p, c)}
          onPhaseChange={setPhase} onLog={addLog} onLeave={confirmLeave}
          saveStatus={saveStatus} /></>
      );
    case 'verifier':
      return wrap(
        <>{regionBadge}<VerifierView session={session} files={files} messages={messages}
          onSendMessage={onSend} onPhaseChange={setPhase} onLog={addLog}
          onLeave={confirmLeave} /></>
      );
  }
}
