import { useState, useEffect, useCallback, useRef } from 'react';
import { ref, push, set, get, update, onValue } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode, ChatMessage, FileEntry, TaskConfig, SessionState } from '../types';
import { UserProfile } from '../views/LobbyView';

import { getHostSync } from '../lib/regionRouter';
import { groupForEmail, EXPERIMENT_ROUND } from '../lib/experimentGroup';
import { participantIdFromEmail } from '../lib/participantId';
import { recordEdit } from '../lib/fileDiff';
import {
  metaPath, participantPath, participantProfilePath, participantInteractionsPath,
  sharedMessagesPath, sharedFilesPath, sharedInitialWorkspacePath,
  sharedFinalWorkspacePath,
  participantsIndexSessionPath, participantsIndexProfilePath,
} from '../lib/firebasePaths';
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

// ── New-tree mirror helpers (additive, never block legacy writes) ────────
// All writes are best-effort; failures are logged but never thrown so they
// can't break the live UX. Callers should resolve the participant id before
// calling these — the legacy code path does not depend on pid existing.

async function safeWrite(label: string, fn: () => Promise<void>): Promise<void> {
  try { await fn(); } catch (err) { console.warn(`[v2 write ${label}]`, err); }
}

async function mirrorSessionMeta(
  taskId: string, mode: SessionMode, sessionId: string,
  legacyMeta: Record<string, unknown>,
): Promise<void> {
  await safeWrite('meta', () => set(ref(db, metaPath(taskId, mode, sessionId)), legacyMeta));
}

async function mirrorParticipantProfile(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
  role: Role, name: string, profile?: UserProfile,
): Promise<void> {
  const blob = {
    ...participantInfo(name, profile),
    role,
    locale: navigator.language,
    leftAt: null,
  };
  await safeWrite('profile', () =>
    set(ref(db, participantProfilePath(taskId, mode, sessionId, pid)), blob));
  await safeWrite('idx-session', () =>
    set(ref(db, participantsIndexSessionPath(pid, sessionId)), {
      taskId, mode, role, status: 'active', verdict: null, startTime: Date.now(),
    }));
  await safeWrite('idx-profile', () =>
    set(ref(db, participantsIndexProfilePath(pid)), {
      email: profile?.email || '',
      name,
      institution: profile?.institution || '',
      expertise: profile?.expertise || '',
      yearsExp: profile?.yearsExp || '',
      updatedAt: Date.now(),
    }));
}

// Reconcile any participants present in the legacy session but missing from
// the v2 tree. Happens when an earlier joiner had a stale browser tab whose
// bundle predated the v2 mirror code — they wrote to legacy only, leaving
// the v2 tree with a partial roster. Each subsequent fresh-bundle joiner
// runs this reconciler and back-fills the gaps idempotently.
//
// Uses LEGACY profile data verbatim (joinedAt, userAgent, etc.) so we do
// not leak the current browser's metadata into someone else's profile blob.
async function reconcileV2ParticipantsFromLegacy(
  taskId: string, mode: SessionMode, sessionId: string,
  legacyParticipants: Record<string, {
    name?: string; email?: string; institution?: string; expertise?: string;
    yearsExp?: string; joinedAt?: number; userAgent?: string;
    screenSize?: string; timezone?: string;
  } | undefined>,
): Promise<void> {
  for (const [otherRole, legacyProfile] of Object.entries(legacyParticipants)) {
    if (!legacyProfile) continue;
    const otherEmail = (legacyProfile.email || '').trim();
    if (!otherEmail) continue;
    let otherPid = '';
    try {
      otherPid = await participantIdFromEmail(otherEmail);
    } catch {
      continue;
    }
    if (!otherPid) continue;

    // Skip if v2 already has them.
    try {
      const existing = await get(ref(db, participantProfilePath(taskId, mode, sessionId, otherPid)));
      if (existing.exists()) continue;
    } catch {
      continue; // best-effort read — skip on error
    }

    const blob = {
      name: legacyProfile.name || '(unnamed)',
      joinedAt: legacyProfile.joinedAt || 0,
      email: otherEmail,
      institution: legacyProfile.institution || '',
      expertise: legacyProfile.expertise || '',
      yearsExp: legacyProfile.yearsExp || '',
      userAgent: legacyProfile.userAgent || '',
      screenSize: legacyProfile.screenSize || '',
      timezone: legacyProfile.timezone || '',
      locale: '',
      leftAt: null,
      role: otherRole,
      backfilledAt: Date.now(),  // marker: this profile was reconciled, not written by the participant themselves
    };
    await safeWrite('reconcile-profile', () =>
      set(ref(db, participantProfilePath(taskId, mode, sessionId, otherPid)), blob));
    await safeWrite('reconcile-idx-session', () =>
      set(ref(db, participantsIndexSessionPath(otherPid, sessionId)), {
        taskId, mode, role: otherRole,
        status: 'active', verdict: null,
        startTime: legacyProfile.joinedAt || Date.now(),
        backfilledAt: Date.now(),
      }));
  }
}

