import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ref, push, set, get, update, onValue,
} from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, ChatMessage, FileEntry, TaskConfig, SessionState } from '../types';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function participantInfo(name: string) {
  return {
    name,
    joinedAt: Date.now(),
    userAgent: navigator.userAgent,
    screenSize: `${window.innerWidth}x${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ──────────────────────────────────────────────
// Matchmaking: find or create a team that needs this role
// ───────────────────────��──────────────────────
async function findOrCreateTeam(
  taskId: string,
  role: Role,
  name: string,
  taskMeta: { category: string; difficulty: string },
): Promise<{ sessionId: string; isNew: boolean }> {
  const waitingRef = ref(db, `teambench/waiting/${taskId}`);
  const snapshot = await get(waitingRef);

  if (snapshot.exists()) {
    const waiting = snapshot.val() as Record<string, {
      sessionId: string;
      roles: Record<string, boolean>;
    }>;

    // Find a team that doesn't have this role yet
    for (const [waitId, team] of Object.entries(waiting)) {
      if (!team.roles[role]) {
        // Join this team
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}/roles/${role}`), true);
        await set(ref(db, `teambench/sessions/${team.sessionId}/participants/${role}`), participantInfo(name));

        // Check if all 3 roles are now filled
        const updatedSnap = await get(ref(db, `teambench/waiting/${taskId}/${waitId}/roles`));
        const roles = updatedSnap.val();
        if (roles.planner && roles.executor && roles.verifier) {
          const startNow = Date.now();
          await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
          await update(ref(db, `teambench/sessions/${team.sessionId}`), {
            phase: 'planning',
            status: 'active',
            startTime: startNow,
            startTimeISO: new Date(startNow).toISOString(),
          });
        }

        return { sessionId: team.sessionId, isNew: false };
      }
    }
  }

  // No matching team found — create a new one
  const sessionId = `${taskId}_${generateId()}`;
  const now = Date.now();

  await set(ref(db, `teambench/sessions/${sessionId}`), {
    sessionId,
    taskId,
    mode: 'team',
    taskCategory: taskMeta.category,
    taskDifficulty: taskMeta.difficulty,
    experimentRound: 1,
    experimentGroup: 'pilot',
    phase: 'lobby',
    status: 'waiting',
    startTime: null,
    endTime: null,
    createdAt: now,
    createdAtISO: new Date(now).toISOString(),
    durationSeconds: null,
    phaseDurations: {},
    participants: { [role]: participantInfo(name) },
    verdict: null,
    remediationCount: 0,
  });

  await set(push(ref(db, `teambench/waiting/${taskId}`)), {
    sessionId,
    roles: { [role]: true },
  });

  return { sessionId, isNew: true };
}

// Oracle: always creates a new solo session, starts immediately
async function createOracleSession(
  taskId: string,
  name: string,
  taskMeta: { category: string; difficulty: string },
): Promise<string> {
  const sessionId = `${taskId}_oracle_${generateId()}`;
  const now = Date.now();

  await set(ref(db, `teambench/sessions/${sessionId}`), {
    sessionId,
    taskId,
    mode: 'oracle',
    taskCategory: taskMeta.category,
    taskDifficulty: taskMeta.difficulty,
    experimentRound: 1,
    experimentGroup: 'pilot',
    phase: 'execution',  // oracle starts working immediately
    status: 'active',
    startTime: now,
    startTimeISO: new Date(now).toISOString(),
    endTime: null,
    createdAt: now,
    createdAtISO: new Date(now).toISOString(),
    durationSeconds: null,
    phaseDurations: {},
    participants: { oracle: participantInfo(name) },
    verdict: null,
    remediationCount: 0,
  });

  return sessionId;
}

