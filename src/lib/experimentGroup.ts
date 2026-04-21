/**
 * Deterministic experiment-group assignment.
 *
 * Every session used to be tagged `experimentGroup: 'pilot'`, which made
 * between-subjects analysis impossible. Now each participant is hashed
 * (FNV-1a on lowercased email) into one of two groups so we can stratify
 * solo vs team results post-hoc. Each participant stays in the same group
 * across all their sessions, so within-subject repeats don't pollute the
 * between-subjects contrast.
 *
 * `experimentRound` is the rolling cohort tag — bump when protocol /
 * task set changes materially.
 */

export const EXPERIMENT_ROUND = '2026-04-pilot';

export function groupForEmail(email: string | undefined | null): 'A' | 'B' {
  const s = (email || '').trim().toLowerCase();
  if (!s) return 'A'; // Missing email → default bucket; still deterministic.
  let hash = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    hash ^= s.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash & 1) === 0 ? 'A' : 'B';
}
