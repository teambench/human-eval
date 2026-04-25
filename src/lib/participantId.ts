/**
 * Stable, anonymized participant id derived from email. Lives ONLY as
 * a key/index — the email itself is still stored in profile/email so
 * post-hoc contact (compensation, follow-up) is unaffected.
 */

export async function sha256Hex(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', buf);
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function participantIdFromEmail(email: string): Promise<string> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) throw new Error('participantIdFromEmail: email must not be empty');
  return (await sha256Hex(normalized)).slice(0, 12);
}

// Firebase RTDB keys cannot contain  .  /  [  ]  #  $
export function escapeFirebaseKey(path: string): string {
  return path.replace(/[./[\]#$]/g, '_');
}
