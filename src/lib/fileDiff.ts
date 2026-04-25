/**
 * Per-(participant, path) edit cache for file_edit_full / file_edit_diff
 * event generation. First save → emits full content. Subsequent saves → emits
 * unified diff vs the cached previous content. Cache resets on page reload
 * (acceptable; analysis can detect resume boundaries via prevHash:null).
 */
import { createTwoFilesPatch } from 'diff';
import { sha256Hex } from './participantId';

export const MAX_CONTENT_BYTES = 50 * 1024;

export type EditRecord =
  | { kind: 'full'; content: string; contentLength: number; hash: string; truncated: boolean }
  | {
      kind: 'diff';
      unifiedDiff: string;
      contentLength: number;
      hash: string;
      prevHash: string;
      truncated: boolean;
    };

interface CacheEntry {
  content: string; // untruncated
  hash: string;
}

const cache = new Map<string, CacheEntry>();

function key(pid: string, path: string): string {
  return `${pid}|${path}`;
}

function truncate(content: string): { sliced: string; truncated: boolean } {
  if (content.length <= MAX_CONTENT_BYTES) {
    return { sliced: content, truncated: false };
  }
  return { sliced: content.slice(0, MAX_CONTENT_BYTES), truncated: true };
}

export async function recordEdit(
  pid: string, path: string, content: string,
): Promise<EditRecord> {
  const k = key(pid, path);
  const prev = cache.get(k);
  const hash = await sha256Hex(content);
  const { sliced, truncated } = truncate(content);

  if (!prev) {
    cache.set(k, { content, hash });
    return {
      kind: 'full',
      content: sliced,
      contentLength: content.length,
      hash,
      truncated,
    };
  }

  const unifiedDiff = createTwoFilesPatch(path, path, prev.content, content, '', '');
  cache.set(k, { content, hash });
  return {
    kind: 'diff',
    unifiedDiff,
    contentLength: content.length,
    hash,
    prevHash: prev.hash,
    truncated,
  };
}

/** Test-only — not for production use. */
export function resetCacheForTesting(): void {
  cache.clear();
}
