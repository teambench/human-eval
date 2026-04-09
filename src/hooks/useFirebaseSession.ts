import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ref, push, set, get, update, onValue, onChildAdded,
  query, orderByChild, equalTo, serverTimestamp,
  runTransaction,
} from 'firebase/database';
import { db } from '../firebase';
import { Role, ChatMessage, FileEntry, ActionLog, TaskConfig, SessionState } from '../types';

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

// ──────────────────────────────────────────────
// Matchmaking: find or create a team that needs this role
// ──────────────────────────────────────────────
function participantInfo(name: string) {
  return {
    name,
    joinedAt: Date.now(),
    userAgent: navigator.userAgent,
    screenSize: `${window.innerWidth}x${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

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
        const teamRef = ref(db, `teambench/waiting/${taskId}/${waitId}/roles/${role}`);
        await set(teamRef, true);

        // Add participant to the session
        const participantRef = ref(db, `teambench/sessions/${team.sessionId}/participants/${role}`);
        await set(participantRef, participantInfo(name));

        // Check if all 3 roles are now filled
        const updatedSnap = await get(ref(db, `teambench/waiting/${taskId}/${waitId}/roles`));
        const roles = updatedSnap.val();
        if (roles.planner && roles.executor && roles.verifier) {
          // Team complete — remove from waiting, start session
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

  // Create the session with rich metadata for clear labeling
  await set(ref(db, `teambench/sessions/${sessionId}`), {
    // Identity
    sessionId,
    taskId,
    // Task metadata (for filtering/grouping in DB without needing task config)
    taskCategory: taskMeta?.category || '',
    taskDifficulty: taskMeta?.difficulty || '',
    // Experiment labeling
    experimentRound: 1,     // increment for each experiment batch
    experimentGroup: 'pilot', // 'pilot' | 'main' | 'followup'
    // State
    phase: 'lobby',
    status: 'waiting',       // 'waiting' | 'active' | 'completed' | 'abandoned'
    // Timing
    startTime: null,
    endTime: null,
    createdAt: now,
    createdAtISO: new Date(now).toISOString(),
    // Duration tracking (filled on completion)
    durationSeconds: null,
    planningDurationSeconds: null,
    executionDurationSeconds: null,
    verificationDurationSeconds: null,
    // Participants
    participants: {
      [role]: participantInfo(name),
    },
    // Outcome (filled on completion)
    verdict: null,            // 'pass' | 'fail' | null
    remediationCount: 0,
  });

  // Add to waiting queue
  const waitRef = push(ref(db, `teambench/waiting/${taskId}`));
  await set(waitRef, {
    sessionId,
    roles: { [role]: true },
  });

  return { sessionId, isNew: true };
}

// ──────────────────────────────────────────────
// Main hook
// ──────────────────────────────────────────────
export function useFirebaseSession(task: TaskConfig) {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [phase, setPhaseState] = useState<SessionState['phase']>('lobby');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<FileEntry[]>(task.files.map(f => ({ ...f })));
  const [participants, setParticipants] = useState<Record<string, { name: string; joinedAt: number }>>({});
  const [startTime, setStartTime] = useState<number | null>(null);
  const [endTime, setEndTime] = useState<number | null>(null);
  const [joining, setJoining] = useState(false);
  const [waitingForTeam, setWaitingForTeam] = useState(false);

  const unsubscribesRef = useRef<(() => void)[]>([]);

  // Subscribe to session changes
  useEffect(() => {
    if (!sessionId) return;

    const unsubs: (() => void)[] = [];

    // Listen to session metadata (phase, participants, times)
    const sessionRef = ref(db, `teambench/sessions/${sessionId}`);
    unsubs.push(onValue(sessionRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.val();
      setPhaseState(data.phase || 'lobby');
      setParticipants(data.participants || {});
      setStartTime(data.startTime || null);
      setEndTime(data.endTime || null);
      if (data.phase !== 'lobby') {
        setWaitingForTeam(false);
      }
    }));

    // Listen to messages
    const messagesRef = ref(db, `teambench/sessions/${sessionId}/messages`);
    unsubs.push(onValue(messagesRef, (snap) => {
      if (!snap.exists()) {
        setMessages([]);
        return;
      }
      const data = snap.val();
      const msgs: ChatMessage[] = Object.values(data);
      msgs.sort((a, b) => a.timestamp - b.timestamp);
      setMessages(msgs);
    }));

    // Listen to file changes
    const filesRef = ref(db, `teambench/sessions/${sessionId}/files`);
    unsubs.push(onValue(filesRef, (snap) => {
      if (!snap.exists()) return;
      const data = snap.val() as Record<string, { content: string }>;
      setFiles(prev => prev.map(f => {
        const key = f.path.replace(/[.\/\[\]#$]/g, '_');
        if (data[key]) {
          return { ...f, content: data[key].content };
        }
        return f;
      }));
    }));

    unsubscribesRef.current = unsubs;
    return () => unsubs.forEach(u => u());
  }, [sessionId]);

  // Join a session
  const join = useCallback(async (selectedRole: Role, name: string) => {
    setJoining(true);
    try {
      // Check localStorage for existing session
      const savedSession = localStorage.getItem(`teambench_session_${task.taskId}_${selectedRole}`);
      if (savedSession) {
        const { sessionId: savedId } = JSON.parse(savedSession);
        const snap = await get(ref(db, `teambench/sessions/${savedId}`));
        if (snap.exists()) {
          const data = snap.val();
          if (data.phase !== 'completed') {
            // Resume existing session
            setSessionId(savedId);
            setRole(selectedRole);
            addLog(savedId, selectedRole, 'resume', { name });
            setJoining(false);
            return;
          }
        }
      }

      // Find or create a team
      const { sessionId: newSessionId, isNew } = await findOrCreateTeam(
        task.taskId, selectedRole, name,
        { category: task.category, difficulty: task.difficulty },
      );
      setSessionId(newSessionId);
      setRole(selectedRole);

      // Save to localStorage for resume
      localStorage.setItem(
        `teambench_session_${task.taskId}_${selectedRole}`,
        JSON.stringify({ sessionId: newSessionId })
      );

      // Initialize files if this is a new session
      if (isNew) {
        const filesData: Record<string, { content: string; language: string }> = {};
        for (const f of task.files) {
          const key = f.path.replace(/[.\/\[\]#$]/g, '_');
          filesData[key] = { content: f.content, language: f.language };
        }
        await set(ref(db, `teambench/sessions/${newSessionId}/files`), filesData);
      }

      if (isNew) {
        setWaitingForTeam(true);
      }

      addLog(newSessionId, selectedRole, 'join', { name });
    } catch (err) {
      console.error('Join error:', err);
    }
    setJoining(false);
  }, [task]);

  // Send a chat message
  const sendMessage = useCallback(async (to: Role | 'all', content: string) => {
    if (!sessionId || !role) return;
    const msg: ChatMessage = {
      id: generateId(),
      from: role,
      to,
      content,
      timestamp: Date.now(),
    };
    await push(ref(db, `teambench/sessions/${sessionId}/messages`), msg);
    addLog(sessionId, role, 'chat_send', { to, contentLength: content.length });
  }, [sessionId, role]);

  // Update a file (executor only)
  const updateFile = useCallback(async (path: string, content: string) => {
    if (!sessionId || !role) return;
    const key = path.replace(/[.\/\[\]#$]/g, '_');
    await update(ref(db, `teambench/sessions/${sessionId}/files/${key}`), { content });
    addLog(sessionId, role, 'file_edit', { path, contentLength: content.length });
  }, [sessionId, role]);

  // Change phase — tracks durations and status
  const setPhase = useCallback(async (newPhase: SessionState['phase']) => {
    if (!sessionId || !role) return;
    const now = Date.now();
    const updates: Record<string, unknown> = { phase: newPhase };

    // Record phase transition timestamp
    updates[`phaseDurations/${phase}_to_${newPhase}`] = now;

    if (newPhase === 'completed') {
      updates.endTime = now;
      updates.endTimeISO = new Date(now).toISOString();
      updates.status = 'completed';
      if (startTime) {
        updates.durationSeconds = Math.round((now - startTime) / 1000);
      }
    } else if (newPhase === 'planning' || newPhase === 'execution' || newPhase === 'verification') {
      updates.status = 'active';
    }

    // Track verdict from verifier
    if (role === 'verifier' && phase === 'verification') {
      if (newPhase === 'execution') {
        // Verifier sent back to executor = fail
        updates.verdict = 'fail';
        updates.remediationCount = (await get(ref(db, `teambench/sessions/${sessionId}/remediationCount`))).val() + 1 || 1;
      } else if (newPhase === 'completed') {
        updates.verdict = 'pass';
      }
    }

    await update(ref(db, `teambench/sessions/${sessionId}`), updates);
    addLog(sessionId, role, 'phase_change', { from: phase, to: newPhase, timestamp: now });
  }, [sessionId, role, phase, startTime]);

  // Get visible messages for current role
  const getVisibleMessages = useCallback((): ChatMessage[] => {
    if (!role) return [];
    return messages.filter(m =>
      m.to === 'all' || m.from === role || m.to === role
    );
  }, [messages, role]);

  // Get visible files for current role
  const getVisibleFiles = useCallback((): FileEntry[] => {
    if (!role) return [];
    return files.map(f => ({
      ...f,
      readOnly: role !== 'executor' ? true : f.readOnly,
    }));
  }, [files, role]);

  // Export logs
  const exportLogs = useCallback(async () => {
    if (!sessionId) return;
    const snap = await get(ref(db, `teambench/sessions/${sessionId}`));
    if (!snap.exists()) return;
    const data = snap.val();

    const logsSnap = await get(ref(db, `teambench/sessions/${sessionId}/logs`));
    const logs = logsSnap.exists() ? Object.values(logsSnap.val()) : [];

    const exportData = {
      // Session identity
      sessionId,
      taskId: task.taskId,
      taskCategory: data.taskCategory || task.category,
      taskDifficulty: data.taskDifficulty || task.difficulty,
      experimentRound: data.experimentRound || 1,
      experimentGroup: data.experimentGroup || 'pilot',
      // Status
      phase: data.phase,
      status: data.status,
      verdict: data.verdict,
      remediationCount: data.remediationCount || 0,
      // Timing
      startTime: data.startTime,
      endTime: data.endTime,
      durationSeconds: data.durationSeconds,
      phaseDurations: data.phaseDurations || {},
      createdAt: data.createdAt,
      exportedAt: Date.now(),
      exportedAtISO: new Date().toISOString(),
      // Participants (with browser info)
      participants: data.participants,
      // Data
      messages: messages,
      logs,
      finalFiles: files.map(f => ({ path: f.path, content: f.content })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teambench_${task.taskId}_${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionId, task, messages, files]);

  return {
    sessionId,
    role,
    phase,
    messages: getVisibleMessages(),
    files: getVisibleFiles(),
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
    addLog: (action: string, detail?: Record<string, unknown>) => {
      if (sessionId && role) addLog(sessionId, role, action, detail ?? {});
    },
  };
}

// Helper: log an action to Firebase with full context
function addLog(sessionId: string, role: Role, action: string, detail: Record<string, unknown>) {
  const now = Date.now();
  push(ref(db, `teambench/sessions/${sessionId}/logs`), {
    id: generateId(),
    sessionId,
    role,
    action,
    detail,
    timestamp: now,
    timestampISO: new Date(now).toISOString(),
  });
}
