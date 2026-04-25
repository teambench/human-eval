/**
 * Pre-join lobby checks. Surfaced in LobbyView as confirmation modals so
 * participants don't (a) end up in a team session with strangers without
 * realizing it, or (b) accidentally start a second concurrent session
 * while another is still active in another tab.
 *
 * Both helpers read from Firebase directly via the SDK; they are safe to
 * call before `useFirebaseSession.join()` and will not mutate any state.
 */
import { ref, get, update } from 'firebase/database';
import { db } from '../firebase';
import { Role, SessionMode } from '../types';
import { participantIdFromEmail } from './participantId';
import { metaPath, participantsIndexSessionPath } from './firebasePaths';
import { getHostSync } from './regionRouter';

export interface JoinablePeekParticipant {
  role: string;
  name: string;
  institution: string;
}

export interface JoinablePeek {
  sessionId: string;
  waitId: string;
  taskId: string;
  participants: JoinablePeekParticipant[];
}

export interface ActiveSessionRef {
  sessionId: string;
  taskId: string;
  mode: SessionMode;
  role: string;
  status: string;
  startTime: number | null;
}

const STALE_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Find a waiting team that the user could join under their requested role.
 * Applies the same skip rules as findOrCreateTeam (stale, non-lobby phase,
 * already contains this person) so we never preview an unjoinable team.
 *
 * Returns null if no joinable team is found — caller should fall through
 * and create a new waiting room.
 */
export async function findJoinableTeam(
  taskId: string,
  role: Role,
  joinerEmail: string,
  excludeSessionIds: Set<string> = new Set(),
): Promise<JoinablePeek | null> {
  if (!joinerEmail) return null;
  const joinerPid = await participantIdFromEmail(joinerEmail);
  const normalizedEmail = joinerEmail.trim().toLowerCase();

  const waitSnap = await get(ref(db, `teambench/waiting/${taskId}`));
  if (!waitSnap.exists()) return null;
  const waiting = waitSnap.val() as Record<
    string,
    { sessionId: string; roles: Record<string, boolean> }
  >;
  const nowMs = Date.now();

  for (const [waitId, entry] of Object.entries(waiting)) {
    if (!entry.sessionId) continue;
    if (excludeSessionIds.has(entry.sessionId)) continue;
    if (entry.roles?.[role]) continue; // role slot already filled

    const sessSnap = await get(ref(db, `teambench/sessions/${entry.sessionId}`));
    if (!sessSnap.exists()) continue;
    const sess = sessSnap.val();
    if (sess.phase !== 'lobby') continue;
    if (typeof sess.createdAt === 'number' && nowMs - sess.createdAt > STALE_THRESHOLD_MS) continue;

    // Same-person dedup against legacy participants dict.
    const legacyParts = (sess.participants || {}) as Record<string, { email?: string; name?: string; institution?: string }>;
    const sameHumanInLegacy = Object.values(legacyParts).some(
      p => (p?.email || '').trim().toLowerCase() === normalizedEmail
    );
    if (sameHumanInLegacy) continue;

    // Same-person dedup against new tree participants index.
    const v2Snap = await get(ref(db, `teambench_new/tasks/${taskId}/team/sessions/${entry.sessionId}/participants/${joinerPid}`));
    if (v2Snap.exists()) continue;

    // Build participant preview list (skip empty slots).
    const participants: JoinablePeekParticipant[] = Object.entries(legacyParts)
      .filter(([_r, p]) => !!p?.name)
      .map(([r, p]) => ({
        role: r,
        name: p.name || '(unnamed)',
        institution: p.institution || '',
      }));

    return {
      sessionId: entry.sessionId,
      waitId,
      taskId,
      participants,
    };
  }
  return null;
}

/**
 * Find any other sessions in which this email/pid is currently an active
 * participant — across all tasks/modes. Used to warn the user before they
 * inadvertently start a second concurrent session.
 *
 * Reads the cross-task index at teambench_new/participants/{pid}/sessions
 * (cheap; one shallow read).
 */
export async function getActiveSessionsForEmail(
  email: string,
): Promise<ActiveSessionRef[]> {
  if (!email) return [];
  const pid = await participantIdFromEmail(email);
  const snap = await get(ref(db, `teambench_new/participants/${pid}/sessions`));
  if (!snap.exists()) return [];

  const entries = snap.val() as Record<
    string,
    { taskId?: string; mode?: SessionMode; role?: string; status?: string; startTime?: number }
  >;
  const out: ActiveSessionRef[] = [];

  for (const [sid, idx] of Object.entries(entries)) {
    if (idx.status !== 'active' && idx.status !== 'waiting') continue;
    // Confirm against the real session — index can be stale if the user
    // closed a tab without going through leaveSession.
    const sess = await get(ref(db, `teambench/sessions/${sid}`));
    if (!sess.exists()) continue;
    const data = sess.val();
    if (data.phase === 'completed' || data.phase === 'cancelled') continue;
    if (data.status === 'cancelled' || data.status === 'completed') continue;

    out.push({
      sessionId: sid,
      taskId: idx.taskId || data.taskId || '(unknown)',
      mode: (idx.mode || data.mode || 'team') as SessionMode,
      role: idx.role || '(unknown)',
      status: data.status || idx.status || '(unknown)',
      startTime: idx.startTime || data.startTime || null,
    });
  }
  return out;
}

// Re-export the index path so view code can use it without a second import.
export { participantsIndexSessionPath };

/**
 * Mark another session cancelled so the orphan doesn't sit in the user's
 * "active" list forever. Best-effort across both legacy + new tree.
 *
 * Used by the multi-session modal's "leave that one and continue here"
 * button. Idempotent — safe to call on already-cancelled sessions.
 */
export async function cancelOtherSession(s: ActiveSessionRef): Promise<void> {
  const now = Date.now();
  const cancelUpdate = {
    phase: 'cancelled',
    status: 'cancelled',
    endTime: now,
    endTimeISO: new Date(now).toISOString(),
  };
  // Legacy tree (live UI source).
  try {
    await update(ref(db, `teambench/sessions/${s.sessionId}`), cancelUpdate);
  } catch (err) {
    console.warn('[cancelOtherSession legacy]', err);
  }
  // New tree meta.
  try {
    await update(ref(db, metaPath(s.taskId, s.mode, s.sessionId)), cancelUpdate);
  } catch (err) {
    console.warn('[cancelOtherSession v2 meta]', err);
  }
  // Free the backend container slot. Best-effort; if it fails the
  // CONTAINER_TIMEOUT (1h) sweeper on the backend will eventually reap it.
  try {
    const host = getHostSync();
    await fetch(`https://${host}/api/session/${s.sessionId}`, {
      method: 'DELETE', keepalive: true,
    });
  } catch { /* ignore */ }
}
