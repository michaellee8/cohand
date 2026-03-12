/**
 * Remote mode authentication.
 * Token-based auth for external connections.
 */

import { clearActiveSessions } from './remote-server';

const TOKEN_STORAGE_KEY = 'remote_auth_token';

export async function getOrCreateToken(): Promise<string> {
  const result = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  if (result[TOKEN_STORAGE_KEY]) {
    return result[TOKEN_STORAGE_KEY] as string;
  }

  // Generate a new token
  const token = generateToken();
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
  return token;
}

/**
 * Timing-safe string comparison to prevent timing attacks.
 * Compares two strings byte-by-byte with constant time using XOR accumulator.
 */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    // Still do a dummy comparison to avoid leaking length info via timing
    let acc = 1; // non-zero because lengths differ
    for (let i = 0; i < a.length; i++) {
      acc |= a.charCodeAt(i) ^ a.charCodeAt(i);
    }
    return acc === 0;
  }
  let acc = 0;
  for (let i = 0; i < a.length; i++) {
    acc |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return acc === 0;
}

export async function validateToken(token: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  const storedToken = stored[TOKEN_STORAGE_KEY];
  // Guard against undefined===undefined: if no token is stored, always reject
  if (!storedToken) {
    return false;
  }
  return timingSafeEqual(storedToken as string, token);
}

export async function regenerateToken(): Promise<string> {
  const token = generateToken();
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
  // Invalidate all active sessions when token is regenerated
  clearActiveSessions();
  return token;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
