import { useState, useEffect, useCallback } from 'react';
import { ref, push, set, get, update, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, ChatMessage, FileEntry, TaskConfig, SessionState } from '../types';
import { UserProfile } from '../views/LobbyView';

import { getHostSync } from '../lib/regionRouter';
// Lazy host lookup — evaluated per-call so a region switch (or async
// auto-detect completing) takes effect without a full page reload.
const BACKEND_API = () => `https://${import.meta.env.VITE_BACKEND_HOST || getHostSync()}`;

/**
 * Sanitize editor content before saving to the container. Browser pastes from
 * xterm/less can carry pager status (`[18/1833]`), ANSI escapes, CRLF endings,
 * and runaway trailing whitespace — all of which corrupt Python source.
 */
function sanitizeFileContent(text: string): string {
  // 1. Normalize line endings to LF.
  let out = text.replace(/\r\n?/g, '\n');
  // 2. Strip ANSI/CSI escape sequences (ESC [ ... letter).
  out = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
  // 3. Strip pager status indicators like "[18/1833]" or "[lines 1-50]" at EOL.
  out = out.split('\n').map(line => {
    let l = line.replace(/\s+\[\d+\/\d+\]\s*$/, '');
    l = l.replace(/\s+\[lines? \d+(?:[-,]\s*\d+)?\]\s*$/i, '');
    // 4. Trim trailing whitespace (always safe for Python).
    return l.replace(/[ \t]+$/, '');
  }).join('\n');
  return out;
}

function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