// Reconcile a sparse v2 meta from the legacy session payload. If the v2
// meta was first written by a partial update (e.g. meta-start by a 3rd
// joiner) instead of the full mirrorSessionMeta from the creator, fields
// like createdAt / taskCategory / experimentRound are missing. Use update
// (not set) so we never overwrite progress fields that have advanced.
async function reconcileV2MetaFromLegacy(
  taskId: string, mode: SessionMode, sessionId: string,
  legacySession: Record<string, unknown>,
): Promise<void> {
  // Only copy stable creation-time fields, not anything that could move
  // (phase / status / endTime / verdict). Those land via setPhase mirror
  // calls and we don't want to clobber a more-recent state.
  const stable: Record<string, unknown> = {};
  for (const k of [
    'sessionId', 'taskId', 'mode',
    'taskCategory', 'taskDifficulty',
    'experimentRound', 'experimentGroup',
    'createdAt', 'createdAtISO',
    'startTime', 'startTimeISO',
  ]) {
    if (legacySession[k] !== undefined && legacySession[k] !== null) {
      stable[k] = legacySession[k];
    }
  }
  if (Object.keys(stable).length === 0) return;
  await safeWrite('reconcile-meta', () =>
    update(ref(db, metaPath(taskId, mode, sessionId)), stable));
}

function genEventId(): string {
  return Math.random().toString(36).slice(2, 10);
}

async function pushInteraction(
  taskId: string, mode: SessionMode, sessionId: string, pid: string,
  type: string, payload: Record<string, unknown> = {},
): Promise<void> {
  const now = Date.now();
  await safeWrite(`interaction:${type}`, () =>
    push(
      ref(db, participantInteractionsPath(taskId, mode, sessionId, pid)),
      { id: genEventId(), ts: now, tsISO: new Date(now).toISOString(), type, ...payload },
    ).then(() => {}),
  );
}

