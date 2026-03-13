import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCHandler } from './rpc-handler';
import type { ScriptRPC } from '../types';
import type { CDPManager } from './cdp';
import { CDPNavigationError } from './cdp';
import { SelectorNotFoundError } from './selector-resolver';
import type { HandlerContext } from './humanized-page-handler';
import {
  registerPageMethods,
  resetCumulativeReads,
  getCumulativeReads,
  resetNavigationTimestamps,
} from './humanized-page-handler';

// ---- Mocks ----

// Mock keepalive to prevent setInterval from running with fake timers
vi.mock('./keepalive', () => ({
  startKeepalive: vi.fn(),
  stopKeepalive: vi.fn(),
  isKeepaliveActive: vi.fn().mockReturnValue(false),
}));

vi.mock('./selector-resolver', () => ({
  resolveSelector: vi.fn(),
  resolveA11ySelector: vi.fn(),
  SelectorNotFoundError: class SelectorNotFoundError extends Error {
    constructor(msg: string) {
      super(msg);
      this.name = 'SelectorNotFoundError';
    }
  },
}));

vi.mock('./humanize', () => ({
  humanizedClick: vi.fn().mockResolvedValue(undefined),
  humanizedType: vi.fn().mockResolvedValue(undefined),
  humanizedScroll: vi.fn().mockResolvedValue(undefined),
  humanizedMouseMove: vi.fn().mockResolvedValue(undefined),
}));

// Import mocked modules so we can control their behavior
import {
  resolveSelector,
  resolveA11ySelector,
} from './selector-resolver';
import {
  humanizedClick,
  humanizedType,
  humanizedScroll,
} from './humanize';

const mockedResolveSelector = vi.mocked(resolveSelector);
const mockedResolveA11ySelector = vi.mocked(resolveA11ySelector);
const mockedHumanizedClick = vi.mocked(humanizedClick);
const mockedHumanizedType = vi.mocked(humanizedType);
const mockedHumanizedScroll = vi.mocked(humanizedScroll);

// ---- Helpers ----

vi.useFakeTimers();

function createMockCDP(): CDPManager {
  return {
    send: vi.fn().mockResolvedValue(undefined),
    getMousePosition: vi.fn().mockReturnValue({ x: 0, y: 0 }),
    setMousePosition: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
    getEpoch: vi.fn().mockReturnValue(0),
    incrementEpoch: vi.fn(),
    isEpochValid: vi.fn().mockReturnValue(true),
    isAttached: vi.fn().mockReturnValue(true),
    cleanup: vi.fn(),
    setupListeners: vi.fn(),
  } as unknown as CDPManager;
}

function createContext(overrides?: Partial<HandlerContext>): HandlerContext {
  return {
    cdp: createMockCDP(),
    getAllowedDomains: vi.fn().mockResolvedValue(['example.com']),
    getTabUrl: vi.fn().mockResolvedValue('https://www.example.com/page'),
    getTabId: vi.fn().mockReturnValue(42),
    ...overrides,
  };
}

function makeRPC(
  method: string,
  args: Record<string, unknown> = {},
  overrides?: Partial<ScriptRPC>,
): ScriptRPC {
  return {
    id: 1,
    taskId: 'task-1',
    method,
    args,
    deadline: Date.now() + 60_000,
    ...overrides,
  };
}

const MOCK_ELEMENT = {
  nodeId: 42,
  centerX: 200,
  centerY: 300,
  bounds: { x: 100, y: 200, width: 200, height: 200 },
};

/**
 * Invoke an RPC method through the RPCHandler by simulating a port message.
 * Fire-and-forget the message listener, then advance fake timers so any
 * setTimeout calls inside the handler (goto, waitForLoadState, etc.) resolve.
 */
