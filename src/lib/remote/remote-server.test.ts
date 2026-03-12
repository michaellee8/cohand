import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getOrCreateToken, validateToken, regenerateToken } from './remote-auth';
import {
  claimTab,
  releaseTab,
  getTabOwner,
  resetTabOwnership,
  releaseTabsForSession,
  executeRemoteCommand,
  isSensitiveScheme,
  type RemoteCommand,
} from './remote-relay';
import { createRemoteHandler, clearActiveSessions, getActiveSessionCount, resetAuthRateLimits } from './remote-server';
import { CDPManager } from '../cdp';

// --- Mock chrome.storage.local ---

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
    _store: store,
  };
}

// --- Mock chrome.debugger ---

function createMockDebugger() {
  return {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    onDetach: { addListener: vi.fn() },
    onEvent: { addListener: vi.fn() },
  };
}

let mockStorage: ReturnType<typeof createMockChromeStorage>;
let mockDebugger: ReturnType<typeof createMockDebugger>;

beforeEach(() => {
  mockStorage = createMockChromeStorage();
  mockDebugger = createMockDebugger();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    storage: mockStorage,
    debugger: mockDebugger,
  };
  resetTabOwnership();
  clearActiveSessions();
  resetAuthRateLimits();
});

// ========================
// remote-auth tests
// ========================

describe('remote-auth', () => {
  it('generates and stores a token', async () => {
    const token = await getOrCreateToken();
    expect(typeof token).toBe('string');
    expect(token.length).toBe(64); // 32 bytes => 64 hex chars
    // Verify it was stored
    const stored = await mockStorage.local.get('remote_auth_token');
    expect(stored['remote_auth_token']).toBe(token);
  });

  it('validates correct token', async () => {
    const token = await getOrCreateToken();
    const valid = await validateToken(token);
    expect(valid).toBe(true);
  });

  it('rejects incorrect token', async () => {
    await getOrCreateToken();
    const valid = await validateToken('wrong-token');
    expect(valid).toBe(false);
  });

  it('regenerates token', async () => {
    const original = await getOrCreateToken();
    const regenerated = await regenerateToken();
    expect(regenerated).not.toBe(original);
    expect(regenerated.length).toBe(64);
    // Old token should no longer be valid
    const oldValid = await validateToken(original);
    expect(oldValid).toBe(false);
    // New token should be valid
    const newValid = await validateToken(regenerated);
    expect(newValid).toBe(true);
  });

  it('getOrCreateToken returns existing token', async () => {
    const first = await getOrCreateToken();
    const second = await getOrCreateToken();
    expect(second).toBe(first);
  });
});

// ========================
// remote-relay tests
// ========================

