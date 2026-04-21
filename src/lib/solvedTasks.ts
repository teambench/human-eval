import { ref, get, set, onValue } from 'firebase/database';
import { db } from '../firebase';

/**
 * Cross-session per-user task-attempt persistence.
 *
 * The survey/session/chat data is already in Firebase, so task-attempt
 * history should be too — it lets participants see "already tried" across
 * devices and browsers, and it gives the analysis a durable record that
 * survives localStorage wipes / incognito sessions.
 *
 * Shape:  teambench/users/{sanitized_email}/solved/{taskId} = {
 *   bestPartial: number (0..1),
 *   pass: boolean,
 *   attempts: number,
 *   lastGradedISO: string,
 * }
 *
 * We also mirror to localStorage (`teambench_solved_v1`) so the picker
 * renders badges instantly without waiting for a Firebase round-trip,
 * and works briefly offline.
 */

export interface SolvedRecord {
  bestPartial: number;
  pass: boolean;
  attempts: number;
  lastGradedISO: string;
}

const LS_KEY = 'teambench_solved_v1';

// Firebase RTDB forbids `.` `$` `#` `[` `]` `/` in paths. Lowercase + replace.
function sanitizeEmail(email: string): string {
  return (email || '').trim().toLowerCase().replace(/[.\/\[\]#$@]/g, '_');
}

function readLocal(): Record<string, SolvedRecord> {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeLocal(store: Record<string, SolvedRecord>) {
  try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch { /* quota */ }
}

/**
 * Record a grading attempt. Writes to both Firebase (source of truth) and
 * localStorage (instant-read cache). Increments attempts counter and takes
 * the max bestPartial / OR of pass.
 */
export async function recordTaskAttempt(
  email: string,
  taskId: string,
  partial: number,
  pass: boolean,
) {
  const safeEmail = sanitizeEmail(email);
  const now = new Date().toISOString();

  // 1) Local cache update — immediate.
  const local = readLocal();
  const prev = local[taskId] || { bestPartial: 0, pass: false, attempts: 0, lastGradedISO: '' };
  const merged: SolvedRecord = {
    bestPartial: Math.max(prev.bestPartial ?? 0, partial),
    pass: pass || prev.pass === true,
    attempts: (prev.attempts ?? 0) + 1,
    lastGradedISO: now,
  };
  local[taskId] = merged;
  writeLocal(local);

  // 2) Firebase — if no email, skip (shouldn't happen; profile requires it).
  if (!safeEmail) return;
  try {
    const fbRef = ref(db, `teambench/users/${safeEmail}/solved/${taskId}`);
    const prevSnap = await get(fbRef);
    const prevFb: SolvedRecord | undefined = prevSnap.exists() ? prevSnap.val() : undefined;
    await set(fbRef, {
      bestPartial: Math.max(prevFb?.bestPartial ?? 0, partial),
      pass: pass || prevFb?.pass === true,
      attempts: (prevFb?.attempts ?? 0) + 1,
      lastGradedISO: now,
    });
  } catch (err) {
    // Firebase hiccup — localStorage still has the record for the current session.
    console.warn('recordTaskAttempt: Firebase write failed', err);
  }
}

/**
 * Subscribe to the current user's solved-task map. Returns an unsubscribe
 * function. Callback receives the full map (possibly empty).
 *
 * Populates localStorage with each received snapshot so the badge renders
 * instantly on next lobby visit even before the Firebase read completes.
 */
export function subscribeToUserSolved(
  email: string,
  cb: (solved: Record<string, SolvedRecord>) => void,
): () => void {
  const safeEmail = sanitizeEmail(email);
  if (!safeEmail) {
    cb(readLocal());
    return () => {};
  }
  // Fire localStorage immediately so UI paints without flicker.
  cb(readLocal());
  const fbRef = ref(db, `teambench/users/${safeEmail}/solved`);
  const unsub = onValue(fbRef, (snap) => {
    const data: Record<string, SolvedRecord> = snap.val() || {};
    // Merge with local (keep any local-only tasks if Firebase is sparse).
    const local = readLocal();
    const merged = { ...local, ...data };
    writeLocal(merged);
    cb(merged);
  });
  return unsub;
}

export function loadSolvedFromLocal(): Record<string, SolvedRecord> {
  return readLocal();
}
