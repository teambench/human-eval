import { test, expect, describe } from 'vitest';
import { sha256Hex, participantIdFromEmail, escapeFirebaseKey } from '../participantId';

describe('sha256Hex', () => {
  test('returns 64-char lowercase hex', async () => {
    const out = await sha256Hex('alice@mit.edu');
    expect(out).toMatch(/^[0-9a-f]{64}$/);
  });

  test('is deterministic', async () => {
    const a = await sha256Hex('alice@mit.edu');
    const b = await sha256Hex('alice@mit.edu');
    expect(a).toBe(b);
  });

  test('differs for different inputs', async () => {
    const a = await sha256Hex('alice@mit.edu');
    const b = await sha256Hex('bob@mit.edu');
    expect(a).not.toBe(b);
  });
});

describe('participantIdFromEmail', () => {
  test('returns 12 hex chars', async () => {
    const id = await participantIdFromEmail('alice@mit.edu');
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test('lowercases and trims input before hashing', async () => {
    const a = await participantIdFromEmail('Alice@MIT.edu');
    const b = await participantIdFromEmail('  alice@mit.edu  ');
    expect(a).toBe(b);
  });

  test('throws on empty input', async () => {
    await expect(participantIdFromEmail('')).rejects.toThrow(/email/);
    await expect(participantIdFromEmail('   ')).rejects.toThrow(/email/);
  });
});

describe('escapeFirebaseKey', () => {
  test('replaces forbidden chars with underscore', () => {
    expect(escapeFirebaseKey('app/main.py')).toBe('app_main_py');
    expect(escapeFirebaseKey('a.b#c$d[e]/f')).toBe('a_b_c_d_e__f');
  });

  test('preserves allowed chars', () => {
    expect(escapeFirebaseKey('plain_path-1')).toBe('plain_path-1');
  });
});
