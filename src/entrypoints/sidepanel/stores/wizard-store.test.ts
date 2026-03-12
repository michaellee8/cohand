import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWizardStore } from './wizard-store';

/**
 * Minimal chrome mock for wizard-store tests.
 */
function installChromeMock(sendMessageImpl?: (...args: unknown[]) => unknown) {
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
    tabs: {
      query: async () => [{ id: 1, url: 'https://example.com', title: 'Example' }],
    },
    runtime: {
      sendMessage: sendMessageImpl ?? (async () => ({ ok: true })),
    },
  };
}

beforeEach(() => {
  useWizardStore.getState().reset();
});

describe('createTask', () => {
  it('returns true on success', async () => {
    installChromeMock(async () => ({ ok: true }));

    const store = useWizardStore.getState();
    const result = await store.createTask();

    expect(result).toBe(true);
    expect(useWizardStore.getState().error).toBeNull();
    expect(useWizardStore.getState().loading).toBe(false);
  });

  it('returns false and sets error on failure', async () => {
    installChromeMock(async () => {
      throw new Error('Network error');
    });

    const store = useWizardStore.getState();
    const result = await store.createTask();

    expect(result).toBe(false);
    expect(useWizardStore.getState().error).toBe('Network error');
    expect(useWizardStore.getState().loading).toBe(false);
  });

  it('should not call onComplete when createTask returns false', async () => {
    installChromeMock(async () => {
      throw new Error('Create failed');
    });

    const store = useWizardStore.getState();
    const onComplete = vi.fn();

    const success = await store.createTask();
    if (success) {
      onComplete();
    }

    expect(success).toBe(false);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('should call onComplete when createTask returns true', async () => {
    installChromeMock(async () => ({ ok: true }));

    const store = useWizardStore.getState();
    const onComplete = vi.fn();

    const success = await store.createTask();
    if (success) {
      onComplete();
    }

    expect(success).toBe(true);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});