function participantInfo(name: string, profile?: UserProfile) {
  return {
    name,
    joinedAt: Date.now(),
    email: profile?.email || '',
    institution: profile?.institution || '',
    expertise: profile?.expertise || '',
    yearsExp: profile?.yearsExp || '',
    userAgent: navigator.userAgent,
    screenSize: `${window.innerWidth}x${window.innerHeight}`,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

// ── Matchmaking ──
async function findOrCreateTeam(
  taskId: string, role: Role, name: string,
  taskMeta: { category: string; difficulty: string },
  profile?: UserProfile,
): Promise<{ sessionId: string; isNew: boolean }> {
  const snapshot = await get(ref(db, `teambench/waiting/${taskId}`));

  if (snapshot.exists()) {
    const waiting = snapshot.val() as Record<string, { sessionId: string; roles: Record<string, boolean> }>;
    for (const [waitId, team] of Object.entries(waiting)) {
      if (!team.roles[role]) {
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}/roles/${role}`), true);
        await set(ref(db, `teambench/sessions/${team.sessionId}/participants/${role}`), participantInfo(name, profile));

        const updatedSnap = await get(ref(db, `teambench/waiting/${taskId}/${waitId}/roles`));
        const roles = updatedSnap.val();
        if (roles.planner && roles.executor && roles.verifier) {
          const startNow = Date.now();
          await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
          await update(ref(db, `teambench/sessions/${team.sessionId}`), {
            phase: 'planning', status: 'active',
            startTime: startNow, startTimeISO: new Date(startNow).toISOString(),
          });
        }
        return { sessionId: team.sessionId, isNew: false };
      }
    }
  }

  const sessionId = `${taskId}_${generateId()}`;
  const now = Date.now();

  await set(ref(db, `teambench/sessions/${sessionId}`), {
    sessionId, taskId, mode: 'team',
    taskCategory: taskMeta.category, taskDifficulty: taskMeta.difficulty,
    experimentRound: 1, experimentGroup: 'pilot',
    phase: 'lobby', status: 'waiting',
    startTime: null, endTime: null,
    createdAt: now, createdAtISO: new Date(now).toISOString(),
    durationSeconds: null, phaseDurations: {},
    participants: { [role]: participantInfo(name, profile) },
    verdict: null, remediationCount: 0,
  });

  await set(push(ref(db, `teambench/waiting/${taskId}`)), {
    sessionId, roles: { [role]: true },
  });

  return { sessionId, isNew: true };
}

async function createOracleSession(
  taskId: string, name: string,
  taskMeta: { category: string; difficulty: string },
  profile?: UserProfile,
): Promise<string> {
  const sessionId = `${taskId}_oracle_${generateId()}`;
  const now = Date.now();

  await set(ref(db, `teambench/sessions/${sessionId}`), {
    sessionId, taskId, mode: 'oracle',
    taskCategory: taskMeta.category, taskDifficulty: taskMeta.difficulty,
    experimentRound: 1, experimentGroup: 'pilot',
    phase: 'execution', status: 'active',
    startTime: now, startTimeISO: new Date(now).toISOString(),
    endTime: null, createdAt: now, createdAtISO: new Date(now).toISOString(),
    durationSeconds: null, phaseDurations: {},
    participants: { oracle: participantInfo(name, profile) },
    verdict: null, remediationCount: 0,
  });

  return sessionId;
}

// ── Main Hook ──
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
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');

  // Subscribe to session
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

    // CRITICAL: Only readers (planner, verifier) subscribe to file updates.
    // The editor role (executor, oracle) must NOT apply Firebase echoes —
    // under high-latency networks (e.g. participants outside the US hitting
    // a Boston-hosted Firebase), subscription callbacks arrive out of order
    // with local state updates. A stale echo of "a" can clobber the user's
    // in-flight "ab" buffer, causing the reported symptom where typed
    // characters disappear and the cursor jumps to the end of the file.
    //
    // For solo (oracle) and executor roles, the local React state is the
    // single source of truth; the backend /write-file endpoint keeps the
    // container workspace in sync. Firebase is still written (for logging
    // and for other roles to observe), but we don't READ back.
    if (role !== 'oracle' && role !== 'executor') {
      unsubs.push(onValue(ref(db, `teambench/sessions/${sessionId}/files`), (snap) => {
        if (!snap.exists()) return;
        const data = snap.val() as Record<string, { content: string }>;
        setFiles(prev => prev.map(f => {
          const key = f.path.replace(/[.\/\[\]#$]/g, '_');
          return data[key] ? { ...f, content: data[key].content } : f;
        }));
      }));
    }

    return () => unsubs.forEach(u => u());
  }, [sessionId]);

  // Load workspace files from the backend container after session creation.
  // Generator-staged tasks don't ship files in the frontend; we fetch them here.
  useEffect(() => {
    if (!sessionId || !task) return;
    if (task.files && task.files.length > 0) return;
    let cancelled = false;
    const fetchFiles = async (attempt = 0) => {
      try {
        const r = await fetch(`${BACKEND_API()}/api/session/${sessionId}/files`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (cancelled) return;
        const entries: FileEntry[] = (data.files || []).map((f: any) => ({
          path: f.path,
          content: f.content,
          language: f.language,
          readOnly: f.readOnly,
        }));
        if (entries.length > 0) {
          setFiles(entries);
          // Populate specMd/briefMd from workspace files so the left panel
          // shows the real task description instead of a placeholder.
          const specFile = entries.find(f => f.path === 'spec.md');
          const briefFile = entries.find(f => f.path === 'brief.md');
          if (specFile || briefFile) {
            setTask(prev => prev ? {
              ...prev,
              specMd: specFile?.content || prev.specMd,
              briefMd: briefFile?.content || prev.briefMd,
            } : prev);
          }
        }
        else if (attempt < 10) setTimeout(() => fetchFiles(attempt + 1), 1000);
      } catch {
        if (attempt < 10) setTimeout(() => fetchFiles(attempt + 1), 1000);
      }
    };
    fetchFiles();
    return () => { cancelled = true; };
  }, [sessionId, task]);

  const join = useCallback(async (
    selectedTask: TaskConfig, selectedRole: Role, selectedMode: SessionMode,
    name: string, profile?: UserProfile,
  ) => {
    setJoining(true);
    setTask(selectedTask);
    setMode(selectedMode);
    setFiles(selectedTask.files.map(f => ({ ...f })));

    try {
      // Resume an in-progress session ONLY if:
      //   (a) it was saved within the last 30 minutes (matches task timeLimit),
      //   (b) it still exists in Firebase,
      //   (c) it is not completed/cancelled,
      //   (d) the user's role is still listed in participants (not stolen by someone else),
      //   (e) for team mode: the team is past lobby (otherwise we should rejoin the waiting room).
      // Otherwise, drop the stale localStorage entry and start fresh.
      const RESUME_TTL_MS = 30 * 60 * 1000;
      const storageKey = `teambench_session_${selectedTask.taskId}_${selectedRole}_${selectedMode}`;
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        try {
          const parsed = JSON.parse(saved) as { sessionId: string; savedAt?: number };
          const savedAt = parsed.savedAt ?? 0;
          const fresh = Date.now() - savedAt < RESUME_TTL_MS;
          if (fresh) {
            const snap = await get(ref(db, `teambench/sessions/${parsed.sessionId}`));
            if (snap.exists()) {
              const data = snap.val();
              const phaseOk = data.phase && data.phase !== 'completed' && data.phase !== 'cancelled';
              const myRoleStillMine = !!data.participants?.[selectedRole];
              if (phaseOk && myRoleStillMine) {
                setSessionId(parsed.sessionId);
                setRole(selectedRole);
                addLog(parsed.sessionId, selectedRole, 'resume', { name });
                setJoining(false);
                return;
              }
            }
          }
        } catch {
          // fall through and clear
        }
        // Stale or invalid — drop it so we don't resume into a stranger's session.
        localStorage.removeItem(storageKey);
      }

      let newSessionId: string;
      let isNew = false;
      const taskMeta = { category: selectedTask.category, difficulty: selectedTask.difficulty };

      if (selectedMode === 'oracle') {
        newSessionId = await createOracleSession(selectedTask.taskId, name, taskMeta, profile);
        isNew = true;
      } else {
        const result = await findOrCreateTeam(selectedTask.taskId, selectedRole, name, taskMeta, profile);
        newSessionId = result.sessionId;
        isNew = result.isNew;
      }

      setSessionId(newSessionId);
      setRole(selectedRole);
      localStorage.setItem(storageKey, JSON.stringify({ sessionId: newSessionId, savedAt: Date.now() }));

      if (isNew) {
        const filesData: Record<string, { content: string; language: string }> = {};
        for (const f of selectedTask.files) {
          const key = f.path.replace(/[.\/\[\]#$]/g, '_');
          filesData[key] = { content: f.content, language: f.language };
        }
        await set(ref(db, `teambench/sessions/${newSessionId}/files`), filesData);
      }

      if (isNew && selectedMode === 'team') setWaitingForTeam(true);
      addLog(newSessionId, selectedRole, 'join', { name, mode: selectedMode, profile });
    } catch (err) {
      console.error('Join error:', err);
    }
    setJoining(false);
  }, []);

  const sendMessage = useCallback(async (to: Role | 'all', content: string) => {
    if (!sessionId || !role) return;
    await push(ref(db, `teambench/sessions/${sessionId}/messages`), {
      id: generateId(), from: role, to, content, timestamp: Date.now(),
    });
    addLog(sessionId, role, 'chat_send', { to, contentLength: content.length });
  }, [sessionId, role]);

  const updateFile = useCallback(async (path: string, content: string) => {
    if (!sessionId || !role) return;
    const clean = sanitizeFileContent(content);
    const key = path.replace(/[.\/\[\]#$]/g, '_');
    await update(ref(db, `teambench/sessions/${sessionId}/files/${key}`), { content: clean });
    addLog(sessionId, role, 'file_edit', { path, contentLength: clean.length });
    // Sync edits to the container workspace so terminal + grader see them.
    setSaveStatus('saving');
    try {
      const r = await fetch(`${BACKEND_API()}/api/session/${sessionId}/write-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, content: clean }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus(s => s === 'saved' ? 'idle' : s), 1500);
    } catch {
      setSaveStatus('error');
    }
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
    if (role === 'oracle') return messages;
    return messages.filter(m => m.to === 'all' || m.from === role || m.to === role);
  }, [messages, role]);

  const getVisibleFiles = useCallback((): FileEntry[] => {
    if (!role) return [];
    if (role === 'oracle' || role === 'executor') return files.map(f => ({ ...f }));
    return files.map(f => ({ ...f, readOnly: true }));
  }, [files, role]);

  const exportLogs = useCallback(async () => {
    if (!sessionId || !task) return;
    const snap = await get(ref(db, `teambench/sessions/${sessionId}`));
    if (!snap.exists()) return;
    const data = snap.val();
    const logsSnap = await get(ref(db, `teambench/sessions/${sessionId}/logs`));
    const logs = logsSnap.exists() ? Object.values(logsSnap.val()) : [];

    const blob = new Blob([JSON.stringify({
      sessionId, taskId: task.taskId, mode: data.mode || mode,
      taskCategory: data.taskCategory, taskDifficulty: data.taskDifficulty,
      experimentRound: data.experimentRound, experimentGroup: data.experimentGroup,
      phase: data.phase, status: data.status,
      verdict: data.verdict, remediationCount: data.remediationCount || 0,
      startTime: data.startTime, endTime: data.endTime, durationSeconds: data.durationSeconds,
      phaseDurations: data.phaseDurations || {},
      participants: data.participants, messages, logs,
      finalFiles: files.map(f => ({ path: f.path, content: f.content })),
      exportedAt: Date.now(), exportedAtISO: new Date().toISOString(),
    }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `teambench_${task.taskId}_${sessionId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [sessionId, task, mode, messages, files]);

  return {
    task, sessionId, role, mode, phase,
    messages: getVisibleMessages(), files: getVisibleFiles(),
    participants, startTime, endTime, joining, waitingForTeam,
    saveStatus,
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
