import { describe, it, expect, beforeEach } from 'vitest';
import { useSettingsStore } from './settings-store';

/**
 * Minimal chrome mock for settings-store tests.
 */
function installChromeMock() {
  const store: Record<string, unknown> = {};
  (globalThis as any).chrome = {
    storage: {
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
    },
    runtime: {
      sendMessage: async () => ({}),
    },
  };
}

beforeEach(() => {
  installChromeMock();
  // Reset store state
  useSettingsStore.setState({
    settings: null,
    domainPermissions: [],
    hasApiKey: false,
    codexConnected: false,
    codexAccountId: null,
    loading: false,
    saving: false,
    error: null,
  });
});

describe('importCodexAuth', () => {
  it('sets error for invalid JSON', async () => {
    const store = useSettingsStore.getState();
    await store.importCodexAuth('not valid json');

    const state = useSettingsStore.getState();
    expect(state.error).toBeTruthy();
    expect(state.saving).toBe(false);
    expect(state.codexConnected).toBe(false);
  });

  it('sets error when tokens.access_token is missing', async () => {
    const store = useSettingsStore.getState();
    await store.importCodexAuth(JSON.stringify({ tokens: {} }));

    const state = useSettingsStore.getState();
    expect(state.error).toContain('access_token');
    expect(state.saving).toBe(false);
  });

  it('sets error when tokens.refresh_token is missing', async () => {
    const store = useSettingsStore.getState();
    await store.importCodexAuth(JSON.stringify({
      tokens: { access_token: 'abc' },
    }));

    const state = useSettingsStore.getState();
    expect(state.error).toContain('refresh_token');
  });

  it('sets error when tokens.account_id is missing', async () => {
    const store = useSettingsStore.getState();
    await store.importCodexAuth(JSON.stringify({
      tokens: { access_token: 'abc', refresh_token: 'def' },
    }));

    const state = useSettingsStore.getState();
    expect(state.error).toContain('account_id');
  });

  it('succeeds with valid auth JSON', async () => {
    const store = useSettingsStore.getState();
    await store.importCodexAuth(JSON.stringify({
      tokens: {
        access_token: 'abc',
        refresh_token: 'def',
        account_id: 'user-123',
      },
    }));

    const state = useSettingsStore.getState();
    expect(state.error).toBeNull();
    expect(state.codexConnected).toBe(true);
    expect(state.codexAccountId).toBe('user-123');
    expect(state.hasApiKey).toBe(true);
    expect(state.saving).toBe(false);
  });
});
