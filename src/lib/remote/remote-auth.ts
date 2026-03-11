/**
 * Remote mode authentication.
 * Token-based auth for external connections.
 */

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

export async function validateToken(token: string): Promise<boolean> {
  const stored = await chrome.storage.local.get(TOKEN_STORAGE_KEY);
  return stored[TOKEN_STORAGE_KEY] === token;
}

export async function regenerateToken(): Promise<string> {
  const token = generateToken();
  await chrome.storage.local.set({ [TOKEN_STORAGE_KEY]: token });
  return token;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