// ── Matchmaking ──
async function findOrCreateTeam(
  taskId: string, role: Role, name: string,
  taskMeta: { category: string; difficulty: string },
  profile?: UserProfile,
): Promise<{ sessionId: string; pid: string; isNew: boolean }> {
  // Resolve the joiner's pid up-front so we can dedup against teams that
  // already contain this person (preventing the same human from filling
  // 2 roles in one session).
  const joinerPid = profile?.email ? await participantIdFromEmail(profile.email) : '';

  const snapshot = await get(ref(db, `teambench/waiting/${taskId}`));

  if (snapshot.exists()) {
    const waiting = snapshot.val() as Record<string, { sessionId: string; roles: Record<string, boolean> }>;
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;  // 30 min
    const nowMs = Date.now();

    for (const [waitId, team] of Object.entries(waiting)) {
      if (!team.sessionId) continue;
      // (1) Skip + delete waiting entries whose session is missing or no
      // longer in lobby phase (someone already advanced or cancelled it).
      const sessSnap = await get(ref(db, `teambench/sessions/${team.sessionId}`));
      if (!sessSnap.exists()) {
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
        continue;
      }
      const sess = sessSnap.val();
      if (sess.phase !== 'lobby') {
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
        continue;
      }
      // (2) Skip + delete entries that have aged past the threshold (the
      // tab was closed without going through leaveSession).
      if (typeof sess.createdAt === 'number' && nowMs - sess.createdAt > STALE_THRESHOLD_MS) {
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
        continue;
      }
      // (3) Skip teams that already contain this person under a different
      // role (legacy participants dict OR v2 participants index). Same
      // human cannot fill 2 roles.
      const legacyParts = (sess.participants || {}) as Record<string, { email?: string }>;
      const sameHumanInLegacy = Object.values(legacyParts).some(
        p => (p?.email || '').trim().toLowerCase() === (profile?.email || '').trim().toLowerCase()
              && (profile?.email || '').trim() !== ''
      );
      let sameHumanInV2 = false;
      if (joinerPid) {
        const v2Snap = await get(ref(db, participantPath(taskId, 'team', team.sessionId, joinerPid)));
        sameHumanInV2 = v2Snap.exists();
      }
      if (sameHumanInLegacy || sameHumanInV2) continue;

      if (!team.roles[role]) {
        await set(ref(db, `teambench/waiting/${taskId}/${waitId}/roles/${role}`), true);
        await set(ref(db, `teambench/sessions/${team.sessionId}/participants/${role}`), participantInfo(name, profile));

        // v2 mirror — additive, never blocks legacy behavior
        if (joinerPid) {
          await mirrorParticipantProfile(taskId, 'team', team.sessionId, joinerPid, role, name, profile);
        }

        // Reconcile any earlier joiners whose v2 mirror failed (e.g. they
        // had a stale browser tab loaded with a pre-v2 bundle). Backfills
        // their profile from the LEGACY session data so the v2 tree is
        // never structurally smaller than the legacy tree. Idempotent —
        // skips any pid that already has a v2 profile.
        const legacySess = sess as Record<string, unknown>;
        const legacyParts = (legacySess.participants || {}) as Record<string, {
          name?: string; email?: string; institution?: string; expertise?: string;
          yearsExp?: string; joinedAt?: number; userAgent?: string;
          screenSize?: string; timezone?: string;
        }>;
        await reconcileV2ParticipantsFromLegacy(taskId, 'team', team.sessionId, legacyParts);
        await reconcileV2MetaFromLegacy(taskId, 'team', team.sessionId, legacySess);

        const updatedSnap = await get(ref(db, `teambench/waiting/${taskId}/${waitId}/roles`));
        const roles = updatedSnap.val();
        if (roles.planner && roles.executor && roles.verifier) {
          const startNow = Date.now();
          await set(ref(db, `teambench/waiting/${taskId}/${waitId}`), null);
          const startUpdate = {
            phase: 'planning', status: 'active',
            startTime: startNow, startTimeISO: new Date(startNow).toISOString(),
          };
          await update(ref(db, `teambench/sessions/${team.sessionId}`), startUpdate);
          await safeWrite('meta-start', () =>
            update(ref(db, metaPath(taskId, 'team', team.sessionId)), startUpdate));
        }
        return { sessionId: team.sessionId, pid: joinerPid, isNew: false };
      }
    }
  }

  const sessionId = `${taskId}_${generateId()}`;
  const now = Date.now();

  const legacyPayload = {
    sessionId, taskId, mode: 'team',
    taskCategory: taskMeta.category, taskDifficulty: taskMeta.difficulty,
    experimentRound: EXPERIMENT_ROUND, experimentGroup: groupForEmail(profile?.email),
    phase: 'lobby', status: 'waiting',
    startTime: null, endTime: null,
    createdAt: now, createdAtISO: new Date(now).toISOString(),
    durationSeconds: null, phaseDurations: {},
    participants: { [role]: participantInfo(name, profile) },
    verdict: null, remediationCount: 0,
  };
  await set(ref(db, `teambench/sessions/${sessionId}`), legacyPayload);

  await set(push(ref(db, `teambench/waiting/${taskId}`)), {
    sessionId, roles: { [role]: true },
  });

  // v2 mirror — additive
  const pid = joinerPid;
  if (pid) {
    await mirrorSessionMeta(taskId, 'team', sessionId, legacyPayload);
    await mirrorParticipantProfile(taskId, 'team', sessionId, pid, role, name, profile);
  }

  return { sessionId, pid, isNew: true };
}

async function createOracleSession(
  taskId: string, name: string,
  taskMeta: { category: string; difficulty: string },
  profile?: UserProfile,
): Promise<{ sessionId: string; pid: string }> {
  const sessionId = `${taskId}_oracle_${generateId()}`;
  const now = Date.now();

  const legacyPayload = {
    sessionId, taskId, mode: 'oracle',
    taskCategory: taskMeta.category, taskDifficulty: taskMeta.difficulty,
    experimentRound: EXPERIMENT_ROUND, experimentGroup: groupForEmail(profile?.email),
    phase: 'execution', status: 'active',
    startTime: now, startTimeISO: new Date(now).toISOString(),
    endTime: null, createdAt: now, createdAtISO: new Date(now).toISOString(),
    durationSeconds: null, phaseDurations: {},
    participants: { oracle: participantInfo(name, profile) },
    verdict: null, remediationCount: 0,
  };
  await set(ref(db, `teambench/sessions/${sessionId}`), legacyPayload);

  // v2 mirror — additive
  const pid = profile?.email ? await participantIdFromEmail(profile.email) : '';
  if (pid) {
    await mirrorSessionMeta(taskId, 'oracle', sessionId, legacyPayload);
    await mirrorParticipantProfile(taskId, 'oracle', sessionId, pid, 'oracle', name, profile);
  }

  return { sessionId, pid };
}

