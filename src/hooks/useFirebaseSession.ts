import { useState, useEffect, useCallback, useRef } from 'react';
import { ref, push, set, get, update, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, ChatMessage, FileEntry, TaskConfig, SessionState } from '../types';
import { UserProfile } from '../views/LobbyView';

import { getHostSync } from '../lib/regionRouter';
import { groupForEmail, EXPERIMENT_ROUND } from '../lib/experimentGroup';
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
    experimentRound: EXPERIMENT_ROUND, experimentGroup: groupForEmail(profile?.email),
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
    experimentRound: EXPERIMENT_ROUND, experimentGroup: groupForEmail(profile?.email),
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
  // Tracks which sessionId has had its initial workspace fetched, so the
  // fetchFiles effect stays idempotent regardless of task reference churn.
  const fetchedForSessionRef = useRef<string | null>(null);

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
    // CRITICAL: role must be in the dep array. setSessionId + setRole are not
    // guaranteed to batch into a single commit (they're called from an async
    // join() — pre-React-18 batching would commit them separately). Without
    // `role` here, the effect can fire while role===null, which makes the
    // `role !== 'oracle' && role !== 'executor'` guard vacuously true and
    // subscribes Oracle/Executor to the /files echo. Every keystroke then
    // round-trips through Firebase and setFiles() clobbers Monaco's value
    // mid-stroke — the user sees letters disappearing under fast typing,
    // while slow typing "works" because echoes land before the next stroke.
  }, [sessionId, role]);

  // Load workspace files from the backend container after session creation.
  // Generator-staged tasks don't ship files in the frontend; we fetch them here.
  //
  // CRITICAL: this runs exactly once per session. The deps used to include
  // `task`, and inside the success path we called setTask(...) to inject
  // spec.md / brief.md contents — but `setTask(prev => ({...prev, ...}))`
  // creates a new task object every time, which re-fires the effect, which
  // re-fetches files from the backend, which setFiles(entries) — and entries
  // carries whatever the container filesystem has *at that moment*, typically
  // one keystroke behind the user's in-flight edit. Result: every ~1 s the
  // Monaco buffer got slammed back to a slightly-stale backend snapshot, and
  // fast typing dropped characters. Guard with a ref so we only fetch once
  // per sessionId, and drop `task` from deps.
  useEffect(() => {
    if (!sessionId || !task) return;
    if (task.files && task.files.length > 0) return;
    if (fetchedForSessionRef.current === sessionId) return;
    fetchedForSessionRef.current = sessionId;
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
          // shows the real task description instead of a placeholder. Guard
          // with an equality check so we don't churn the task reference when
          // the content already matches (that would re-fire downstream effects).
          const specFile = entries.find(f => f.path === 'spec.md');
          const briefFile = entries.find(f => f.path === 'brief.md');
          if (specFile || briefFile) {
            setTask(prev => {
              if (!prev) return prev;
              const nextSpec = specFile?.content || prev.specMd;
              const nextBrief = briefFile?.content || prev.briefMd;
              if (nextSpec === prev.specMd && nextBrief === prev.briefMd) return prev;
              return { ...prev, specMd: nextSpec, briefMd: nextBrief };
            });
          }
        }
        else if (attempt < 10) {
          // Still waiting for the container to stage files — allow retry.
          fetchedForSessionRef.current = null;
          setTimeout(() => { fetchedForSessionRef.current = sessionId; fetchFiles(attempt + 1); }, 1000);
        }
      } catch {
        if (attempt < 10) {
          fetchedForSessionRef.current = null;
          setTimeout(() => { fetchedForSessionRef.current = sessionId; fetchFiles(attempt + 1); }, 1000);
        }
      }
    };
    fetchFiles();
    return () => { cancelled = true; };
    // Intentionally NOT depending on `task` — we only want to fetch once per
    // sessionId. Task mutations (spec/brief injection) previously re-fired
    // this effect and caused setFiles to stomp on the user's live edits.
  }, [sessionId]);

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

  // Snapshot the container workspace into Firebase so post-hoc analysis
  // can read terminal-authored artifacts (results.json, report.md, budget
  // reports, etc.). Monaco-edited files are already in /files; this captures
  // anything the participant wrote from the shell that never hit Firebase.
  const persistFinalWorkspace = useCallback(async (sid: string) => {
    try {
      const r = await fetch(`${BACKEND_API()}/api/session/${sid}/files`);
      if (!r.ok) return;
      const data = await r.json();
      const entries: Record<string, { content: string; language?: string }> = {};
      for (const f of (data.files || []) as Array<{ path: string; content: string; language?: string }>) {
        // Firebase keys can't contain ./[/]/#/$ — same scheme used by /files.
        const key = f.path.replace(/[.\/\[\]#$]/g, '_');
        entries[key] = { content: f.content, language: f.language };
      }
      await set(ref(db, `teambench/sessions/${sid}/finalWorkspace`), {
        capturedAt: Date.now(),
        capturedAtISO: new Date().toISOString(),
        files: entries,
      });
    } catch {
      /* best-effort — grader result is still authoritative for scoring */
    }
  }, []);

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
      // Capture terminal-authored files BEFORE the session/container is torn
      // down. Awaiting this is fine; the participant's "Finish" click already
      // blocks on grading.
      await persistFinalWorkspace(sessionId);
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

  const leaveSession = useCallback(async () => {
    // "Back to lobby": abandon the current session and reset to the picker.
    // For solo mode this frees the container slot immediately. For team mode
    // we mark the session cancelled so teammates aren't stuck waiting.
    const sid = sessionId;
    const t = task;
    const r = role;
    const m = mode;
    // Reset local state first so the UI navigates back instantly even if
    // network calls below stall.
    setSessionId(null);
    setRole(null);
    setTask(null);
    setPhaseState('lobby');
    setMessages([]);
    setFiles([]);
    setParticipants({});
    setStartTime(null);
    setEndTime(null);
    setWaitingForTeam(false);
    setSaveStatus('idle');
    if (sid && r) {
      addLog(sid, r, 'leave_session', { mode: m });
      // Drop the resume cookie so a future join starts fresh.
      if (t) {
        try { localStorage.removeItem(`teambench_session_${t.taskId}_${r}_${m}`); } catch {}
      }
      // Snapshot terminal-authored files before we blow the container away.
      // Even for a "Back" click mid-task we want to keep the partial work.
      await persistFinalWorkspace(sid);
      // Team mode: signal cancellation so the partner sees it.
      if (m === 'team') {
        try {
          await update(ref(db, `teambench/sessions/${sid}`), {
            phase: 'cancelled', status: 'cancelled', endTime: Date.now(),
          });
        } catch { /* best-effort */ }
      }
      // Free the backend container slot (best-effort; works whether or not
      // the session ever had a container).
      try {
        await fetch(`${BACKEND_API()}/api/session/${sid}`, { method: 'DELETE', keepalive: true });
      } catch { /* ignore */ }
    }
  }, [sessionId, task, role, mode]);

  return {
    task, sessionId, role, mode, phase,
    messages: getVisibleMessages(), files: getVisibleFiles(),
    participants, startTime, endTime, joining, waitingForTeam,
    saveStatus,
    join, sendMessage, updateFile, setPhase, exportLogs, leaveSession,
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
