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

// Per-email localStorage cache. The previous global keys
// (teambench_solved_v1 / _v2) were shared across every profile that ever
// loaded the lobby on a browser, so switching profiles inherited stale
// solved-task badges — exactly the "test1 already attempted" bug. v3 is
// scoped per sanitized email so a new profile starts with an empty cache.
const LS_KEY_BASE = 'teambench_solved_v3:';
const LS_LEGACY_GLOBAL_KEYS = ['teambench_solved_v1', 'teambench_solved_v2'];

// Firebase RTDB forbids `.` `$` `#` `[` `]` `/` in paths. Lowercase + replace.
function sanitizeEmail(email: string): string {
  return (email || '').trim().toLowerCase().replace(/[.\/\[\]#$@]/g, '_');
}

function lsKey(safeEmail: string): string | null {
  return safeEmail ? `${LS_KEY_BASE}${safeEmail}` : null;
}

function readLocal(safeEmail: string): SolvedByModeMap {
  const key = lsKey(safeEmail);
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) || '{}') as SolvedByModeMap;
  } catch {
    return {};
  }
}

function writeLocal(safeEmail: string, store: SolvedByModeMap): void {
  const key = lsKey(safeEmail);
  if (!key) return;
  try { localStorage.setItem(key, JSON.stringify(store)); } catch { /* quota */ }
}

// One-shot: drop the cross-user global caches the first time this module
// loads in a tab. Any per-email data already migrated lives under v3 keys
// and is unaffected; any badges that were "stuck" because of v2 will
// vanish on next paint, then rehydrate from Firebase if real.
let _legacyCleared = false;
function clearLegacyGlobalCacheOnce(): void {
  if (_legacyCleared) return;
  _legacyCleared = true;
  for (const k of LS_LEGACY_GLOBAL_KEYS) {
    try { localStorage.removeItem(k); } catch { /* ignore */ }
  }
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
  clearLegacyGlobalCacheOnce();

  // 1) Local cache update — immediate. Per-email so we don't pollute the
  // next profile that uses this browser.
  if (safeEmail) {
    const local = readLocal(safeEmail);
    const prevByMode = local[taskId] || {};
    prevByMode[mode] = mergeRecord(prevByMode[mode], partial, pass);
    local[taskId] = prevByMode;
    writeLocal(safeEmail, local);
  }

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

  // 3) Global aggregate for the lobby's "N attempted / N completed" badges.
  // Uses presence records keyed by the sanitized email, so:
  //   - re-attempts by the same user don't double-count
  //   - counts are derived cheaply by `Object.keys(...).length` on read
  // No transactions needed (write-same-value is idempotent).
  try {
    await set(ref(db, `teambench/taskStats/${taskId}/attempters/${safeEmail}`), true);
    if (pass) {
      await set(ref(db, `teambench/taskStats/${taskId}/completers/${safeEmail}`), true);
    }
  } catch (err) {
    console.warn('recordTaskAttempt: taskStats write failed', err);
  }
}

/** Aggregate counts derived from teambench/taskStats for lobby badges. */
export interface TaskStats {
  attempters: number;
  completers: number;
}

/**
 * Subscribe to global per-task attempt/completion counts. Emits the full
 * { [taskId]: TaskStats } map on every change, driven by the presence
 * records written in recordTaskAttempt above.
 */
export function subscribeToTaskStats(
  cb: (stats: Record<string, TaskStats>) => void,
): () => void {
  return onValue(ref(db, 'teambench/taskStats'), (snap) => {
    const out: Record<string, TaskStats> = {};
    if (snap.exists()) {
      const data = snap.val() as Record<
        string,
        { attempters?: Record<string, true>; completers?: Record<string, true> }
      >;
      for (const [tid, val] of Object.entries(data || {})) {
        out[tid] = {
          attempters: Object.keys(val?.attempters || {}).length,
          completers: Object.keys(val?.completers || {}).length,
        };
      }
    }
    cb(out);
  });
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
  clearLegacyGlobalCacheOnce();
  const safeEmail = sanitizeEmail(email);
  if (!safeEmail) {
    // No profile yet — show no badges. Critically: do NOT fall back to a
    // shared cache here, that's how stale data leaked to fresh profiles.
    cb({});
    return () => {};
  }

  cb(readLocal(safeEmail)); // paint instantly from THIS user's cache

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
    // Persist this user's per-email cache (Firebase is source-of-truth;
    // the cache is for instant render on next visit). Do NOT merge in
    // any localStorage that didn't come from this email — that was the
    // source of the cross-profile leak.
    writeLocal(safeEmail, out);
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

/** Per-email instant cache for first-paint before the subscription resolves. */
export function loadSolvedFromLocal(email: string): SolvedByModeMap {
  clearLegacyGlobalCacheOnce();
  return readLocal(sanitizeEmail(email));
}
