import { test, expect, describe, beforeEach } from 'vitest';
import { recordEdit, resetCacheForTesting, MAX_CONTENT_BYTES } from '../fileDiff';

describe('recordEdit', () => {
  beforeEach(() => resetCacheForTesting());

  test('first edit returns kind="full"', async () => {
    const r = await recordEdit('pid1', 'app/main.py', 'print("hi")\n');
    expect(r.kind).toBe('full');
    if (r.kind === 'full') {
      expect(r.content).toBe('print("hi")\n');
      expect(r.contentLength).toBe(12);
      expect(r.hash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.truncated).toBe(false);
    }
  });

  test('second edit returns kind="diff" with unifiedDiff and prevHash', async () => {
    await recordEdit('pid1', 'app/main.py', 'print("hi")\n');
    const r = await recordEdit('pid1', 'app/main.py', 'print("bye")\n');
    expect(r.kind).toBe('diff');
    if (r.kind === 'diff') {
      expect(r.unifiedDiff).toContain('-print("hi")');
      expect(r.unifiedDiff).toContain('+print("bye")');
      expect(r.prevHash).toMatch(/^[0-9a-f]{64}$/);
      expect(r.hash).not.toBe(r.prevHash);
      expect(r.truncated).toBe(false);
    }
  });

  test('different participant on same path is independent', async () => {
    await recordEdit('pid1', 'app/main.py', 'print("hi")\n');
    const r = await recordEdit('pid2', 'app/main.py', 'print("hi")\n');
    expect(r.kind).toBe('full');
  });

  test('different path for same participant is independent', async () => {
    await recordEdit('pid1', 'app/main.py', 'a');
    const r = await recordEdit('pid1', 'app/other.py', 'b');
    expect(r.kind).toBe('full');
  });

  test('content over MAX_CONTENT_BYTES is truncated and flagged', async () => {
    const big = 'x'.repeat(MAX_CONTENT_BYTES + 100);
    const r = await recordEdit('pid1', 'big.txt', big);
    expect(r.kind).toBe('full');
    if (r.kind === 'full') {
      expect(r.truncated).toBe(true);
      expect(r.content.length).toBe(MAX_CONTENT_BYTES);
      expect(r.contentLength).toBe(MAX_CONTENT_BYTES + 100); // original length
    }
  });

  test('hash is over the full untruncated content (re-record same content has matching prevHash)', async () => {
    const big = 'x'.repeat(MAX_CONTENT_BYTES + 100);
    const r1 = await recordEdit('pid1', 'big.txt', big);
    const r2 = await recordEdit('pid1', 'big.txt', big);
    if (r1.kind === 'full' && r2.kind === 'diff') {
      expect(r2.prevHash).toBe(r1.hash);
    } else {
      throw new Error('Expected r1=full and r2=diff');
    }
  });
});