// Hybrid: 1 human (verifier) + 2 AI agents (planner, executor). No waiting
// room — the human joins alone and the backend spawns the agents immediately
// via /api/session/{sid}/start-hybrid after the container is provisioned.
async function createHybridSession(
  taskId: string, name: string,
  taskMeta: { category: string; difficulty: string },
  profile?: UserProfile,
): Promise<{ sessionId: string; pid: string }> {
  const sessionId = `${taskId}_hybrid_${generateId()}`;
  const now = Date.now();

  const legacyPayload = {
    sessionId, taskId, mode: 'hybrid',
    taskCategory: taskMeta.category, taskDifficulty: taskMeta.difficulty,
    experimentRound: EXPERIMENT_ROUND, experimentGroup: groupForEmail(profile?.email),
    phase: 'planning', status: 'active',
    startTime: now, startTimeISO: new Date(now).toISOString(),
    endTime: null, createdAt: now, createdAtISO: new Date(now).toISOString(),
    durationSeconds: null, phaseDurations: {},
    participants: { verifier: participantInfo(name, profile) },
    verdict: null, remediationCount: 0,
  };
  await set(ref(db, `teambench/sessions/${sessionId}`), legacyPayload);

  // v2 mirror — additive
  const pid = profile?.email ? await participantIdFromEmail(profile.email) : '';
  if (pid) {
    await mirrorSessionMeta(taskId, 'hybrid', sessionId, legacyPayload);
    await mirrorParticipantProfile(taskId, 'hybrid', sessionId, pid, 'verifier', name, profile);
  }

  return { sessionId, pid };
}

