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
    join, sendMessage, updateFile, createFile, deleteFile, setPhase, exportLogs, leaveSession, addLog,
  } = useFirebaseSession();

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

  // ── Stale-bundle detection ─────────────────────────────────────────────
  // Every fresh page-load writes its build hash to localStorage. Any tab
  // whose baked-in __BUILD_HASH__ is older than that stored hash is on a
  // stale bundle (e.g. opened yesterday, never refreshed) — we want to
  // surface this because stale tabs silently write incomplete data when
  // they pre-date v2 logic. Soft warning only; never auto-reloads.
  const [staleBundle, setStaleBundle] = useState(false);
  useEffect(() => {
    const KEY = 'teambench_build_hash_v1';
    const my = __BUILD_HASH__;
    const check = () => {
      let stored: string | null = null;
      try { stored = localStorage.getItem(KEY); } catch { /* ignore */ }
      if (!stored || stored < my) {
        // We're as fresh or fresher — claim the canonical value.
        try { localStorage.setItem(KEY, my); } catch { /* ignore */ }
        setStaleBundle(false);
      } else if (stored > my) {
        setStaleBundle(true);
      }
    };
    check();
    // Listen for cross-tab updates so that opening a fresher tab anywhere
    // immediately surfaces the warning in this tab.
    window.addEventListener('storage', check);
    return () => window.removeEventListener('storage', check);
  }, []);

  const staleBundleBanner = staleBundle ? (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0,
      zIndex: 10001,
      background: '#f9e2af', color: '#1e1e2e',
      padding: '10px 16px', textAlign: 'center',
      fontSize: 13, fontWeight: 600,
      boxShadow: '0 2px 8px rgba(0,0,0,0.3)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
    }}>
      <span>A newer build has been deployed. This tab is on an outdated version — please refresh before joining a session, or your data may not be fully captured.</span>
      <button onClick={() => location.reload()} style={{
        padding: '6px 14px', background: '#1e1e2e', color: '#f9e2af',
        border: 'none', borderRadius: 4, cursor: 'pointer',
        fontSize: 12, fontWeight: 700,
      }}>Refresh now</button>
      <button onClick={() => setStaleBundle(false)} title="Dismiss this warning"
        style={{
          padding: '6px 10px', background: 'transparent', color: '#1e1e2e',
          border: '1px solid #1e1e2e', borderRadius: 4, cursor: 'pointer',
          fontSize: 12,
        }}>×</button>
    </div>
  ) : null;

  // Logger context — only meaningful once a session is fully joined. Idle/focus/raw-click
  // trackers no-op while ctx is null (lobby, onboarding).
  const loggerCtx: LoggerContextValue | null = (sessionId && role && task && pid)
    ? { taskId: task.taskId, mode, sessionId, pid, role }
    : null;
  const wrap = (children: ReactNode) => (
    <EventLoggerProvider value={loggerCtx}>
      <SessionTrackers />
      {staleBundleBanner}
      {children}
    </EventLoggerProvider>
  );

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
        onCreateFile={createFile}
        onDeleteFile={deleteFile}
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
          onCreateFile={createFile} onDeleteFile={deleteFile}
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