describe('remote-relay', () => {
  describe('tab ownership', () => {
    it('claims tab for remote', () => {
      const claimed = claimTab(1, 'remote');
      expect(claimed).toBe(true);
      expect(getTabOwner(1)).toEqual({ owner: 'remote', sessionId: undefined });
    });

    it('claims tab for remote with sessionId', () => {
      const claimed = claimTab(1, 'remote', 'session-abc');
      expect(claimed).toBe(true);
      expect(getTabOwner(1)).toEqual({ owner: 'remote', sessionId: 'session-abc' });
    });

    it('claims tab for local', () => {
      const claimed = claimTab(1, 'local');
      expect(claimed).toBe(true);
      expect(getTabOwner(1)).toEqual({ owner: 'local', sessionId: undefined });
    });

    it('allows re-claiming tab with same mode', () => {
      claimTab(1, 'remote');
      const again = claimTab(1, 'remote');
      expect(again).toBe(true);
    });

    it('allows re-claiming tab with same mode and same sessionId', () => {
      claimTab(1, 'remote', 'session-1');
      const again = claimTab(1, 'remote', 'session-1');
      expect(again).toBe(true);
    });

    it('rejects remote claim from different session', () => {
      claimTab(1, 'remote', 'session-1');
      const claim2 = claimTab(1, 'remote', 'session-2');
      expect(claim2).toBe(false);
      expect(getTabOwner(1)).toEqual({ owner: 'remote', sessionId: 'session-1' });
    });

    it('rejects claim when tab under local control', () => {
      claimTab(1, 'local');
      const remoteClaim = claimTab(1, 'remote');
      expect(remoteClaim).toBe(false);
      expect(getTabOwner(1)?.owner).toBe('local');
    });

    it('rejects claim when tab under remote control for local mode', () => {
      claimTab(1, 'remote');
      const localClaim = claimTab(1, 'local');
      expect(localClaim).toBe(false);
      expect(getTabOwner(1)?.owner).toBe('remote');
    });

    it('releases tab', () => {
      claimTab(1, 'remote');
      releaseTab(1);
      expect(getTabOwner(1)).toBeNull();
    });

    it('releases tab with matching sessionId', () => {
      claimTab(1, 'remote', 'session-1');
      releaseTab(1, 'session-1');
      expect(getTabOwner(1)).toBeNull();
    });

    it('rejects release with mismatched sessionId', () => {
      claimTab(1, 'remote', 'session-1');
      releaseTab(1, 'session-2');
      // Tab should still be owned by session-1
      expect(getTabOwner(1)).toEqual({ owner: 'remote', sessionId: 'session-1' });
    });

    it('release without sessionId releases any tab', () => {
      claimTab(1, 'remote', 'session-1');
      releaseTab(1); // No sessionId — acts as unconditional release (for local callers)
      expect(getTabOwner(1)).toBeNull();
    });

    it('release is no-op for unknown tab', () => {
      releaseTab(999); // should not throw
      expect(getTabOwner(999)).toBeNull();
    });

    it('returns null for unclaimed tab', () => {
      expect(getTabOwner(42)).toBeNull();
    });
  });

  describe('executeRemoteCommand', () => {
    let cdp: CDPManager;
    const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

    beforeEach(() => {
      cdp = new CDPManager();
      getTabUrl.mockReset();
    });

    it('executes CDP command with domain check', async () => {
      getTabUrl.mockResolvedValue('https://www.example.com/page');
      mockDebugger.sendCommand.mockResolvedValue({ nodeId: 42 });

      const command: RemoteCommand = {
        id: 1,
        method: 'DOM.getDocument',
        params: { depth: 1 },
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(true);
      expect(result.id).toBe(1);
      expect(result.result).toEqual({ nodeId: 42 });
    });

    it('blocks text input methods via CDP whitelist', async () => {
      getTabUrl.mockResolvedValue('https://www.example.com');

      for (const method of ['Input.dispatchKeyEvent', 'Input.insertText', 'Input.imeSetComposition']) {
        const command: RemoteCommand = {
          id: 2,
          method,
          params: { type: 'keyDown', key: 'a' },
          tabId: 10,
        };

        const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
        expect(result.ok).toBe(false);
        expect(result.error).toContain('not allowed');
      }
    });

    it('rejects commands for disallowed domains', async () => {
      getTabUrl.mockResolvedValue('https://evil.com/hack');

      const command: RemoteCommand = {
        id: 5,
        method: 'DOM.getDocument',
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('Domain not allowed');
    });

    it('rejects when tab is under local control', async () => {
      claimTab(10, 'local');

      const command: RemoteCommand = {
        id: 6,
        method: 'DOM.getDocument',
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('Tab is under local script control');
    });

    it('auto-attaches debugger if not attached', async () => {
      getTabUrl.mockResolvedValue('https://example.com');

      const command: RemoteCommand = {
        id: 7,
        method: 'DOM.getDocument',
        tabId: 10,
      };

      await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      // The CDPManager should have called chrome.debugger.attach
      expect(mockDebugger.attach).toHaveBeenCalledWith({ tabId: 10 }, '1.3');
    });

    it('returns error when CDP command throws', async () => {
      getTabUrl.mockResolvedValue('https://example.com');
      // First attach the tab so isAttached returns true, then make the command fail
      await cdp.attach(10);
      mockDebugger.sendCommand.mockClear();
      mockDebugger.sendCommand.mockRejectedValueOnce(new Error('CDP error'));

      const command: RemoteCommand = {
        id: 8,
        method: 'DOM.getDocument',
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(false);
      expect(result.error).toBe('CDP error');
      expect(result.id).toBe(8);
    });

    it('blocks Runtime.evaluate via CDP whitelist', async () => {
      getTabUrl.mockResolvedValue('https://example.com');

      const command: RemoteCommand = {
        id: 10,
        method: 'Runtime.evaluate',
        params: { expression: 'document.cookie' },
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('CDP method not allowed');
    });

    it('blocks Network.enable via CDP whitelist', async () => {
      getTabUrl.mockResolvedValue('https://example.com');

      const command: RemoteCommand = {
        id: 11,
        method: 'Network.enable',
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(false);
      expect(result.error).toContain('CDP method not allowed');
    });

    it('allows whitelisted DOM.getDocument', async () => {
      getTabUrl.mockResolvedValue('https://example.com');
      mockDebugger.sendCommand.mockResolvedValue({ root: { nodeId: 1 } });

      const command: RemoteCommand = {
        id: 12,
        method: 'DOM.getDocument',
        params: { depth: 1 },
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(true);
    });

    it('allows whitelisted Accessibility.queryAXTree', async () => {
      getTabUrl.mockResolvedValue('https://example.com');
      mockDebugger.sendCommand.mockResolvedValue({ nodes: [] });

      const command: RemoteCommand = {
        id: 13,
        method: 'Accessibility.queryAXTree',
        tabId: 10,
      };

      const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
      expect(result.ok).toBe(true);
    });

    it('claims tab for remote and subsequent commands succeed', async () => {
      getTabUrl.mockResolvedValue('https://example.com');
      mockDebugger.sendCommand.mockResolvedValue({ ok: true });

      const cmd1: RemoteCommand = { id: 1, method: 'DOM.getDocument', tabId: 20 };
      const cmd2: RemoteCommand = { id: 2, method: 'Page.navigate', tabId: 20, params: { url: 'https://example.com' } };

      await executeRemoteCommand(cdp, cmd1, ['example.com'], getTabUrl);
      expect(getTabOwner(20)?.owner).toBe('remote');

      const result2 = await executeRemoteCommand(cdp, cmd2, ['example.com'], getTabUrl);
      expect(result2.ok).toBe(true);
    });
  });
});

// ========================
// remote-server tests
// ========================

describe('remote-server', () => {
  let cdp: CDPManager;
  let handler: ReturnType<typeof createRemoteHandler>;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(async () => {
    cdp = new CDPManager();
    getTabUrl.mockResolvedValue('https://example.com');
    handler = createRemoteHandler(cdp, getTabUrl);
    // Create a token in storage for auth tests
    await getOrCreateToken();
  });

  function callHandler(message: any, senderId?: string): Promise<any> {
    return new Promise((resolve) => {
      const sender: chrome.runtime.MessageSender = {
        id: senderId ?? 'test-extension-id',
      } as chrome.runtime.MessageSender;
      handler(message, sender, resolve);
    });
  }

  it('authenticates with valid token', async () => {
    const token = await getOrCreateToken();
    const response = await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });
    expect(response).toEqual({ ok: true });
    expect(getActiveSessionCount()).toBe(1);
  });

  it('rejects invalid token', async () => {
    const response = await callHandler({
      type: 'remote:auth',
      token: 'invalid-token',
    });
    expect(response).toEqual({ ok: false, error: 'Invalid token' });
    expect(getActiveSessionCount()).toBe(0);
  });

  it('executes commands after auth', async () => {
    const token = await getOrCreateToken();
    mockDebugger.sendCommand.mockResolvedValue({ root: { nodeId: 1 } });

    // Configure domain permission so intersection allows example.com
    await mockStorage.local.set({
      domainPermissions: [{ domain: 'example.com', addedAt: new Date().toISOString() }],
    });

    // Authenticate first
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });

    // Execute command
    const response = await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      params: { depth: 1 },
      tabId: 10,
    });

    expect(response.ok).toBe(true);
    expect(response.id).toBe(1);
  });

  it('rejects commands without auth', async () => {
    const response = await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    });
    expect(response).toEqual({ ok: false, error: 'Not authenticated' });
  });

  it('handles disconnect', async () => {
    const token = await getOrCreateToken();
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });
    expect(getActiveSessionCount()).toBe(1);

    const response = await callHandler({ type: 'remote:disconnect' });
    expect(response).toEqual({ ok: true });
    expect(getActiveSessionCount()).toBe(0);
  });

  it('handles release', async () => {
    const token = await getOrCreateToken();
    mockDebugger.sendCommand.mockResolvedValue({});

    // Configure domain permissions
    await mockStorage.local.set({
      domainPermissions: [{ domain: 'example.com', addedAt: new Date().toISOString() }],
    });

    // Auth and execute a command to claim the tab
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });
    await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    });
    expect(getTabOwner(10)?.owner).toBe('remote');

    // Release the tab
    const response = await callHandler({
      type: 'remote:release',
      tabId: 10,
    });
    expect(response).toEqual({ ok: true });
    expect(getTabOwner(10)).toBeNull();
  });

  it('rejects messages without extension ID', async () => {
    const response = await new Promise((resolve) => {
      const sender = {} as chrome.runtime.MessageSender;
      handler({ type: 'remote:auth', token: 'x' }, sender, resolve);
    });
    expect(response).toEqual({ error: 'No extension ID' });
  });

  it('returns error for unknown message type', async () => {
    const token = await getOrCreateToken();
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });

    const response = await callHandler({ type: 'remote:unknown' });
    expect(response).toEqual({ error: 'Unknown remote message type' });
  });

  it('rejects release without auth', async () => {
    const response = await callHandler({
      type: 'remote:release',
      tabId: 10,
    });
    expect(response).toEqual({ ok: false, error: 'Not authenticated' });
  });

  it('auth defaults allowedDomains to empty array', async () => {
    const token = await getOrCreateToken();
    // Auth without specifying allowedDomains
    await callHandler({
      type: 'remote:auth',
      token,
    });

    // Command should fail due to domain not being allowed
    const response = await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Domain not allowed');
  });

  it('intersects client domains with configured permissions', async () => {
    // Set up configured domain permissions
    await mockStorage.local.set({
      domainPermissions: [
        { domain: 'example.com', addedAt: new Date().toISOString() },
        { domain: 'trusted.com', addedAt: new Date().toISOString() },
      ],
    });

    const token = await getOrCreateToken();

    // Client requests example.com and evil.com, but only example.com is configured
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com', 'evil.com'],
    });

    // Commands to example.com should work
    mockDebugger.sendCommand.mockResolvedValue({ nodeId: 1 });
    const okResponse = await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    });
    expect(okResponse.ok).toBe(true);

    // Commands to evil.com should be blocked
    getTabUrl.mockResolvedValue('https://evil.com');
    const blockedResponse = await callHandler({
      type: 'remote:command',
      id: 2,
      method: 'DOM.getDocument',
      tabId: 11,
    });
    expect(blockedResponse.ok).toBe(false);
    expect(blockedResponse.error).toContain('Domain not allowed');
  });

  it('allows no domains when no permissions configured', async () => {
    const token = await getOrCreateToken();

    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });

    // Even though client requested example.com, no permissions configured = no domains
    const response = await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    });
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Domain not allowed');
  });

  it('supports multiple sessions from different extensions', async () => {
    const token = await getOrCreateToken();

    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    }, 'ext-1');

    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['other.com'],
    }, 'ext-2');

    expect(getActiveSessionCount()).toBe(2);

    // Disconnect ext-1 only
    await callHandler({ type: 'remote:disconnect' }, 'ext-1');
    expect(getActiveSessionCount()).toBe(1);
  });

  it('returns true synchronously to keep message channel open', () => {
    const sender: chrome.runtime.MessageSender = {
      id: 'test-extension-id',
    } as chrome.runtime.MessageSender;
    const sendResponse = vi.fn();

    const result = handler({ type: 'remote:auth', token: 'any' }, sender, sendResponse);

    // Must return exactly `true` (not a Promise) synchronously
    expect(result).toBe(true);
  });

  it('calls sendResponse after async work completes', async () => {
    const token = await getOrCreateToken();
    const sendResponse = vi.fn();
    const sender: chrome.runtime.MessageSender = {
      id: 'test-extension-id',
    } as chrome.runtime.MessageSender;

    handler({ type: 'remote:auth', token, allowedDomains: ['example.com'] }, sender, sendResponse);

    // sendResponse should not have been called synchronously (async path)
    // Wait for the microtask to resolve
    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith({ ok: true });
    });
  });

  it('calls sendResponse with error when async work throws', async () => {
    const token = await getOrCreateToken();
    const sendResponse = vi.fn();
    const sender: chrome.runtime.MessageSender = {
      id: 'test-extension-id',
    } as chrome.runtime.MessageSender;

    // Auth first so we have a session
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    });

    // Make executeRemoteCommand throw
    getTabUrl.mockRejectedValueOnce(new Error('Tab URL lookup failed'));

    handler(
      { type: 'remote:command', id: 99, method: 'DOM.getDocument', tabId: 10 },
      sender,
      sendResponse,
    );

    await vi.waitFor(() => {
      expect(sendResponse).toHaveBeenCalledWith(
        expect.objectContaining({ error: expect.stringContaining('Tab URL lookup failed') }),
      );
    });
  });

  it('release from different extension does not release tab (session-aware ownership)', async () => {
    const token = await getOrCreateToken();
    mockDebugger.sendCommand.mockResolvedValue({});

    // Configure domain permissions
    await mockStorage.local.set({
      domainPermissions: [{ domain: 'example.com', addedAt: new Date().toISOString() }],
    });

    // Auth ext-A and claim a tab
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    }, 'ext-A');

    await callHandler({
      type: 'remote:command',
      id: 1,
      method: 'DOM.getDocument',
      tabId: 30,
    }, 'ext-A');

    expect(getTabOwner(30)?.owner).toBe('remote');
    expect(getTabOwner(30)?.sessionId).toBe('ext-A');

    // Auth ext-B
    await callHandler({
      type: 'remote:auth',
      token,
      allowedDomains: ['example.com'],
    }, 'ext-B');

    // ext-B tries to release ext-A's tab — should NOT release
    await callHandler({
      type: 'remote:release',
      tabId: 30,
    }, 'ext-B');

    // Tab should still be owned by ext-A
    expect(getTabOwner(30)?.owner).toBe('remote');
    expect(getTabOwner(30)?.sessionId).toBe('ext-A');
  });
});