async function invokeRPC(
  handler: RPCHandler,
  rpc: ScriptRPC,
): Promise<{ id: number; ok: boolean; value?: unknown; error?: { type: string; message: string } }> {
  const listeners = { message: [] as Function[], disconnect: [] as Function[] };
  const port = {
    name: 'script-rpc',
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: Function) => listeners.message.push(fn),
    },
    onDisconnect: {
      addListener: (fn: Function) => listeners.disconnect.push(fn),
    },
    disconnect: vi.fn(),
  } as unknown as chrome.runtime.Port;

  handler.handleConnection(port);

  // Fire the message listener without awaiting it so we can advance timers
  const handlerPromise = listeners.message[0](rpc);

  // Flush all pending timers (setTimeout calls inside handlers)
  await vi.runAllTimersAsync();

  // Now await the handler to ensure it has completed
  await handlerPromise;

  return (port.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
}

// ---- Tests ----

describe('registerPageMethods', () => {
  let handler: RPCHandler;
  let ctx: HandlerContext;

  beforeEach(() => {
    vi.clearAllMocks();
    handler = new RPCHandler();
    ctx = createContext();
    registerPageMethods(handler, ctx);

    // Default: resolveSelector returns a valid element
    mockedResolveSelector.mockResolvedValue(MOCK_ELEMENT);
    mockedResolveA11ySelector.mockResolvedValue(MOCK_ELEMENT);
  });

  afterEach(() => {
    resetCumulativeReads('task-1');
    resetNavigationTimestamps('task-1');
  });

  // ---- goto ----

  it('goto: navigates to URL with domain validation', async () => {
    const rpc = makeRPC('goto', { args: ['https://www.example.com/new-page'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(vi.mocked(ctx.cdp.send)).toHaveBeenCalledWith(42, 'Page.navigate', {
      url: 'https://www.example.com/new-page',
    });
  });

  it('goto: rejects disallowed domain', async () => {
    const rpc = makeRPC('goto', { args: ['https://evil.com/page'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('TargetDetached');
    expect(result.error?.message).toContain('disallowed domain');
  });

  // ---- click ----

  it('click: resolves selector and performs humanized click', async () => {
    const rpc = makeRPC('click', { args: ['#submit-btn'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedResolveSelector).toHaveBeenCalledWith(ctx.cdp, 42, '#submit-btn');
    expect(mockedHumanizedClick).toHaveBeenCalledTimes(1);

    // Target coordinates should be within the element bounds (30%-70%)
    const [, , , targetX, targetY] = mockedHumanizedClick.mock.calls[0];
    expect(targetX).toBeGreaterThanOrEqual(100 + 0.3 * 200);
    expect(targetX).toBeLessThanOrEqual(100 + 0.7 * 200);
    expect(targetY).toBeGreaterThanOrEqual(200 + 0.3 * 200);
    expect(targetY).toBeLessThanOrEqual(200 + 0.7 * 200);
  });

  // ---- fill ----

  it('fill: click + select all + humanized type', async () => {
    const rpc = makeRPC('fill', { args: ['#name-input', 'John Doe'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedResolveSelector).toHaveBeenCalledWith(ctx.cdp, 42, '#name-input');

    // Should click to focus
    expect(mockedHumanizedClick).toHaveBeenCalledTimes(1);

    // Should send Ctrl+A (select all)
    const sendCalls = vi.mocked(ctx.cdp.send).mock.calls;
    const ctrlACalls = sendCalls.filter(
      (c) =>
        c[1] === 'Input.dispatchKeyEvent' &&
        (c[2] as { key?: string })?.key === 'a' &&
        (c[2] as { modifiers?: number })?.modifiers === 2,
    );
    expect(ctrlACalls.length).toBe(2); // keyDown + keyUp

    // Should type the text
    expect(mockedHumanizedType).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedType.mock.calls[0][3]).toBe('John Doe');
  });

  // ---- type ----

  it('type: click + humanized type (no select all)', async () => {
    const rpc = makeRPC('type', { args: ['#search', 'hello'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedHumanizedClick).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedType).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedType.mock.calls[0][3]).toBe('hello');

    // Should NOT send Ctrl+A
    const sendCalls = vi.mocked(ctx.cdp.send).mock.calls;
    const ctrlACalls = sendCalls.filter(
      (c) =>
        c[1] === 'Input.dispatchKeyEvent' &&
        (c[2] as { key?: string })?.key === 'a' &&
        (c[2] as { modifiers?: number })?.modifiers === 2,
    );
    expect(ctrlACalls.length).toBe(0);
  });

  // ---- scroll ----

  it('scroll: performs humanized scroll', async () => {
    const rpc = makeRPC('scroll', { args: [500] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedHumanizedScroll).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedScroll.mock.calls[0][0]).toBe(ctx.cdp);
    expect(mockedHumanizedScroll.mock.calls[0][1]).toBe(42);
    expect(mockedHumanizedScroll.mock.calls[0][3]).toBe(500);
  });

  // ---- url ----

  it('url: returns tab URL', async () => {
    const rpc = makeRPC('url', { args: [] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe('https://www.example.com/page');
  });

  // ---- title ----

  it('title: evaluates document.title via CDP', async () => {
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({
      result: { value: 'My Page Title' },
    });

    const rpc = makeRPC('title', { args: [] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe('My Page Title');
    expect(vi.mocked(ctx.cdp.send)).toHaveBeenCalledWith(
      42,
      'Runtime.evaluate',
      { expression: 'document.title' },
    );
  });

  // ---- waitForSelector ----

  it('waitForSelector: polls until found', async () => {
    // Fail twice, then succeed
    mockedResolveSelector
      .mockRejectedValueOnce(new SelectorNotFoundError('not yet'))
      .mockRejectedValueOnce(new SelectorNotFoundError('not yet'))
      .mockResolvedValueOnce(MOCK_ELEMENT);

    const rpc = makeRPC('waitForSelector', { args: ['.loading-done', { timeout: 5000 }] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedResolveSelector).toHaveBeenCalledTimes(3);
  });

  it('waitForSelector: times out with SelectorNotFound', async () => {
    mockedResolveSelector.mockRejectedValue(
      new SelectorNotFoundError('nope'),
    );

    // Use a very short timeout so the test doesn't wait long
    const rpc = makeRPC('waitForSelector', { args: ['.never', { timeout: 100 }] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('SelectorNotFound');
    expect(result.error?.message).toContain('Timeout waiting for: .never');
  });

  // ---- locator_action: textContent ----

  it('locator_action textContent: caps at 500 chars, tracks reads', async () => {
    const longHTML = '<div>' + 'a'.repeat(600) + '</div>';
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({ outerHTML: longHTML });

    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['div.content'],
      actionMethod: 'textContent',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    // The text after stripping HTML tags is 600 'a's, capped at 500
    expect((result.value as string).length).toBe(500);
    // Cumulative reads should be tracked
    expect(getCumulativeReads('task-1')).toBe(500);
  });

  // ---- locator_action: getAttribute ----

  it('locator_action getAttribute: only allows whitelisted attributes', async () => {
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({
      attributes: ['href', 'https://example.com', 'role', 'button'],
    });

    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['a.link'],
      actionMethod: 'getAttribute',
      actionArgs: ['href'],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe('https://example.com');
  });

  it('locator_action getAttribute: rejects non-whitelisted attributes', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['input'],
      actionMethod: 'getAttribute',
      actionArgs: ['value'], // not in whitelist
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('TargetDetached');
    expect(result.error?.message).toContain('not in whitelist');
  });

  it('locator_action getAttribute: returns null for missing attribute', async () => {
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({
      attributes: ['class', 'btn'],
    });

    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['button'],
      actionMethod: 'getAttribute',
      actionArgs: ['href'],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(null);
  });

  // ---- locator_action: boundingBox ----

  it('locator_action boundingBox: returns element bounds', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['div.box'],
      actionMethod: 'boundingBox',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      x: 100,
      y: 200,
      width: 200,
      height: 200,
    });
  });

  // ---- locator_action: isVisible ----

  it('locator_action isVisible: returns true for visible elements', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['div.visible'],
      actionMethod: 'isVisible',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
  });

  it('locator_action isVisible: returns false for zero-size elements', async () => {
    mockedResolveSelector.mockResolvedValueOnce({
      nodeId: 10,
      centerX: 0,
      centerY: 0,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
    });

    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['div.hidden'],
      actionMethod: 'isVisible',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(false);
  });

  // ---- locator_action: count ----

  it('locator_action count: returns number of matching elements', async () => {
    vi.mocked(ctx.cdp.send)
      .mockResolvedValueOnce({ root: { nodeId: 1 } })
      .mockResolvedValueOnce({ nodeIds: [10, 20, 30] });

    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['li.item'],
      actionMethod: 'count',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBe(3);
  });

  // ---- locator_action: click via getByRole ----

  it('locator_action click via getByRole: resolves a11y selector', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'getByRole',
      locatorArgs: ['button', 'Submit'],
      actionMethod: 'click',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedResolveA11ySelector).toHaveBeenCalledWith(
      ctx.cdp,
      42,
      'button',
      'Submit',
    );
    expect(mockedHumanizedClick).toHaveBeenCalledTimes(1);
  });

  // ---- locator_action: getByText ----

  it('locator_action: getByText resolves to a11y selector with name only', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'getByText',
      locatorArgs: ['Hello World'],
      actionMethod: 'click',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedResolveA11ySelector).toHaveBeenCalledWith(
      ctx.cdp,
      42,
      undefined,
      'Hello World',
    );
  });

  // ---- locator_action: unknown locator method ----

  it('locator_action: rejects unknown locator method', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'getByMagic',
      locatorArgs: ['foo'],
      actionMethod: 'click',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Unknown locator method');
  });

  // ---- locator_action: unknown action method ----

  it('locator_action: rejects unknown action method', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['div'],
      actionMethod: 'destroy',
      actionArgs: [],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain('Unknown locator action');
  });

  // ---- domain validation ----

  it('domain validation: rejects when domain not allowed', async () => {
    vi.mocked(ctx.getTabUrl).mockResolvedValue('https://evil.com/page');

    const rpc = makeRPC('click', { args: ['#btn'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('DomainDisallowed');
    expect(result.error?.message).toContain('Domain not allowed');
  });

  // ---- no tab ----

  it('returns TargetDetached when no tab for task', async () => {
    vi.mocked(ctx.getTabId).mockReturnValue(undefined);

    const rpc = makeRPC('click', { args: ['#btn'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('TargetDetached');
    expect(result.error?.message).toBe('No tab for task');
  });

  // ---- error handling: SelectorNotFoundError ----

  it('handles SelectorNotFoundError', async () => {
    mockedResolveSelector.mockRejectedValueOnce(
      new SelectorNotFoundError('Selector not found: .missing'),
    );

    const rpc = makeRPC('click', { args: ['.missing'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('SelectorNotFound');
    expect(result.error?.message).toBe('Selector not found: .missing');
  });

  // ---- error handling: CDPNavigationError ----

  it('handles CDPNavigationError', async () => {
    mockedResolveSelector.mockRejectedValueOnce(
      new CDPNavigationError('Navigation detected during DOM.querySelector'),
    );

    const rpc = makeRPC('click', { args: ['#btn'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(false);
    expect(result.error?.type).toBe('NavigationChanged');
    expect(result.error?.message).toContain('Navigation detected');
  });

  // ---- notify ----

  it('notify: passes through message', async () => {
    const rpc = makeRPC('notify', { message: 'Task complete!' });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      queued: true,
      message: 'Task complete!',
    });
  });

  it('notify: does not require domain validation', async () => {
    // Set tab URL to a disallowed domain — notify should still succeed
    vi.mocked(ctx.getTabUrl).mockResolvedValue('https://evil.com/page');

    const rpc = makeRPC('notify', { message: 'Still works' });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toEqual({
      queued: true,
      message: 'Still works',
    });
  });

  // ---- waitForLoadState ----

  it('waitForLoadState: resolves after delay', async () => {
    const rpc = makeRPC('waitForLoadState', { args: ['networkidle'] });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(result.value).toBeUndefined();
  });

  // ---- cumulative reads tracking ----

  it('tracks cumulative reads across multiple textContent calls', async () => {
    resetCumulativeReads('task-1');

    // First read: 10 chars
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({
      outerHTML: '<p>0123456789</p>',
    });
    const rpc1 = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['p'],
      actionMethod: 'textContent',
      actionArgs: [],
    });
    await invokeRPC(handler, rpc1);
    expect(getCumulativeReads('task-1')).toBe(10);

    // Second read: 5 chars
    vi.mocked(ctx.cdp.send).mockResolvedValueOnce({
      outerHTML: '<p>hello</p>',
    });
    const rpc2 = makeRPC(
      'locator_action',
      {
        locatorMethod: 'locator',
        locatorArgs: ['p'],
        actionMethod: 'textContent',
        actionArgs: [],
      },
      { id: 2 },
    );
    await invokeRPC(handler, rpc2);
    expect(getCumulativeReads('task-1')).toBe(15);
  });

  // ---- locator_action fill via locator ----

  it('locator_action fill: clicks and types text', async () => {
    const rpc = makeRPC('locator_action', {
      locatorMethod: 'locator',
      locatorArgs: ['#input'],
      actionMethod: 'fill',
      actionArgs: ['hello world'],
    });
    const result = await invokeRPC(handler, rpc);

    expect(result.ok).toBe(true);
    expect(mockedHumanizedClick).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedType).toHaveBeenCalledTimes(1);
    expect(mockedHumanizedType.mock.calls[0][3]).toBe('hello world');
  });

  // ---- navigator rate limit (Task 6) ----

  describe('navigation rate limit', () => {
    it('allows up to 5 navigations within 60 seconds', async () => {
      resetNavigationTimestamps('task-1');

      for (let i = 0; i < 5; i++) {
        const rpc = makeRPC('goto', { args: ['https://www.example.com/page' + i] }, { id: i + 1 });
        const result = await invokeRPC(handler, rpc);
        expect(result.ok).toBe(true);
      }
    });

    it('rejects the 6th navigation within 60 seconds', async () => {
      resetNavigationTimestamps('task-1');

      // Perform 5 successful navigations
      for (let i = 0; i < 5; i++) {
        const rpc = makeRPC('goto', { args: ['https://www.example.com/page' + i] }, { id: i + 1 });
        const result = await invokeRPC(handler, rpc);
        expect(result.ok).toBe(true);
      }

      // 6th should be rejected
      const rpc = makeRPC('goto', { args: ['https://www.example.com/too-many'] }, { id: 100 });
      const result = await invokeRPC(handler, rpc);

      expect(result.ok).toBe(false);
      expect(result.error?.type).toBe('RateLimitExceeded');
      expect(result.error?.message).toContain('navigation rate limit');
    });

    it('allows navigation after the 60-second window passes', async () => {
      resetNavigationTimestamps('task-1');

      // Perform 5 navigations
      for (let i = 0; i < 5; i++) {
        const rpc = makeRPC('goto', { args: ['https://www.example.com/page' + i] }, { id: i + 1 });
        await invokeRPC(handler, rpc);
      }

      // Advance time past the 60-second window
      vi.advanceTimersByTime(61_000);

      // Now the 6th should succeed because the old timestamps expired
      const rpc = makeRPC('goto', { args: ['https://www.example.com/ok-again'] }, { id: 200 });
      const result = await invokeRPC(handler, rpc);
      expect(result.ok).toBe(true);
    });

    it('rate limits are per-task', async () => {
      resetNavigationTimestamps('task-1');
      resetNavigationTimestamps('task-2');

      // Fill up task-1's limit
      for (let i = 0; i < 5; i++) {
        const rpc = makeRPC('goto', { args: ['https://www.example.com/p' + i] }, { id: i + 1, taskId: 'task-1' });
        await invokeRPC(handler, rpc);
      }

      // task-2 should still be allowed
      const rpc = makeRPC('goto', { args: ['https://www.example.com/other'] }, { id: 50, taskId: 'task-2' });
      const result = await invokeRPC(handler, rpc);
      expect(result.ok).toBe(true);

      // Clean up task-2
      resetNavigationTimestamps('task-2');
    });
  });
});
