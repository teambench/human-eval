import { ref, get, set, onValue } from 'firebase/database';
import { db } from '../firebase';

/**
 * Cross-session per-user PER-MODE task-attempt persistence.
 *
 * The user explicitly wanted progress reported per (task, mode) — they'll
 * have a different status in Solo vs Team vs Hybrid for the same task.
 * Old schema was flat per-task. New schema:
 *
 *   teambench/users/{sanitized_email}/solvedByMode/{taskId}/{mode} =
 *     SolvedRecord
 *
 * The legacy `solved/{taskId}` (flat) path is still read for backward
 * compat — it gets attributed to mode='oracle' since that was the only
 * mode that wrote there.
 */

export type ModeKey = 'team' | 'oracle' | 'hybrid';

export interface SolvedRecord {
  bestPartial: number;
  pass: boolean;
  attempts: number;
  lastGradedISO: string;
}

export type SolvedByModeMap =
  Record<string, Partial<Record<ModeKey, SolvedRecord>>>;

/** Convenience: status for one (task, mode) pair, for badge rendering. */
export type ModeStatus = 'done' | 'attempted' | 'not_started';
export function statusFor(rec?: SolvedRecord): ModeStatus {
  if (!rec) return 'not_started';
  if (rec.pass) return 'done';
  if ((rec.attempts ?? 0) > 0) return 'attempted';
  return 'not_started';
}

const LS_KEY = 'teambench_solved_v2';
const LS_LEGACY_KEY = 'teambench_solved_v1';

// Firebase RTDB forbids `.` `$` `#` `[` `]` `/` in paths. Lowercase + replace.
function sanitizeEmail(email: string): string {
  return (email || '').trim().toLowerCase().replace(/[.\/\[\]#$@]/g, '_');
}

function readLocal(): SolvedByModeMap {
  try {
    const v2 = JSON.parse(localStorage.getItem(LS_KEY) || '{}') as SolvedByModeMap;
    if (Object.keys(v2).length > 0) return v2;
    // Migrate v1 → v2 (old flat records were Oracle-only).
    const v1 = JSON.parse(localStorage.getItem(LS_LEGACY_KEY) || '{}') as Record<string, SolvedRecord>;
    const out: SolvedByModeMap = {};
    for (const [tid, rec] of Object.entries(v1)) {
      out[tid] = { oracle: rec };
    }
    return out;
  } catch {
    return {};
  }
}

function writeLocal(store: SolvedByModeMap) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch { /* quota */ }
}

function mergeRecord(prev: SolvedRecord | undefined, partial: number, pass: boolean): SolvedRecord {
  return {
    bestPartial: Math.max(prev?.bestPartial ?? 0, partial),
    pass: pass || prev?.pass === true,
    attempts: (prev?.attempts ?? 0) + 1,
    lastGradedISO: new Date().toISOString(),
  };
}

/**
 * Record a grading attempt for (task, mode). Writes to Firebase (source
 * of truth at users/{email}/solvedByMode/{taskId}/{mode}) and mirrors to
 * localStorage so badges render instantly on next lobby visit.
 */
export async function recordTaskAttempt(
  email: string,
  taskId: string,
  mode: ModeKey,
  partial: number,
  pass: boolean,
) {
  const safeEmail = sanitizeEmail(email);

  // 1) Local cache update — immediate.
  const local = readLocal();
  const prevByMode = local[taskId] || {};
  prevByMode[mode] = mergeRecord(prevByMode[mode], partial, pass);
  local[taskId] = prevByMode;
  writeLocal(local);

  // 2) Firebase write under the new per-mode path.
  if (!safeEmail) return;
  try {
    const fbRef = ref(db, `teambench/users/${safeEmail}/solvedByMode/${taskId}/${mode}`);
    const prevSnap = await get(fbRef);
    const prev: SolvedRecord | undefined = prevSnap.exists() ? prevSnap.val() : undefined;
    await set(fbRef, mergeRecord(prev, partial, pass));
  } catch (err) {
    console.warn('recordTaskAttempt: Firebase write failed', err);
  }
}

/**
 * Subscribe to the current user's per-mode solved map. Returns an
 * unsubscribe. Reads BOTH new (solvedByMode) and legacy (solved) paths
 * — legacy records are attributed to mode='oracle' for back-compat.
 */
export function subscribeToUserSolved(
  email: string,
  cb: (solved: SolvedByModeMap) => void,
): () => void {
  const safeEmail = sanitizeEmail(email);
  if (!safeEmail) {
    cb(readLocal());
    return () => {};
  }

  cb(readLocal()); // paint instantly from cache

  // Track partial state from both subscriptions and merge.
  let modal: SolvedByModeMap = {};
  let legacy: Record<string, SolvedRecord> = {};

  const emit = () => {
    const out: SolvedByModeMap = {};
    // Start with new shape.
    for (const [tid, byMode] of Object.entries(modal)) {
      out[tid] = { ...byMode };
    }
    // Overlay legacy as oracle if not already present.
    for (const [tid, rec] of Object.entries(legacy)) {
      out[tid] = out[tid] || {};
      if (!out[tid].oracle) out[tid].oracle = rec;
    }
    // Merge with localStorage (keep local-only entries).
    const local = readLocal();
    for (const [tid, byMode] of Object.entries(local)) {
      out[tid] = { ...(byMode as any), ...(out[tid] || {}) };
    }
    writeLocal(out);
    cb(out);
  };

  const unsubNew = onValue(
    ref(db, `teambench/users/${safeEmail}/solvedByMode`),
    snap => { modal = snap.val() || {}; emit(); },
  );
  const unsubLegacy = onValue(
    ref(db, `teambench/users/${safeEmail}/solved`),
    snap => { legacy = snap.val() || {}; emit(); },
  );

  return () => { unsubNew(); unsubLegacy(); };
}

export function loadSolvedFromLocal(): SolvedByModeMap {
  return readLocal();
}
