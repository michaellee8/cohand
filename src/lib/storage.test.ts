import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_SETTINGS,
  getSettings,
  setSettings,
  getDomainPermissions,
  addDomainPermission,
  removeDomainPermission,
  getStorageSchemaVersion,
  migrateStorage,
  getEncryptedTokens,
  setEncryptedTokens,
  getEncryptionKeyEncoded,
  setEncryptionKeyEncoded,
} from './storage';
import {
  generateEncryptionKey,
  exportKey,
  importKey,
  encrypt,
  decrypt,
} from './crypto';
import type { DomainPermission, Settings } from '../types';

function createMockChromeStorage() {
  const store: Record<string, unknown> = {};
  return {
    local: {
      get: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        const result: Record<string, unknown> = {};
        for (const k of keyList) {
          if (k in store) result[k] = store[k];
        }
        return result;
      },
      set: async (items: Record<string, unknown>) => {
        Object.assign(store, items);
      },
      remove: async (keys: string | string[]) => {
        const keyList = typeof keys === 'string' ? [keys] : keys;
        for (const k of keyList) delete store[k];
      },
    },
  };
}

beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: createMockChromeStorage(),
  };
});

describe('getSettings', () => {
  it('returns DEFAULT_SETTINGS when storage is empty', async () => {
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });

  it('returns stored settings when present', async () => {
    const custom: Settings = {
      llmProvider: 'anthropic',
      llmModel: 'claude-4',
      yoloMode: true,
      language: 'ja',
    };
    await setSettings(custom);
    const settings = await getSettings();
    expect(settings).toEqual(custom);
  });
});

describe('setSettings', () => {
  it('round-trips with getSettings', async () => {
    const s: Settings = {
      llmProvider: 'openai',
      llmModel: 'gpt-5.4',
      yoloMode: false,
      language: 'en',
      llmBaseUrl: 'https://api.example.com',
    };
    await setSettings(s);
    const result = await getSettings();
    expect(result).toEqual(s);
  });
});

describe('getDomainPermissions', () => {
  it('returns empty array when storage is empty', async () => {
    const perms = await getDomainPermissions();
    expect(perms).toEqual([]);
  });
});

describe('addDomainPermission', () => {
  it('adds a new permission', async () => {
    const perm: DomainPermission = {
      domain: 'example.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    };
    await addDomainPermission(perm);
    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0]).toEqual(perm);
  });

  it('deduplicates by domain', async () => {
    const perm1: DomainPermission = {
      domain: 'example.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    };
    const perm2: DomainPermission = {
      domain: 'example.com',
      grantedAt: '2026-03-08T00:00:00Z',
      grantedBy: 'task_creation',
    };
    await addDomainPermission(perm1);
    await addDomainPermission(perm2);
    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0]).toEqual(perm1); // keeps original
  });

  it('adds multiple different domains', async () => {
    await addDomainPermission({
      domain: 'a.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    });
    await addDomainPermission({
      domain: 'b.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    });
    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(2);
  });
});

describe('removeDomainPermission', () => {
  it('removes a permission by domain', async () => {
    await addDomainPermission({
      domain: 'example.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    });
    await removeDomainPermission('example.com');
    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(0);
  });

  it('is a no-op for non-existent domain', async () => {
    await addDomainPermission({
      domain: 'keep.com',
      grantedAt: '2026-03-07T00:00:00Z',
      grantedBy: 'user',
    });
    await removeDomainPermission('other.com');
    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].domain).toBe('keep.com');
  });
});

describe('getStorageSchemaVersion', () => {
  it('returns 0 when storage is empty', async () => {
    const version = await getStorageSchemaVersion();
    expect(version).toBe(0);
  });
});

describe('migrateStorage', () => {
  it('sets schema version to 1 and populates defaults', async () => {
    await migrateStorage();
    const version = await getStorageSchemaVersion();
    expect(version).toBe(1);
    const settings = await getSettings();
    expect(settings).toEqual(DEFAULT_SETTINGS);
    const perms = await getDomainPermissions();
    expect(perms).toEqual([]);
  });

  it('does not overwrite existing settings on migration', async () => {
    const custom: Settings = {
      llmProvider: 'anthropic',
      llmModel: 'claude-4',
      yoloMode: true,
      language: 'ja',
    };
    await setSettings(custom);
    await migrateStorage();
    const settings = await getSettings();
    expect(settings).toEqual(custom);
  });

  it('is idempotent when already at version 1', async () => {
    await migrateStorage();
    const custom: Settings = {
      llmProvider: 'gemini',
      llmModel: 'gemini-pro',
      yoloMode: false,
      language: 'fr',
    };
    await setSettings(custom);
    await migrateStorage(); // run again
    const settings = await getSettings();
    expect(settings).toEqual(custom); // should not revert
  });
});

describe('encrypted tokens', () => {
  it('returns empty object when storage is empty', async () => {
    const tokens = await getEncryptedTokens();
    expect(tokens).toEqual({});
  });

  it('round-trips encrypted tokens', async () => {
    const tokens = { oauthToken: 'enc-abc', apiKey: 'enc-xyz' };
    await setEncryptedTokens(tokens);
    const result = await getEncryptedTokens();
    expect(result).toEqual(tokens);
  });
});

describe('encryption key encoded', () => {
  it('returns null when storage is empty', async () => {
    const key = await getEncryptionKeyEncoded();
    expect(key).toBeNull();
  });

  it('round-trips an encoded key', async () => {
    await setEncryptionKeyEncoded('base64encodedkey==');
    const result = await getEncryptionKeyEncoded();
    expect(result).toBe('base64encodedkey==');
  });
});

describe('crypto', () => {
  it('generates a key, exports and re-imports it', async () => {
    const key = await generateEncryptionKey();
    const encoded = await exportKey(key);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);
    const reimported = await importKey(encoded);
    expect(reimported).toBeInstanceOf(CryptoKey);
  });

  it('encrypt then decrypt round-trips plaintext', async () => {
    const key = await generateEncryptionKey();
    const plaintext = 'my-secret-token-12345';
    const encrypted = await encrypt(key, plaintext);
    expect(encrypted).not.toBe(plaintext);
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypts to different ciphertexts each time (random IV)', async () => {
    const key = await generateEncryptionKey();
    const plaintext = 'same-input';
    const enc1 = await encrypt(key, plaintext);
    const enc2 = await encrypt(key, plaintext);
    expect(enc1).not.toBe(enc2);
    // Both still decrypt to the same value
    expect(await decrypt(key, enc1)).toBe(plaintext);
    expect(await decrypt(key, enc2)).toBe(plaintext);
  });

  it('handles empty string', async () => {
    const key = await generateEncryptionKey();
    const encrypted = await encrypt(key, '');
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe('');
  });

  it('handles unicode content', async () => {
    const key = await generateEncryptionKey();
    const plaintext = 'Hello, world! Bonjour, le monde!';
    const encrypted = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, encrypted);
    expect(decrypted).toBe(plaintext);
  });
});
