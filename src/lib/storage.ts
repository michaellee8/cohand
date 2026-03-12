import type { Settings, DomainPermission, EncryptedTokens, EncryptedCodexOAuth } from '../types';
import { DEFAULT_LLM_MODEL } from '../constants';

export const DEFAULT_SETTINGS: Settings = {
  llmProvider: 'chatgpt-subscription',
  llmModel: DEFAULT_LLM_MODEL,
  yoloMode: false,
  language: 'en',
};

export async function getSettings(): Promise<Settings> {
  const result = await chrome.storage.local.get('settings') as { settings?: Settings };
  return result.settings ?? DEFAULT_SETTINGS;
}

export async function setSettings(settings: Settings): Promise<void> {
  await chrome.storage.local.set({ settings });
}

export async function getDomainPermissions(): Promise<DomainPermission[]> {
  const result = await chrome.storage.local.get('domainPermissions') as { domainPermissions?: DomainPermission[] };
  return result.domainPermissions ?? [];
}

export async function addDomainPermission(permission: DomainPermission): Promise<void> {
  const existing = await getDomainPermissions();
  // Don't add duplicates
  if (existing.some(p => p.domain === permission.domain)) return;
  await chrome.storage.local.set({ domainPermissions: [...existing, permission] });
}

export async function removeDomainPermission(domain: string): Promise<void> {
  const existing = await getDomainPermissions();
  await chrome.storage.local.set({
    domainPermissions: existing.filter(p => p.domain !== domain),
  });
}

export async function getStorageSchemaVersion(): Promise<number> {
  const result = await chrome.storage.local.get('_storageSchemaVersion') as { _storageSchemaVersion?: number };
  return result._storageSchemaVersion ?? 0;
}

export async function migrateStorage(): Promise<void> {
  const version = await getStorageSchemaVersion();
  if (version < 1) {
    // v0 -> v1: ensure defaults exist
    const settings = await getSettings();
    await chrome.storage.local.set({
      settings,
      domainPermissions: await getDomainPermissions(),
      _storageSchemaVersion: 1,
    });
  }
}

// Token storage (encrypted)
export async function getEncryptedTokens(): Promise<EncryptedTokens> {
  const result = await chrome.storage.local.get('encryptedTokens') as { encryptedTokens?: EncryptedTokens };
  return result.encryptedTokens ?? {};
}

export async function setEncryptedTokens(tokens: EncryptedTokens): Promise<void> {
  await chrome.storage.local.set({ encryptedTokens: tokens });
}

// Encryption key storage
export async function getEncryptionKeyEncoded(): Promise<string | null> {
  const result = await chrome.storage.local.get('_encryptionKey') as { _encryptionKey?: string };
  return result._encryptionKey ?? null;
}

export async function setEncryptionKeyEncoded(key: string): Promise<void> {
  await chrome.storage.local.set({ _encryptionKey: key });
}

// Codex OAuth token storage
export async function getCodexOAuthTokens(): Promise<EncryptedCodexOAuth | null> {
  const result = await chrome.storage.local.get('codexOAuthTokens') as { codexOAuthTokens?: EncryptedCodexOAuth };
  return result.codexOAuthTokens ?? null;
}

export async function setCodexOAuthTokens(tokens: EncryptedCodexOAuth | null): Promise<void> {
  if (tokens) {
    await chrome.storage.local.set({ codexOAuthTokens: tokens });
  } else {
    await chrome.storage.local.remove('codexOAuthTokens');
  }
}
