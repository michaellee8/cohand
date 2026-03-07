import { create } from 'zustand';
import type { Settings, DomainPermission } from '../../../types';
import {
  getSettings, setSettings,
  getDomainPermissions, addDomainPermission, removeDomainPermission,
  getEncryptedTokens, setEncryptedTokens,
  getEncryptionKeyEncoded, setEncryptionKeyEncoded,
} from '../../../lib/storage';
import { generateEncryptionKey, exportKey, importKey, encrypt, decrypt } from '../../../lib/crypto';

interface SettingsState {
  settings: Settings | null;
  domainPermissions: DomainPermission[];
  hasApiKey: boolean;
  loading: boolean;
  saving: boolean;
  error: string | null;

  load: () => Promise<void>;
  updateSettings: (updates: Partial<Settings>) => Promise<void>;
  saveApiKey: (apiKey: string) => Promise<void>;
  clearApiKey: () => Promise<void>;
  addDomain: (domain: string) => Promise<void>;
  removeDomain: (domain: string) => Promise<void>;
}

export const useSettingsStore = create<SettingsState>((set, get) => ({
  settings: null,
  domainPermissions: [],
  hasApiKey: false,
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
      set({
        settings,
        domainPermissions: permissions,
        hasApiKey: !!(tokens.apiKey || tokens.oauthToken),
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
}));