// ========================
// isSensitiveScheme tests (H11)
// ========================

describe('isSensitiveScheme', () => {
  it('identifies chrome:// URLs as sensitive', () => {
    expect(isSensitiveScheme('chrome://settings')).toBe(true);
    expect(isSensitiveScheme('chrome://extensions')).toBe(true);
  });

  it('identifies chrome-extension:// URLs as sensitive', () => {
    expect(isSensitiveScheme('chrome-extension://abcdef123/popup.html')).toBe(true);
  });

  it('identifies about: URLs as sensitive', () => {
    expect(isSensitiveScheme('about:blank')).toBe(true);
    expect(isSensitiveScheme('about:srcdoc')).toBe(true);
  });

  it('identifies file:// URLs as sensitive', () => {
    expect(isSensitiveScheme('file:///etc/passwd')).toBe(true);
    expect(isSensitiveScheme('file:///home/user/document.html')).toBe(true);
  });

  it('identifies devtools:// URLs as sensitive', () => {
    expect(isSensitiveScheme('devtools://devtools/bundled/inspector.html')).toBe(true);
  });

  it('returns false for https:// URLs', () => {
    expect(isSensitiveScheme('https://example.com')).toBe(false);
  });

  it('returns false for http:// URLs', () => {
    expect(isSensitiveScheme('http://example.com')).toBe(false);
  });

  it('identifies javascript: URLs as sensitive (C2)', () => {
    expect(isSensitiveScheme('javascript:alert(1)')).toBe(true);
  });

  it('identifies data: URLs as sensitive (C2)', () => {
    expect(isSensitiveScheme('data:text/html,<script>alert(1)</script>')).toBe(true);
  });
});

