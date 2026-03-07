import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CDPManager, CDPNavigationError } from './cdp';

function createMockDebugger() {
  const listeners = {
    onDetach: [] as Function[],
    onEvent: [] as Function[],
  };

  return {
    attach: vi.fn().mockResolvedValue(undefined),
    detach: vi.fn().mockResolvedValue(undefined),
    sendCommand: vi.fn().mockResolvedValue({}),
    onDetach: {
      addListener: (fn: Function) => listeners.onDetach.push(fn),
    },
    onEvent: {
      addListener: (fn: Function) => listeners.onEvent.push(fn),
    },
    _listeners: listeners,
  };
}

let mockDebugger: ReturnType<typeof createMockDebugger>;
let cdp: CDPManager;

beforeEach(() => {
  mockDebugger = createMockDebugger();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    debugger: mockDebugger,
  };
  cdp = new CDPManager();
});

describe('attach', () => {
  it('calls chrome.debugger.attach with version 1.3', async () => {
    await cdp.attach(1);
    expect(mockDebugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
  });

  it('enables DOM, Page, and Input domains', async () => {
    await cdp.attach(1);
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'DOM.enable',
      undefined,
    );
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Page.enable',
      undefined,
    );
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'Input.enable',
      undefined,
    );
  });

  it('increments refCount on second call without re-attaching', async () => {
    await cdp.attach(1);
    expect(mockDebugger.attach).toHaveBeenCalledTimes(1);

    await cdp.attach(1);
    expect(mockDebugger.attach).toHaveBeenCalledTimes(1); // still 1
    expect(cdp.isAttached(1)).toBe(true);
  });
});

describe('detach', () => {
  it('decrements refCount but does not detach until 0', async () => {
    await cdp.attach(1);
    await cdp.attach(1); // refCount = 2

    await cdp.detach(1);
    expect(mockDebugger.detach).not.toHaveBeenCalled();
    expect(cdp.isAttached(1)).toBe(true);
  });

  it('actually detaches when refCount reaches 0', async () => {
    await cdp.attach(1);
    await cdp.detach(1);
    expect(mockDebugger.detach).toHaveBeenCalledWith({ tabId: 1 });
    expect(cdp.isAttached(1)).toBe(false);
  });

  it('is a no-op for unknown tabs', async () => {
    await cdp.detach(999);
    expect(mockDebugger.detach).not.toHaveBeenCalled();
  });

  it('handles chrome.debugger.detach throwing (tab already closed)', async () => {
    mockDebugger.detach.mockRejectedValueOnce(new Error('tab closed'));
    await cdp.attach(1);
    await cdp.detach(1); // should not throw
    expect(cdp.isAttached(1)).toBe(false);
  });
});

describe('send', () => {
  it('throws if tab not attached', async () => {
    await expect(cdp.send(1, 'DOM.getDocument')).rejects.toThrow(
      'Tab 1 not attached',
    );
  });

  it('forwards to chrome.debugger.sendCommand', async () => {
    const mockResult = { root: { nodeId: 1 } };
    mockDebugger.sendCommand.mockResolvedValueOnce(mockResult);

    await cdp.attach(1);
    // clear the calls from attach (DOM.enable, Page.enable, Input.enable)
    mockDebugger.sendCommand.mockClear();
    mockDebugger.sendCommand.mockResolvedValueOnce(mockResult);

    const result = await cdp.send(1, 'DOM.getDocument', { depth: 1 });
    expect(mockDebugger.sendCommand).toHaveBeenCalledWith(
      { tabId: 1 },
      'DOM.getDocument',
      { depth: 1 },
    );
    expect(result).toEqual(mockResult);
  });

  it('throws CDPNavigationError if epoch changes during command', async () => {
    await cdp.attach(1);
    mockDebugger.sendCommand.mockClear();

    // Simulate navigation happening during the sendCommand call
    mockDebugger.sendCommand.mockImplementationOnce(async () => {
      cdp.incrementEpoch(1);
      return {};
    });

    await expect(cdp.send(1, 'DOM.getDocument')).rejects.toThrow(
      CDPNavigationError,
    );
  });
});

describe('epoch tracking', () => {
  it('getEpoch returns -1 for unknown tabs', () => {
    expect(cdp.getEpoch(999)).toBe(-1);
  });

  it('getEpoch returns 0 for newly attached tabs', async () => {
    await cdp.attach(1);
    expect(cdp.getEpoch(1)).toBe(0);
  });

  it('incrementEpoch increments the epoch', async () => {
    await cdp.attach(1);
    cdp.incrementEpoch(1);
    expect(cdp.getEpoch(1)).toBe(1);
    cdp.incrementEpoch(1);
    expect(cdp.getEpoch(1)).toBe(2);
  });

  it('incrementEpoch is a no-op for unknown tabs', () => {
    cdp.incrementEpoch(999); // should not throw
  });
});

