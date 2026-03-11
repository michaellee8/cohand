import { create } from 'zustand';
import type { Settings, DomainPermission } from '../../../types';
import {
  getSettings, setSettings,
  getDomainPermissions, addDomainPermission, removeDomainPermission,
  getEncryptedTokens, setEncryptedTokens,
  getEncryptionKeyEncoded, setEncryptionKeyEncoded,
  getCodexOAuthTokens, setCodexOAuthTokens,
} from '../../../lib/storage';
import { generateEncryptionKey, exportKey, importKey, encrypt, decrypt } from '../../../lib/crypto';

interface SettingsState {
  settings: Settings | null;
  domainPermissions: DomainPermission[];
  hasApiKey: boolean;
  codexConnected: boolean;
  codexAccountId: string | null;
  loading: boolean;
  saving: boolean;
  error: string | null;

  load: () => Promise<void>;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  saveApiKey: (apiKey: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  addDomain: (domain: string) => Promise<void>;
  removeDomain: (domain: string) => Promise<void>;
  startCodexLogin: () => Promise<void>;
  logoutCodex: () => Promise<void>;
  importCodexAuth: (json: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  domainPermissions: [],
  hasApiKey: false,
  codexConnected: false,
  codexAccountId: null,
  loading: false,
  saving: false,
  error: null,

  load: async () => {
    set({ loading: true });
    try {
      const [settings, permissions, tokens] = await Promise.all([
        getSettings(),
        getDomainPermissions(),
        getEncryptedTokens(),
      ]);
      const codexOAuth = await getCodexOAuthTokens();
      set({
        settings,
        domainPermissions: permissions,
        hasApiKey: !!(tokens.apiKey || tokens.oauthToken || codexOAuth?.access),
        codexConnected: !!codexOAuth?.access,
        codexAccountId: codexOAuth?.accountId ?? null,
        loading: false,
      });
    } catch (err: any) {
      set({ loading: false, error: err.message });
    }
  },

  updateSettings: async (updates) => {
    const current = get().settings;
    if (!current) return;
    const newSettings = { ...current, ...updates };
    set({ saving: true });
    try {
      await setSettings(newSettings);
      set({ settings: newSettings, saving: false });
    } catch (err: any) {
      set({ saving: false, error: err.message });
    }
  },

  saveApiKey: async (apiKey: string) => {
    set({ saving: true });
    try {
      // Ensure encryption key exists
      let keyEncoded = await getEncryptionKeyEncoded();
      if (!keyEncoded) {
        const key = await generateEncryptionKey();
        keyEncoded = await exportKey(key);
        await setEncryptionKeyEncoded(keyEncoded);
      }

      const key = await importKey(keyEncoded);
      const encrypted = await encrypt(key, apiKey);
      await setEncryptedTokens({ apiKey: encrypted });
      set({ hasApiKey: true, saving: false });
    } catch (err: any) {
      set({ saving: false, error: err.message });
    }
  },

  clearApiKey: async () => {
    try {
      await setEncryptedTokens({});
      set({ hasApiKey: false });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  addDomain: async (domain: string) => {
    try {
      const permission: DomainPermission = {
        domain,
        grantedAt: new Date().toISOString(),
        grantedBy: 'user',
      };
      await addDomainPermission(permission);
      set(state => ({
        domainPermissions: [...state.domainPermissions, permission],
      }));
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  removeDomain: async (domain: string) => {
    try {
      await removeDomainPermission(domain);
      set(state => ({
        domainPermissions: state.domainPermissions.filter(p => p.domain !== domain),
      }));
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  startCodexLogin: async () => {
    await chrome.runtime.sendMessage({ type: 'START_CODEX_OAUTH' });
  },

  logoutCodex: async () => {
    await chrome.runtime.sendMessage({ type: 'LOGOUT_CODEX' });
    set({ codexConnected: false, codexAccountId: null, hasApiKey: false });
  },

  importCodexAuth: async (json: string) => {
    set({ saving: true, error: null });
    try {
      const parsed = JSON.parse(json);
      const tokens = parsed?.tokens;
      if (!tokens?.access_token || typeof tokens.access_token !== 'string') {
        throw new Error('Invalid auth.json: missing tokens.access_token');
      }
      if (!tokens?.refresh_token || typeof tokens.refresh_token !== 'string') {
        throw new Error('Invalid auth.json: missing tokens.refresh_token');
      }
      if (!tokens?.account_id || typeof tokens.account_id !== 'string') {
        throw new Error('Invalid auth.json: missing tokens.account_id');
      }

      // Ensure encryption key exists
      let keyEncoded = await getEncryptionKeyEncoded();
      if (!keyEncoded) {
        const cryptoKey = await generateEncryptionKey();
        keyEncoded = await exportKey(cryptoKey);
        await setEncryptionKeyEncoded(keyEncoded);
      }

      const key = await importKey(keyEncoded);
      await setCodexOAuthTokens({
        access: await encrypt(key, tokens.access_token),
        refresh: await encrypt(key, tokens.refresh_token),
        expires: 0, // Force refresh on first use
        accountId: tokens.account_id,
      });

      set({ codexConnected: true, codexAccountId: tokens.account_id, hasApiKey: true, saving: false });
    } catch (err: any) {
      set({ saving: false, error: err.message });
    }
  },
}));