// ========================
// Sensitive page blocking in executeRemoteCommand (H11)
// ========================

describe('executeRemoteCommand sensitive page blocking', () => {
  let cdp: CDPManager;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(() => {
    cdp = new CDPManager();
    getTabUrl.mockReset();
  });

  it('blocks CDP command on chrome:// page', async () => {
    getTabUrl.mockResolvedValue('chrome://settings');

    const command: RemoteCommand = {
      id: 1,
      method: 'DOM.getDocument',
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['*'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive page');
  });

  it('blocks CDP command on file:// page', async () => {
    getTabUrl.mockResolvedValue('file:///etc/passwd');

    const command: RemoteCommand = {
      id: 2,
      method: 'DOM.getDocument',
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['*'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive page');
  });

  it('blocks Page.navigate to chrome:// URL', async () => {
    getTabUrl.mockResolvedValue('https://example.com');
    mockDebugger.sendCommand.mockResolvedValue({});

    const command: RemoteCommand = {
      id: 3,
      method: 'Page.navigate',
      params: { url: 'chrome://settings' },
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Navigation to sensitive URL blocked');
  });

  it('blocks Page.navigate to file:// URL', async () => {
    getTabUrl.mockResolvedValue('https://example.com');
    mockDebugger.sendCommand.mockResolvedValue({});

    const command: RemoteCommand = {
      id: 4,
      method: 'Page.navigate',
      params: { url: 'file:///etc/passwd' },
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Navigation to sensitive URL blocked');
  });

  it('allows Page.navigate to normal https:// URL', async () => {
    getTabUrl.mockResolvedValue('https://example.com');
    mockDebugger.sendCommand.mockResolvedValue({ frameId: '123' });

    const command: RemoteCommand = {
      id: 5,
      method: 'Page.navigate',
      params: { url: 'https://example.com/page2' },
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(true);
  });

  it('blocks CDP command on about:blank page', async () => {
    getTabUrl.mockResolvedValue('about:blank');

    const command: RemoteCommand = {
      id: 6,
      method: 'DOM.getDocument',
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['*'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('sensitive page');
  });

  it('blocks Page.navigate to javascript: URL (C2)', async () => {
    getTabUrl.mockResolvedValue('https://example.com');

    const command: RemoteCommand = {
      id: 7,
      method: 'Page.navigate',
      params: { url: 'javascript:alert(1)' },
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Navigation to sensitive URL blocked');
  });

  it('blocks Page.navigate to data: URL (C2)', async () => {
    getTabUrl.mockResolvedValue('https://example.com');

    const command: RemoteCommand = {
      id: 8,
      method: 'Page.navigate',
      params: { url: 'data:text/html,<script>alert(1)</script>' },
      tabId: 10,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('Navigation to sensitive URL blocked');
  });
});

// ========================
// C1: validateToken rejects undefined stored token
// ========================

describe('validateToken undefined guard (C1)', () => {
  it('rejects when no token is stored (prevents undefined===undefined)', async () => {
    // Do NOT create a token — storage is empty
    const valid = await validateToken(undefined as unknown as string);
    expect(valid).toBe(false);
  });

  it('rejects empty string token when no token stored', async () => {
    const valid = await validateToken('');
    expect(valid).toBe(false);
  });
});

// ========================
// H6: releaseTabsForSession
// ========================

describe('releaseTabsForSession (H6)', () => {
  it('releases all tabs for a session', () => {
    claimTab(1, 'remote', 'session-A');
    claimTab(2, 'remote', 'session-A');
    claimTab(3, 'remote', 'session-B');

    releaseTabsForSession('session-A');

    expect(getTabOwner(1)).toBeNull();
    expect(getTabOwner(2)).toBeNull();
    expect(getTabOwner(3)).not.toBeNull();
    expect(getTabOwner(3)?.sessionId).toBe('session-B');
  });

  it('does nothing if session has no tabs', () => {
    claimTab(1, 'remote', 'session-X');
    releaseTabsForSession('session-Y');
    expect(getTabOwner(1)).not.toBeNull();
  });
});

// ========================
// H7: claimTab after validation
// ========================

describe('claimTab after validation (H7)', () => {
  let cdp: CDPManager;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(() => {
    cdp = new CDPManager();
    getTabUrl.mockReset();
  });

  it('does not claim tab when domain validation fails', async () => {
    getTabUrl.mockResolvedValue('https://evil.com');

    const command: RemoteCommand = {
      id: 1,
      method: 'DOM.getDocument',
      tabId: 50,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl);
    expect(result.ok).toBe(false);
    // Tab should NOT be claimed since validation failed before claimTab
    expect(getTabOwner(50)).toBeNull();
  });

  it('does not claim tab when sensitive scheme check fails', async () => {
    getTabUrl.mockResolvedValue('chrome://settings');

    const command: RemoteCommand = {
      id: 2,
      method: 'DOM.getDocument',
      tabId: 51,
    };

    const result = await executeRemoteCommand(cdp, command, ['*'], getTabUrl);
    expect(result.ok).toBe(false);
    expect(getTabOwner(51)).toBeNull();
  });

  it('releases tab when CDP execution throws after claim', async () => {
    getTabUrl.mockResolvedValue('https://example.com');
    await cdp.attach(60);
    mockDebugger.sendCommand.mockClear();
    mockDebugger.sendCommand.mockRejectedValueOnce(new Error('CDP crashed'));

    const command: RemoteCommand = {
      id: 3,
      method: 'DOM.getDocument',
      tabId: 60,
    };

    const result = await executeRemoteCommand(cdp, command, ['example.com'], getTabUrl, 'sess-1');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('CDP crashed');
    // Tab should be released after the error
    expect(getTabOwner(60)).toBeNull();
  });
});

// ========================
// H8: regenerateToken clears active sessions
// ========================

describe('regenerateToken clears sessions (H8)', () => {
  it('clears active sessions when token is regenerated', async () => {
    const token = await getOrCreateToken();
    // Simulate an active session by directly adding (or going through handler)
    const cdp = new CDPManager();
    const getTabUrl = vi.fn<(tabId: number) => Promise<string>>().mockResolvedValue('https://example.com');
    const handler = createRemoteHandler(cdp, getTabUrl);

    // Authenticate
    await new Promise<void>((resolve) => {
      const sender = { id: 'ext-test' } as chrome.runtime.MessageSender;
      handler({ type: 'remote:auth', token, allowedDomains: ['example.com'] }, sender, () => resolve());
    });
    expect(getActiveSessionCount()).toBe(1);

    // Regenerate token — should clear sessions
    await regenerateToken();
    expect(getActiveSessionCount()).toBe(0);
  });
});

// ========================
// H10: taskId in local tab claims
// ========================

describe('taskId in local tab claims (H10)', () => {
  it('stores taskId for local claims', () => {
    const claimed = claimTab(100, 'local', undefined, 'task-abc');
    expect(claimed).toBe(true);
    const owner = getTabOwner(100);
    expect(owner?.owner).toBe('local');
    expect(owner?.taskId).toBe('task-abc');
  });

  it('does not store taskId for remote claims', () => {
    const claimed = claimTab(101, 'remote', 'session-1', 'task-xyz');
    expect(claimed).toBe(true);
    const owner = getTabOwner(101);
    expect(owner?.owner).toBe('remote');
    expect(owner?.taskId).toBeUndefined();
  });

  it('local claim without taskId has no taskId', () => {
    const claimed = claimTab(102, 'local');
    expect(claimed).toBe(true);
    const owner = getTabOwner(102);
    expect(owner?.taskId).toBeUndefined();
  });
});

// ========================
// M2: Session expiry with idle timeout
// ========================

describe('session idle timeout (M2)', () => {
  let cdp: CDPManager;
  let handler: ReturnType<typeof createRemoteHandler>;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(async () => {
    cdp = new CDPManager();
    getTabUrl.mockResolvedValue('https://example.com');
    handler = createRemoteHandler(cdp, getTabUrl);
    await getOrCreateToken();
  });

  function callHandler(message: any, senderId?: string): Promise<any> {
    return new Promise((resolve) => {
      const sender = { id: senderId ?? 'test-ext' } as chrome.runtime.MessageSender;
      handler(message, sender, resolve);
    });
  }

  it('expires session after idle timeout', async () => {
    const token = await getOrCreateToken();
    await callHandler({ type: 'remote:auth', token, allowedDomains: ['example.com'] });
    expect(getActiveSessionCount()).toBe(1);

    // Fast-forward time past the 30-minute timeout
    const originalNow = Date.now;
    Date.now = () => originalNow() + 31 * 60 * 1000;

    try {
      const response = await callHandler({
        type: 'remote:command',
        id: 1,
        method: 'DOM.getDocument',
        tabId: 10,
      });
      expect(response).toEqual({ ok: false, error: 'Session expired' });
      expect(getActiveSessionCount()).toBe(0);
    } finally {
      Date.now = originalNow;
    }
  });
});

// ========================
// M3: Rate limiting on auth attempts
// ========================

describe('auth rate limiting (M3)', () => {
  let cdp: CDPManager;
  let handler: ReturnType<typeof createRemoteHandler>;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(async () => {
    cdp = new CDPManager();
    getTabUrl.mockResolvedValue('https://example.com');
    handler = createRemoteHandler(cdp, getTabUrl);
    await getOrCreateToken();
  });

  function callHandler(message: any, senderId?: string): Promise<any> {
    return new Promise((resolve) => {
      const sender = { id: senderId ?? 'rate-test-ext' } as chrome.runtime.MessageSender;
      handler(message, sender, resolve);
    });
  }

  it('rate limits after 5 failed auth attempts', async () => {
    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      const response = await callHandler({ type: 'remote:auth', token: 'wrong-token' });
      expect(response).toEqual({ ok: false, error: 'Invalid token' });
    }

    // 6th attempt should be rate limited
    const response = await callHandler({ type: 'remote:auth', token: 'wrong-token' });
    expect(response).toEqual({ ok: false, error: 'Rate limited' });
  });

  it('does not rate limit valid auth attempts', async () => {
    const token = await getOrCreateToken();

    // Make a few failed attempts (fewer than limit)
    for (let i = 0; i < 3; i++) {
      await callHandler({ type: 'remote:auth', token: 'wrong-token' });
    }

    // Valid auth should still work
    const response = await callHandler({ type: 'remote:auth', token, allowedDomains: ['example.com'] });
    expect(response).toEqual({ ok: true });
  });

  it('rate limit resets after window expires', async () => {
    // Make 5 failed attempts
    for (let i = 0; i < 5; i++) {
      await callHandler({ type: 'remote:auth', token: 'wrong-token' });
    }

    // Should be rate limited
    let response = await callHandler({ type: 'remote:auth', token: 'wrong-token' });
    expect(response).toEqual({ ok: false, error: 'Rate limited' });

    // Fast-forward time past the 1-minute window
    const originalNow = Date.now;
    Date.now = () => originalNow() + 61 * 1000;

    try {
      // Should no longer be rate limited
      response = await callHandler({ type: 'remote:auth', token: 'wrong-token' });
      expect(response).toEqual({ ok: false, error: 'Invalid token' });
    } finally {
      Date.now = originalNow;
    }
  });
});

// ========================
// H6: disconnect releases tabs for session (integration)
// ========================

describe('disconnect releases tabs (H6 integration)', () => {
  let cdp: CDPManager;
  let handler: ReturnType<typeof createRemoteHandler>;
  const getTabUrl = vi.fn<(tabId: number) => Promise<string>>();

  beforeEach(async () => {
    cdp = new CDPManager();
    getTabUrl.mockResolvedValue('https://example.com');
    handler = createRemoteHandler(cdp, getTabUrl);
    await getOrCreateToken();

    // Configure domain permissions
    await mockStorage.local.set({
      domainPermissions: [{ domain: 'example.com', addedAt: new Date().toISOString() }],
    });
  });

  function callHandler(message: any, senderId?: string): Promise<any> {
    return new Promise((resolve) => {
      const sender = { id: senderId ?? 'ext-disconnect' } as chrome.runtime.MessageSender;
      handler(message, sender, resolve);
    });
  }

  it('releases all tabs when session disconnects', async () => {
    const token = await getOrCreateToken();
    mockDebugger.sendCommand.mockResolvedValue({});

    // Auth and claim tabs
    await callHandler({ type: 'remote:auth', token, allowedDomains: ['example.com'] });
    await callHandler({ type: 'remote:command', id: 1, method: 'DOM.getDocument', tabId: 40 });
    await callHandler({ type: 'remote:command', id: 2, method: 'DOM.getDocument', tabId: 41 });

    expect(getTabOwner(40)?.sessionId).toBe('ext-disconnect');
    expect(getTabOwner(41)?.sessionId).toBe('ext-disconnect');

    // Disconnect
    await callHandler({ type: 'remote:disconnect' });

    // Both tabs should be released
    expect(getTabOwner(40)).toBeNull();
    expect(getTabOwner(41)).toBeNull();
    expect(getActiveSessionCount()).toBe(0);
  });
});
