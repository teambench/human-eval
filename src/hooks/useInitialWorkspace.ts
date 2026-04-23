import { useEffect, useState } from 'react';
import { onValue, ref } from 'firebase/database';
import { db } from '../firebase';

/**
 * Subscribe to the pre-execution workspace snapshot for a session.
 *
 * useFirebaseSession's `fetchOnce` writes this path once staging
 * completes (first-writer wins), so the Verifier (and now Planner and
 * Executor) can compute a path-keyed diff between the initial state
 * and the live `files` state — i.e. "which files has the Executor
 * changed so far?".
 *
 * Returns a `{ [path]: content }` map. Empty until staging + the
 * initial write complete. `enabled=false` opts out (useful if a view
 * only wants the subscription in certain phases).
 */
interface InitialFile {
  path: string;
  content: string;
}

export function useInitialWorkspace(
  sessionId: string | null,
  enabled: boolean = true,
): Record<string, string> {
  const [files, setFiles] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled || !sessionId) return;
    return onValue(
      ref(db, `teambench/sessions/${sessionId}/initialWorkspace`),
      (snap) => {
        if (!snap.exists()) {
          setFiles({});
          return;
        }
        const out: Record<string, string> = {};
        const data = snap.val() as Record<string, InitialFile>;
        for (const v of Object.values(data)) {
          if (v?.path != null) out[v.path] = v.content ?? '';
        }
        setFiles(out);
      },
    );
  }, [sessionId, enabled]);
  return files;
}