describe('isEpochValid', () => {
  it('returns true when epoch matches', async () => {
    await cdp.attach(1);
    expect(cdp.isEpochValid(1, 0)).toBe(true);
  });

  it('returns false when epoch does not match', async () => {
    await cdp.attach(1);
    cdp.incrementEpoch(1);
    expect(cdp.isEpochValid(1, 0)).toBe(false);
  });

  it('returns false for unknown tabs', () => {
    expect(cdp.isEpochValid(999, 0)).toBe(false);
  });
});

describe('mouse position', () => {
  it('defaults to (0, 0)', async () => {
    await cdp.attach(1);
    expect(cdp.getMousePosition(1)).toEqual({ x: 0, y: 0 });
  });

  it('getMousePosition returns (0, 0) for unknown tabs', () => {
    expect(cdp.getMousePosition(999)).toEqual({ x: 0, y: 0 });
  });

  it('setMousePosition updates the position', async () => {
    await cdp.attach(1);
    cdp.setMousePosition(1, 150, 300);
    expect(cdp.getMousePosition(1)).toEqual({ x: 150, y: 300 });
  });

  it('setMousePosition is a no-op for unknown tabs', () => {
    cdp.setMousePosition(999, 100, 200); // should not throw
    expect(cdp.getMousePosition(999)).toEqual({ x: 0, y: 0 });
  });
});

describe('isAttached', () => {
  it('returns false for unknown tabs', () => {
    expect(cdp.isAttached(42)).toBe(false);
  });

  it('returns true for attached tabs', async () => {
    await cdp.attach(1);
    expect(cdp.isAttached(1)).toBe(true);
  });

  it('returns false after full detach', async () => {
    await cdp.attach(1);
    await cdp.detach(1);
    expect(cdp.isAttached(1)).toBe(false);
  });
});

describe('cleanup', () => {
  it('removes tab state', async () => {
    await cdp.attach(1);
    cdp.cleanup(1);
    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.getEpoch(1)).toBe(-1);
  });

  it('is a no-op for unknown tabs', () => {
    cdp.cleanup(999); // should not throw
  });
});

describe('setupListeners', () => {
  it('registers onDetach and onEvent listeners', () => {
    cdp.setupListeners();
    expect(mockDebugger._listeners.onDetach).toHaveLength(1);
    expect(mockDebugger._listeners.onEvent).toHaveLength(1);
  });

  it('onDetach listener increments epoch and cleans up tab', async () => {
    await cdp.attach(1);
    cdp.setupListeners();

    // Simulate external detach
    const onDetachHandler = mockDebugger._listeners.onDetach[0];
    onDetachHandler({ tabId: 1 }, 'target_closed');

    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.getEpoch(1)).toBe(-1);
  });

  it('onDetach listener is a no-op for source without tabId', async () => {
    cdp.setupListeners();
    const onDetachHandler = mockDebugger._listeners.onDetach[0];
    onDetachHandler({}, 'canceled_by_user'); // no tabId — should not throw
  });

  it('top-level Page.frameNavigated event increments epoch', async () => {
    await cdp.attach(1);
    cdp.setupListeners();

    const onEventHandler = mockDebugger._listeners.onEvent[0];
    // Top-level frame: parentId is undefined
    onEventHandler({ tabId: 1 }, 'Page.frameNavigated', {
      frame: { id: 'main', parentId: undefined },
    });

    expect(cdp.getEpoch(1)).toBe(1);
    // Tab should still be attached (navigation doesn't remove it)
    expect(cdp.isAttached(1)).toBe(true);
  });

  it('sub-frame Page.frameNavigated does NOT increment epoch', async () => {
    await cdp.attach(1);
    cdp.setupListeners();

    const onEventHandler = mockDebugger._listeners.onEvent[0];
    onEventHandler({ tabId: 1 }, 'Page.frameNavigated', {
      frame: { id: 'child', parentId: 'main' },
    });

    expect(cdp.getEpoch(1)).toBe(0); // unchanged
  });

  it('Inspector.detached event increments epoch and cleans up', async () => {
    await cdp.attach(1);
    cdp.setupListeners();

    const onEventHandler = mockDebugger._listeners.onEvent[0];
    onEventHandler({ tabId: 1 }, 'Inspector.detached', {});

    expect(cdp.isAttached(1)).toBe(false);
    expect(cdp.getEpoch(1)).toBe(-1);
  });

  it('onEvent listener is a no-op for source without tabId', async () => {
    cdp.setupListeners();
    const onEventHandler = mockDebugger._listeners.onEvent[0];
    onEventHandler({}, 'Page.frameNavigated', {}); // no tabId — should not throw
  });
});