// ──────────────────────────────────────────────
// Main hook — now accepts task dynamically
// ��─────────────────��───────────────────────────
export function useFirebaseSession() {
  const [task, setTask] = useState<TaskConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [mode, setMode] = useState<SessionMode>('team');
  const [phase, setPhaseState] = useState<SessionState['phase']>('lobby');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [participants, setParticipants] = useState<Record<string, { name: string; joinedAt: number }>>({});
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [joining, setJoining] = useState(false);
  const [waitingForTeam, setWaitingForTeam] = useState(false);

  // Subscribe to session changes
  useEffect(() => {
    if (!sessionId) return;
    const unsubs: (() => void)[] = [];

    unsubs.push(onValue(ref(db, `teambench/sessions/${sessionId}`), (snap) => {
      if (!snap.exists()) return;
      const data = snap.val();
      setPhaseState(data.phase || 'lobby');
      setParticipants(data.participants || {});
      setStartTime(data.startTime || null);
      setEndTime(data.endTime || null);
      if (data.phase !== 'lobby') setWaitingForTeam(false);
    }));

    unsubs.push(onValue(ref(db, `teambench/sessions/${sessionId}/messages`), (snap) => {
      if (!snap.exists()) { setMessages([]); return; }
      const msgs: ChatMessage[] = Object.values(snap.val());
      msgs.sort((a, b) => a.timestamp - b.timestamp);
      setMessages(msgs);
    }));

    unsubs.push(onValue(ref(db, `teambench/sessions/${sessionId}/files`), (snap) => {
      if (!snap.exists()) return;
      const data = snap.val() as Record<string, { content: string }>;
      setFiles(prev => prev.map(f => {
        const key = f.path.replace(/[.\/\[\]#$]/g, '_');
        return data[key] ? { ...f, content: data[key].content } : f;
      }));
    }));

    return () => unsubs.forEach(u => u());
  }, [sessionId]);

  // Join a session
  const join = useCallback(async (selectedTask: TaskConfig, selectedRole: Role, selectedMode: SessionMode, name: string) => {
    setJoining(true);
    setTask(selectedTask);
    setMode(selectedMode);
    setFiles(selectedTask.files.map(f => ({ ...f })));

    try {
      // Check localStorage for resume
      const storageKey = `teambench_session_${selectedTask.taskId}_${selectedRole}_${selectedMode}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const { sessionId: savedId } = JSON.parse(saved);
        const snap = await get(ref(db, `teambench/sessions/${savedId}`));
        if (snap.exists() && snap.val().phase !== 'completed') {
          setSessionId(savedId);
          setRole(selectedRole);
          addLog(savedId, selectedRole, 'resume', { name });
          setJoining(false);
          return;
        }
      }

      let newSessionId: string;
      let isNew = false;
      const taskMeta = { category: selectedTask.category, difficulty: selectedTask.difficulty };

      if (selectedMode === 'oracle') {
        newSessionId = await createOracleSession(selectedTask.taskId, name, taskMeta);
        isNew = true;
      } else {
        const result = await findOrCreateTeam(selectedTask.taskId, selectedRole, name, taskMeta);
        newSessionId = result.sessionId;
        isNew = result.isNew;
      }

      setSessionId(newSessionId);
      setRole(selectedRole);

      localStorage.setItem(
        `teambench_session_${selectedTask.taskId}_${selectedRole}_${selectedMode}`,
        JSON.stringify({ sessionId: newSessionId })
      );

      // Initialize files for new sessions
      if (isNew) {
        const filesData: Record<string, { content: string; language: string }> = {};
        for (const f of selectedTask.files) {
          const key = f.path.replace(/[.\/\[\]#$]/g, '_');
          filesData[key] = { content: f.content, language: f.language };
        }
        await set(ref(db, `teambench/sessions/${newSessionId}/files`), filesData);
      }

      if (isNew && selectedMode === 'team') {
        setWaitingForTeam(true);
      }

      addLog(newSessionId, selectedRole, 'join', { name, mode: selectedMode });
    } catch (err) {
      console.error('Join error:', err);
    }
    setJoining(false);
  }, []);

  const sendMessage = useCallback(async (to: Role | 'all', content: string) => {
    if (!sessionId || !role) return;
    const msg: ChatMessage = { id: generateId(), from: role, to, content, timestamp: Date.now() };
    await push(ref(db, `teambench/sessions/${sessionId}/messages`), msg);
    addLog(sessionId, role, 'chat_send', { to, contentLength: content.length });
  }, [sessionId, role]);

  const updateFile = useCallback(async (path: string, content: string) => {
    if (!sessionId || !role) return;
    const key = path.replace(/[.\/\[\]#$]/g, '_');
    await update(ref(db, `teambench/sessions/${sessionId}/files/${key}`), { content });
    addLog(sessionId, role, 'file_edit', { path, contentLength: content.length });
  }, [sessionId, role]);

  const setPhase = useCallback(async (newPhase: SessionState['phase']) => {
    if (!sessionId || !role) return;
    const now = Date.now();
    const updates: Record<string, unknown> = { phase: newPhase };
    updates[`phaseDurations/${phase}_to_${newPhase}`] = now;

    if (newPhase === 'completed') {
      updates.endTime = now;
      updates.endTimeISO = new Date(now).toISOString();
      updates.status = 'completed';
      if (startTime) updates.durationSeconds = Math.round((now - startTime) / 1000);
    } else {
      updates.status = 'active';
    }

    if (role === 'verifier' && phase === 'verification') {
      if (newPhase === 'execution') {
        updates.verdict = 'fail';
        const rc = (await get(ref(db, `teambench/sessions/${sessionId}/remediationCount`))).val();
        updates.remediationCount = (rc || 0) + 1;
      } else if (newPhase === 'completed') {
        updates.verdict = 'pass';
      }
    }

    await update(ref(db, `teambench/sessions/${sessionId}`), updates);
    addLog(sessionId, role, 'phase_change', { from: phase, to: newPhase });
  }, [sessionId, role, phase, startTime]);

  const getVisibleMessages = useCallback((): ChatMessage[] => {
    if (!role) return [];
    if (role === 'oracle') return messages; // oracle sees all
    return messages.filter(m => m.to === 'all' || m.from === role || m.to === role);
  }, [messages, role]);

  const getVisibleFiles = useCallback((): FileEntry[] => {
    if (!role) return [];
    if (role === 'oracle' || role === 'executor') {
      return files.map(f => ({ ...f })); // can edit non-readOnly files
    }
    return files.map(f => ({ ...f, readOnly: true }));
  }, [files, role]);

  const exportLogs = useCallback(async () => {
    if (!sessionId || !task) return;
    const snap = await get(ref(db, `teambench/sessions/${sessionId}`));
    if (!snap.exists()) return;
    const data = snap.val();
    const logsSnap = await get(ref(db, `teambench/sessions/${sessionId}/logs`));
    const logs = logsSnap.exists() ? Object.values(logsSnap.val()) : [];

    const exportData = {
      sessionId, taskId: task.taskId,
      taskCategory: data.taskCategory || task.category,
      taskDifficulty: data.taskDifficulty || task.difficulty,
      mode: data.mode || mode,
      experimentRound: data.experimentRound || 1,
      experimentGroup: data.experimentGroup || 'pilot',
      phase: data.phase, status: data.status,
      verdict: data.verdict, remediationCount: data.remediationCount || 0,
      startTime: data.startTime, endTime: data.endTime,
      durationSeconds: data.durationSeconds,
      phaseDurations: data.phaseDurations || {},
      createdAt: data.createdAt,
      exportedAt: Date.now(), exportedAtISO: new Date().toISOString(),
      participants: data.participants,
      messages, logs,
      finalFiles: files.map(f => ({ path: f.path, content: f.content })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teambench_${task.taskId}_${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionId, task, mode, messages, files]);

  return {
    task, sessionId, role, mode, phase,
    messages: getVisibleMessages(),
    files: getVisibleFiles(),
    participants, startTime, endTime,
    joining, waitingForTeam,
    join, sendMessage, updateFile, setPhase, exportLogs,
    addLog: (action: string, detail?: Record<string, unknown>) => {
      if (sessionId && role) addLog(sessionId, role, action, detail ?? {});
    },
  };
}

function addLog(sessionId: string, role: Role, action: string, detail: Record<string, unknown>) {
  const now = Date.now();
  push(ref(db, `teambench/sessions/${sessionId}/logs`), {
    id: generateId(), sessionId, role, action, detail,
    timestamp: now, timestampISO: new Date(now).toISOString(),
  });
}