// ── Main Hook ──
export function useFirebaseSession() {
  const [task, setTask] = useState<TaskConfig | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [role, setRole] = useState<Role | null>(null);
  const [mode, setMode] = useState<SessionMode>('team');
  const [pid, setPid] = useState<string | null>(null);
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
        const data = snap.val() as Record<string, { content: string; language?: string; path?: string; readOnly?: boolean }>;
        setFiles(prev => {
          // Update existing entries AND surface any new files Firebase has
          // that we don't yet. Previously we only mapped over `prev`, which
          // meant Planner/Verifier couldn't see files that Executor created
          // from the terminal (e.g. `touch new_file.py`) — the echo arrived
          // but we ignored paths we hadn't already fetched.
          const byKey: Record<string, FileEntry> = {};
          for (const f of prev) {
            const k = f.path.replace(/[.\/\[\]#$]/g, '_');
            byKey[k] = f;
          }
          for (const [k, v] of Object.entries(data)) {
            const existing = byKey[k];
            if (existing) {
              byKey[k] = { ...existing, content: v.content };
            } else if (v.path) {
              byKey[k] = {
                path: v.path,
                content: v.content,
                language: v.language || '',
                readOnly: v.readOnly ?? true,
              };
            }
          }
          return Object.values(byKey);
        });
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
  //
  // Team-mode quirk: only the Executor role opens the Terminal component,
  // which in turn triggers /api/session/{sid}/create on the backend. Until
  // that happens the container does not exist and /files returns empty.
  // Planner / Verifier typically join BEFORE the Executor opens their
  // terminal, so the initial fetch returns zero entries. We therefore poll
  // until files appear (with a cap to avoid leaking a request loop forever).
  //
  // Deps: only [sessionId]. We do NOT depend on `task` — a prior version did,
  // and inside the success path we called setTask(prev => ({...prev, ...}))
  // which creates a fresh task reference and re-fires this effect, re-fetches,
  // and calls setFiles() with the container's *current* content. That
  // overwrote the user's live Monaco buffer every ~1 s and dropped fast
  // keystrokes. The once-per-sessionId ref guard below keeps this idempotent
  // even if the effect ever re-evaluates for some other reason.
  useEffect(() => {
    if (!sessionId || !task) return;
    if (task.files && task.files.length > 0) return;
    if (fetchedForSessionRef.current === sessionId) return;
    fetchedForSessionRef.current = sessionId;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    // Ensure the backend session/container exists before we poll /files.
    //
    // In team mode, the Docker container is provisioned by POST /create,
    // but the only frontend caller of /create is the <Terminal> component
    // inside ExecutorView — and Terminal is gated behind a tab that
    // defaults to "Task Brief". So if the Planner or Verifier joins
    // before the Executor explicitly clicks the Terminal tab, the
    // container never gets created and /files returns 404 for the whole
    // 2-min retry window — the Planner sees an empty FileTree.
    //
    // /create is idempotent (`if session_id in sessions: return exists`),
    // so it's safe for any role to call. The Executor's Terminal will
    // still call it later and simply get the "exists" response.
    const ensureContainer = async () => {
      try {
        await fetch(
          `${BACKEND_API()}/api/session/${sessionId}/create?task_id=${encodeURIComponent(task.taskId)}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: {} }),
          }
        );
      } catch {
        // Best-effort — the poll below still retries. If the backend is
        // down entirely, the participant will see an empty tree and the
        // error will surface when they try to use the terminal.
      }
    };

    const fetchOnce = async (): Promise<boolean> => {
      try {
        const r = await fetch(`${BACKEND_API()}/api/session/${sessionId}/files`);
        if (!r.ok) return false;
        const data = await r.json();
        const entries: FileEntry[] = (data.files || []).map((f: any) => ({
          path: f.path,
          content: f.content,
          language: f.language,
          readOnly: f.readOnly,
        }));
        if (entries.length === 0) return false;
        if (cancelled) return true;
        // Publish partial staging so the tree isn't blank while we wait.
        setFiles(entries);
        const specFile = entries.find(f => f.path === 'spec.md');
        const briefFile = entries.find(f => f.path === 'brief.md');
        // brief.md / spec.md are the LAST things the backend writes when
        // staging a task. Exiting this poll as soon as entries.length > 0
        // could snapshot a half-staged workspace — exactly what
        // participants saw for GH1002_scipy (only README_HUMAN.md +
        // conftest.py visible, no .pyx target, briefMd stuck on
        // "Loading task from backend..."). Use brief/spec presence as
        // the real completion signal and keep polling until we see one.
        if (specFile || briefFile) {
          setTask(prev => {
            if (!prev) return prev;
            const nextSpec = specFile?.content || prev.specMd;
            const nextBrief = briefFile?.content || prev.briefMd;
            if (nextSpec === prev.specMd && nextBrief === prev.briefMd) return prev;
            return { ...prev, specMd: nextSpec, briefMd: nextBrief };
          });
          // Capture the pre-execution snapshot so the Verifier can render
          // a +/- diff against it as the Executor edits. Only write if
          // nothing's there yet — whichever role's fetchOnce completes
          // first wins, subsequent roles skip. Content is deterministic
          // post-staging (same container state) so the first-writer
          // pattern is race-safe. Skipped for hybrid mode where the
          // backend agent_runner owns the baseline write.
          try {
            const initRef = ref(db, `teambench/sessions/${sessionId}/initialWorkspace`);
            const initSnap = await get(initRef);
            if (!initSnap.exists()) {
              const initData: Record<string, { path: string; content: string }> = {};
              for (const f of entries) {
                const key = f.path.replace(/[.\/\[\]#$]/g, '_');
                initData[key] = { path: f.path, content: f.content };
              }
              await set(initRef, initData);
              // v2 mirror — same data under sharedArtifacts/initialWorkspace
              if (task) {
                await safeWrite('init-ws', () =>
                  set(ref(db, sharedInitialWorkspacePath(task.taskId, mode, sessionId)), initData));
              }
            }
          } catch {
            // best-effort — diff view gracefully degrades to plain view
          }
          return true;
        }
        return false; // still staging — retry
      } catch {
        return false;
      }
    };

    const loop = async (attempt: number) => {
      if (cancelled) return;
      const ok = await fetchOnce();
      if (ok || cancelled) return;
      // Cap at 120 attempts = ~2 min of polling at 1 s intervals. Covers
      // the waiting-room + container-boot worst case without running
      // forever if something is genuinely broken.
      if (attempt >= 120) return;
      timer = setTimeout(() => loop(attempt + 1), 1000);
    };
    // Kick off container provisioning, then start polling. We don't await
    // ensureContainer — /create can take a few seconds to stage + boot,
    // and /files returning 404 is self-healing via the poll loop.
    ensureContainer();
    loop(0);

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
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
                // v2 mirror — resume event in interactions stream
                if (profile?.email) {
                  const resumePid = await participantIdFromEmail(profile.email);
                  setPid(resumePid);
                  await pushInteraction(
                    selectedTask.taskId, selectedMode, parsed.sessionId, resumePid,
                    'resume', { role: selectedRole, fromLocalStorageAt: savedAt },
                  );
                }
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
      let newPid = '';
      let isNew = false;
      const taskMeta = { category: selectedTask.category, difficulty: selectedTask.difficulty };

      if (selectedMode === 'oracle') {
        const r = await createOracleSession(selectedTask.taskId, name, taskMeta, profile);
        newSessionId = r.sessionId; newPid = r.pid; isNew = true;
      } else if (selectedMode === 'hybrid') {
        const r = await createHybridSession(selectedTask.taskId, name, taskMeta, profile);
        newSessionId = r.sessionId; newPid = r.pid; isNew = true;
      } else {
        const result = await findOrCreateTeam(selectedTask.taskId, selectedRole, name, taskMeta, profile);
        newSessionId = result.sessionId; newPid = result.pid; isNew = result.isNew;
      }

      setSessionId(newSessionId);
      setRole(selectedRole);
      if (newPid) setPid(newPid);
      localStorage.setItem(storageKey, JSON.stringify({ sessionId: newSessionId, savedAt: Date.now() }));

      if (isNew) {
        const filesData: Record<string, { content: string; language: string }> = {};
        for (const f of selectedTask.files) {
          const key = f.path.replace(/[.\/\[\]#$]/g, '_');
          filesData[key] = { content: f.content, language: f.language };
        }
        await set(ref(db, `teambench/sessions/${newSessionId}/files`), filesData);
        // v2 mirror — same file map under sharedArtifacts/files
        await safeWrite('shared-files-init', () =>
          set(ref(db, sharedFilesPath(selectedTask.taskId, selectedMode, newSessionId)), filesData));
      }

      // For hybrid, kick off the backend agent runners. We don't await the
      // full agent work — /start-hybrid returns as soon as processes spawn.
      // The container-ensure effect (fetchFiles useEffect) handles /create;
      // we then POST /start-hybrid once the session is known-good.
      if (selectedMode === 'hybrid') {
        try {
          const backend = `https://${import.meta.env.VITE_BACKEND_HOST || getHostSync()}`;
          // First ensure container exists (agents need the workspace).
          await fetch(`${backend}/api/session/${newSessionId}/create?task_id=${encodeURIComponent(selectedTask.taskId)}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ files: {} }),
          });
          // Then spawn the agents.
          await fetch(`${backend}/api/session/${newSessionId}/start-hybrid?task_id=${encodeURIComponent(selectedTask.taskId)}`, {
            method: 'POST',
          });
        } catch (e) {
          console.error('Hybrid start failed:', e);
        }
      }

      if (isNew && selectedMode === 'team') setWaitingForTeam(true);
      addLog(newSessionId, selectedRole, 'join', { name, mode: selectedMode, profile });
      // v2 mirror — join event in interactions stream
      if (newPid) {
        await pushInteraction(selectedTask.taskId, selectedMode, newSessionId, newPid, 'join', {
          name, mode: selectedMode, role: selectedRole, viaResume: false,
        });
      }
    } catch (err) {
      console.error('Join error:', err);
    }
    setJoining(false);
  }, []);

  const sendMessage = useCallback(async (to: Role | 'all', content: string) => {
    if (!sessionId || !role) return;
    const msg = { id: generateId(), from: role, to, content, timestamp: Date.now() };
    await push(ref(db, `teambench/sessions/${sessionId}/messages`), msg);
    addLog(sessionId, role, 'chat_send', { to, contentLength: content.length });
    // v2 mirror — same message under sharedArtifacts/messages and chat_send interaction
    if (task && pid) {
      await safeWrite('shared-msg', () =>
        push(ref(db, sharedMessagesPath(task.taskId, mode, sessionId)), msg).then(() => {}));
      await pushInteraction(task.taskId, mode, sessionId, pid, 'chat_send', {
        to, content, contentLength: content.length,
      });
    }
  }, [sessionId, role, task, mode, pid]);

  const updateFile = useCallback(async (path: string, content: string) => {
    if (!sessionId || !role) return;
    const clean = sanitizeFileContent(content);
    const key = path.replace(/[.\/\[\]#$]/g, '_');
    // Update local React state synchronously. For oracle/executor the Firebase
    // /files echo is intentionally not subscribed (see the role-gated
    // subscription above), so without this write the React `files` state stays
    // frozen at the initial task contents. On a file switch, @monaco-editor/react
    // rebinds setModel→setValue and calls setValue(value-prop); if value-prop
    // is the stale initial content while Monaco's per-file model holds the
    // user's edits, the setValue overwrites those edits. Storing the edit in
    // state synchronously keeps value-prop === model contents, making the
    // sync a no-op on switch-back. This is the "local state is the single
    // source of truth" invariant promised by the comment at the /files
    // subscription above — previously asserted but not implemented.
    setFiles(prev => prev.map(f => f.path === path ? { ...f, content: clean } : f));
    await update(ref(db, `teambench/sessions/${sessionId}/files/${key}`), { content: clean });
    addLog(sessionId, role, 'file_edit', { path, contentLength: clean.length });
    // v2 mirror — file content under sharedArtifacts/files/{key} + diff event in interactions
    if (task && pid) {
      await safeWrite('shared-file', () =>
        update(ref(db, `${sharedFilesPath(task.taskId, mode, sessionId)}/${key}`), { content: clean }));
      try {
        const editRecord = await recordEdit(pid, path, clean);
        if (editRecord.kind === 'full') {
          await pushInteraction(task.taskId, mode, sessionId, pid, 'file_edit_full', {
            path, content: editRecord.content, contentLength: editRecord.contentLength,
            hash: editRecord.hash, truncated: editRecord.truncated,
          });
        } else {
          await pushInteraction(task.taskId, mode, sessionId, pid, 'file_edit_diff', {
            path, unifiedDiff: editRecord.unifiedDiff,
            contentLength: editRecord.contentLength, hash: editRecord.hash,
            prevHash: editRecord.prevHash, truncated: editRecord.truncated,
          });
        }
      } catch (err) { console.warn('[v2 file_edit]', err); }
    }
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
  }, [sessionId, role, task, mode, pid]);

  // Create an empty file in the workspace. Used by the FileTree "+ New file"
  // button when the participant needs to add a deliverable the spec asks for
  // (e.g. tests/test_mathutils.py for the Unit Test Basics task) without
  // dropping into the terminal.
  //
  // The flow is:
  //   1. Backend creates the empty file in the container volume — also
  //      validates path safety and per-task protected-zone rules. We always
  //      go through the backend FIRST so a server-side rejection (403/409)
  //      is surfaced before we touch local state or Firebase.
  //   2. Optimistically add to local React state so Monaco can switch to it.
  //   3. Mirror to Firebase /files so other roles' file trees pick it up
  //      via the existing onValue subscription, AND so the Verifier's
  //      diff baseline treats it as "+ new file".
  // Returns the canonicalized path on success, or null on failure (caller
  // can surface a toast).
  const createFile = useCallback(async (path: string): Promise<string | null> => {
    if (!sessionId || !role) return null;
    const trimmed = path.trim().replace(/^\/+/, '');
    if (!trimmed) return null;

    // Backend first — rejection here means we don't pollute state.
    let ok = false; let canonical = trimmed; let errMsg = '';
    try {
      const r = await fetch(`${BACKEND_API()}/api/session/${sessionId}/create-file`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: trimmed }),
      });
      if (r.ok) {
        const j = await r.json();
        ok = true;
        canonical = (j && typeof j.path === 'string') ? j.path : trimmed;
      } else {
        try {
          const j = await r.json();
          errMsg = (j && typeof j.detail === 'string') ? j.detail : `HTTP ${r.status}`;
        } catch { errMsg = `HTTP ${r.status}`; }
      }
    } catch (e) {
      errMsg = (e instanceof Error) ? e.message : 'network error';
    }
    if (!ok) {
      // Surface the rejection to the user via a window.alert — keeps the
      // failure mode visible without dragging a toast library into the bundle.
      try { window.alert(`Could not create "${trimmed}": ${errMsg}`); } catch { /* ignore */ }
      return null;
    }

    // Optimistically add locally so the editor can switch to it without
    // waiting for the Firebase echo.
    const language = (() => {
      const ext = canonical.split('.').pop() ?? '';
      return ({
        py: 'python', js: 'javascript', ts: 'typescript', tsx: 'typescript',
        go: 'go', sh: 'shell', md: 'markdown', yaml: 'yaml', yml: 'yaml',
        json: 'json', txt: 'plaintext', sql: 'sql',
      } as Record<string, string>)[ext] || 'plaintext';
    })();
    setFiles(prev => {
      if (prev.some(f => f.path === canonical)) return prev;
      return [...prev, { path: canonical, content: '', language, readOnly: false }];
    });

    // Firebase mirror so other roles see the new file immediately.
    const key = canonical.replace(/[.\/\[\]#$]/g, '_');
    try {
      await set(ref(db, `teambench/sessions/${sessionId}/files/${key}`), {
        path: canonical, content: '', language, readOnly: false,
      });
    } catch { /* best-effort */ }
    if (task && pid) {
      await safeWrite('shared-file-create', () =>
        set(ref(db, `${sharedFilesPath(task.taskId, mode, sessionId)}/${key}`), {
          path: canonical, content: '', language, readOnly: false,
        }));
      await pushInteraction(task.taskId, mode, sessionId, pid, 'file_create', { path: canonical });
    }
    addLog(sessionId, role, 'file_create', { path: canonical });
    return canonical;
  }, [sessionId, role, task, mode, pid]);

  // Delete a file from the workspace. Same shape as createFile — backend
  // first (path-safety + protected-zone enforcement), then local state,
  // then Firebase mirror.
  const deleteFile = useCallback(async (path: string): Promise<boolean> => {
    if (!sessionId || !role) return false;
    const trimmed = path.trim();
    if (!trimmed) return false;

    let ok = false; let errMsg = '';
    try {
      const url = `${BACKEND_API()}/api/session/${sessionId}/delete-file?path=${encodeURIComponent(trimmed)}`;
      const r = await fetch(url, { method: 'DELETE' });
      if (r.ok) {
        ok = true;
      } else {
        try {
          const j = await r.json();
          errMsg = (j && typeof j.detail === 'string') ? j.detail : `HTTP ${r.status}`;
        } catch { errMsg = `HTTP ${r.status}`; }
      }
    } catch (e) {
      errMsg = (e instanceof Error) ? e.message : 'network error';
    }
    if (!ok) {
      try { window.alert(`Could not delete "${trimmed}": ${errMsg}`); } catch { /* ignore */ }
      return false;
    }

    // Drop from local state.
    setFiles(prev => prev.filter(f => f.path !== trimmed));

    // Firebase: remove the key by writing null.
    const key = trimmed.replace(/[.\/\[\]#$]/g, '_');
    try {
      await set(ref(db, `teambench/sessions/${sessionId}/files/${key}`), null);
    } catch { /* best-effort */ }
    if (task && pid) {
      await safeWrite('shared-file-delete', () =>
        set(ref(db, `${sharedFilesPath(task.taskId, mode, sessionId)}/${key}`), null));
      await pushInteraction(task.taskId, mode, sessionId, pid, 'file_delete', { path: trimmed });
    }
    addLog(sessionId, role, 'file_delete', { path: trimmed });
    return true;
  }, [sessionId, role, task, mode, pid]);

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
      const finalPayload = {
        capturedAt: Date.now(),
        capturedAtISO: new Date().toISOString(),
        files: entries,
      };
      await set(ref(db, `teambench/sessions/${sid}/finalWorkspace`), finalPayload);
      // v2 mirror
      if (task) {
        await safeWrite('final-ws', () =>
          set(ref(db, sharedFinalWorkspacePath(task.taskId, mode, sid)), finalPayload));
      }
    } catch {
      /* best-effort — grader result is still authoritative for scoring */
    }
  }, [task, mode]);

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
    // v2 mirror — same updates land in meta/, plus phase_change interaction event
    if (task && pid) {
      await safeWrite('meta-update', () =>
        update(ref(db, metaPath(task.taskId, mode, sessionId)), updates));
      await pushInteraction(task.taskId, mode, sessionId, pid, 'phase_change', {
        from: phase, to: newPhase,
      });
    }
  }, [sessionId, role, phase, startTime, task, mode, pid]);

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
    const p = pid;
    // Reset local state first so the UI navigates back instantly even if
    // network calls below stall.
    setSessionId(null);
    setRole(null);
    setPid(null);
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
      // v2 mirror — leave event in interactions
      if (t && p) {
        await pushInteraction(t.taskId, m, sid, p, 'leave', { reason: 'back', mode: m });
      }
      // Drop the resume cookie so a future join starts fresh.
      if (t) {
        try { localStorage.removeItem(`teambench_session_${t.taskId}_${r}_${m}`); } catch {}
      }
      // Snapshot terminal-authored files before we blow the container away.
      // Even for a "Back" click mid-task we want to keep the partial work.
      await persistFinalWorkspace(sid);
      // Hybrid: tell the backend to kill the AI agent subprocesses NOW so
      // they don't burn tokens writing to a dead session. Fire first, then
      // the DELETE /api/session/{sid} below will also stop them as backup.
      if (m === 'hybrid') {
        try {
          await fetch(`${BACKEND_API()}/api/session/${sid}/stop-hybrid`, {
            method: 'POST', keepalive: true,
          });
        } catch { /* best-effort */ }
      }
      // Team / Hybrid mode: signal cancellation so the partner (or remaining
      // agents) sees it.
      if (m === 'team' || m === 'hybrid') {
        const cancelUpdate = { phase: 'cancelled', status: 'cancelled', endTime: Date.now() };
        try {
          await update(ref(db, `teambench/sessions/${sid}`), cancelUpdate);
        } catch { /* best-effort */ }
        // v2 mirror
        if (t) {
          await safeWrite('cancel-meta', () =>
            update(ref(db, metaPath(t.taskId, m, sid)), cancelUpdate));
        }
      }
      // Team mode: if we leave while still in lobby, delete the matching
      // waiting entry so future joiners don't see a ghost slot. Without
      // this, every team-mode user who closes their tab during the wait
      // pollutes teambench/waiting/{taskId} with a dead entry.
      if (m === 'team') {
        try {
          const waitSnap = await get(ref(db, `teambench/waiting/${t?.taskId}`));
          if (waitSnap.exists()) {
            const waiting = waitSnap.val() as Record<string, { sessionId: string }>;
            for (const [waitId, entry] of Object.entries(waiting)) {
              if (entry.sessionId === sid) {
                await set(ref(db, `teambench/waiting/${t?.taskId}/${waitId}`), null);
              }
            }
          }
        } catch { /* best-effort */ }
      }
      // Free the backend container slot (best-effort; works whether or not
      // the session ever had a container).
      try {
        await fetch(`${BACKEND_API()}/api/session/${sid}`, { method: 'DELETE', keepalive: true });
      } catch { /* ignore */ }
    }
  }, [sessionId, task, role, mode, pid]);

  return {
    task, sessionId, role, mode, pid, phase,
    messages: getVisibleMessages(), files: getVisibleFiles(),
    participants, startTime, endTime, joining, waitingForTeam,
    saveStatus,
    join, sendMessage, updateFile, createFile, deleteFile, setPhase, exportLogs, leaveSession,
    addLog: (action: string, detail?: Record<string, unknown>) => {
      if (sessionId && role) addLog(sessionId, role, action, detail ?? {});
      // v2 mirror — every legacy addLog also lands in interactions
      if (sessionId && role && task && pid) {
        void pushInteraction(task.taskId, mode, sessionId, pid, action, detail ?? {});
      }
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
