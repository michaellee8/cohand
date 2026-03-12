// @vitest-environment happy-dom

/**
 * Tests for the end-to-end script execution flow.
 *
 * These tests verify the execution chain:
 * Service worker → offscreen document → sandbox iframe → RPC → CDP
 *
 * We test the components that make up this chain:
 * 1. SandboxBridge forwarding execution requests
 * 2. Sandbox main.ts executing scripts and sending RPCs
 * 3. RPCHandler dispatching to humanized page handlers
 * 4. Full round-trip simulation
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SandboxBridge, type ExecuteScriptResult } from './sandbox-bridge';
import { RPCHandler } from './rpc-handler';
import { executeScript, type HostCallFn } from './script-executor';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------
function setupChromeMock() {
  (globalThis as any).chrome = {
    runtime: {
      connect: vi.fn(() => ({
        onMessage: { addListener: vi.fn() },
        onDisconnect: { addListener: vi.fn() },
        postMessage: vi.fn(),
        disconnect: vi.fn(),
      })),
      onConnect: { addListener: vi.fn() },
    },
  };
}

beforeEach(() => {
  setupChromeMock();
});

// ---------------------------------------------------------------------------
// Script Executor tests (the core execution engine)
// ---------------------------------------------------------------------------

describe('Script execution with RPC bridge', () => {
  it('executes a script that calls page.goto', async () => {
    const calls: { method: string; args: unknown }[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      calls.push({ method, args });
      return undefined;
    };

    const source = `
      async function run(page, context) {
        await page.goto('https://example.com');
        return { visited: true };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ visited: true });
      expect(calls).toHaveLength(1);
      expect(calls[0].method).toBe('goto');
    }
  });

  it('executes a script that uses page.click', async () => {
    const calls: { method: string; args: unknown }[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      calls.push({ method, args });
      return undefined;
    };

    const source = `
      async function run(page, context) {
        await page.click('[aria-label="Like"]');
        return { clicked: true };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(calls[0].method).toBe('click');
      expect((calls[0].args as any).args[0]).toBe('[aria-label="Like"]');
    }
  });

  it('executes a script that reads and writes state', async () => {
    const hostCall: HostCallFn = async () => undefined;

    const source = `
      async function run(page, context) {
        const prev = context.state.counter || 0;
        context.state.counter = prev + 1;
        return { counter: context.state.counter };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, { counter: 5 });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ counter: 6 });
      expect(result.state.counter).toBe(6);
    }
  });

  it('handles script errors gracefully', async () => {
    const hostCall: HostCallFn = async () => undefined;

    const source = `
      async function run(page, context) {
        throw new Error('Script failed');
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Script failed');
    }
  });

  it('handles RPC errors from host calls', async () => {
    const hostCall: HostCallFn = async () => {
      throw new Error('Selector not found: .nonexistent');
    };

    const source = `
      async function run(page, context) {
        await page.click('.nonexistent');
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('Selector not found');
    }
  });

  it('executes script with locator pattern', async () => {
    const calls: { method: string; args: unknown }[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      calls.push({ method, args });
      if (method === 'locator_action') {
        const a = args as any;
        if (a.actionMethod === 'textContent') return 'Hello World';
      }
      return undefined;
    };

    const source = `
      async function run(page, context) {
        const text = await page.locator('.heading').textContent();
        return { text };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toEqual({ text: 'Hello World' });
      expect(calls[0].method).toBe('locator_action');
      expect((calls[0].args as any).locatorMethod).toBe('locator');
      expect((calls[0].args as any).actionMethod).toBe('textContent');
    }
  });

  it('executes script with getByRole pattern', async () => {
    const calls: { method: string; args: unknown }[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      calls.push({ method, args });
      return undefined;
    };

    const source = `
      async function run(page, context) {
        await page.getByRole('button', 'Submit').click();
        return { done: true };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(calls[0].method).toBe('locator_action');
      expect((calls[0].args as any).locatorMethod).toBe('getByRole');
      expect((calls[0].args as any).locatorArgs).toEqual(['button', 'Submit']);
      expect((calls[0].args as any).actionMethod).toBe('click');
    }
  });

  it('executes script with notify', async () => {
    const calls: { method: string; args: unknown }[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      calls.push({ method, args });
      return undefined;
    };

    const source = `
      async function run(page, context) {
        await context.notify('Price changed');
        return { notified: true };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});

    expect(result.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe('notify');
    expect((calls[0].args as any).message).toBe('Price changed');
  });
});

// ---------------------------------------------------------------------------
// RPCHandler dispatch tests (service worker side)
// ---------------------------------------------------------------------------

describe('RPCHandler method dispatch', () => {
  it('dispatches to registered methods', async () => {
    const handler = new RPCHandler();
    let called = false;

    handler.register('click', async (rpc) => {
      called = true;
      return { ok: true, value: undefined };
    });

    // Simulate a port connection
    const mockPort = {
      name: 'script-rpc',
      onMessage: {
        addListener: vi.fn(),
      },
      postMessage: vi.fn(),
    };

    handler.handleConnection(mockPort as any);

    // Get the message handler
    const messageHandler = (mockPort.onMessage.addListener as any).mock.calls[0][0];

    // Simulate RPC message
    await messageHandler({
      id: 1,
      taskId: 'task-1',
      method: 'click',
      args: { args: ['.button'] },
      deadline: Date.now() + 60000,
    });

    expect(called).toBe(true);
    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ id: 1, ok: true }),
    );
  });

  it('rejects expired deadlines', async () => {
    const handler = new RPCHandler();
    handler.register('click', async () => ({ ok: true, value: undefined }));

    const mockPort = {
      name: 'script-rpc',
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };

    handler.handleConnection(mockPort as any);
    const messageHandler = (mockPort.onMessage.addListener as any).mock.calls[0][0];

    await messageHandler({
      id: 1,
      taskId: 'task-1',
      method: 'click',
      args: {},
      deadline: Date.now() - 1000, // already expired
    });

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        ok: false,
        error: expect.objectContaining({ type: 'DeadlineExceeded' }),
      }),
    );
  });

  it('rejects unknown methods', async () => {
    const handler = new RPCHandler();

    const mockPort = {
      name: 'script-rpc',
      onMessage: { addListener: vi.fn() },
      postMessage: vi.fn(),
    };

    handler.handleConnection(mockPort as any);
    const messageHandler = (mockPort.onMessage.addListener as any).mock.calls[0][0];

    await messageHandler({
      id: 1,
      taskId: 'task-1',
      method: 'unknown_method',
      args: {},
      deadline: Date.now() + 60000,
    });

    expect(mockPort.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        ok: false,
        error: expect.objectContaining({ message: expect.stringContaining('Unknown RPC method') }),
      }),
    );
  });

  it('ignores non-script-rpc ports', () => {
    const handler = new RPCHandler();

    const mockPort = {
      name: 'other-port',
      onMessage: { addListener: vi.fn() },
    };

    handler.handleConnection(mockPort as any);
    expect(mockPort.onMessage.addListener).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// SandboxBridge communication tests
// ---------------------------------------------------------------------------

describe('SandboxBridge execution flow', () => {
  it('sends execute-script to iframe', () => {
    const bridge = new SandboxBridge();
    const mockIframe = {
      contentWindow: {
        postMessage: vi.fn(),
      },
    } as any;

    bridge.init(mockIframe);

    bridge.executeScript({
      type: 'execute-script',
      executionId: 'exec-flow-1',
      taskId: 'task-1',
      source: 'async function run(page) { return 42; }',
      state: {},
      tabId: 1,
    });

    expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execute-script',
        taskId: 'task-1',
        source: expect.stringContaining('run'),
      }),
      '*',
    );
  });

  it('receives execution results', () => {
    const bridge = new SandboxBridge();
    const mockIframe = {
      contentWindow: {
        postMessage: vi.fn(),
      },
    } as any;

    bridge.init(mockIframe);

    let receivedResult: ExecuteScriptResult | undefined;
    bridge.onExecutionResult((result) => {
      receivedResult = result;
    });

    // Simulate result from sandbox
    const event = new MessageEvent('message', {
      data: {
        type: 'execute-script-result',
        executionId: 'exec-flow-2',
        ok: true,
        result: { price: '$42' },
        state: { lastPrice: '$42' },
      },
      source: mockIframe.contentWindow,
    });
    window.dispatchEvent(event);

    expect(receivedResult).toBeDefined();
    expect(receivedResult!.ok).toBe(true);
    expect(receivedResult!.result).toEqual({ price: '$42' });
    expect(receivedResult!.state).toEqual({ lastPrice: '$42' });
  });
});

// ---------------------------------------------------------------------------
// Full round-trip simulation
// ---------------------------------------------------------------------------

describe('Full execution round-trip', () => {
  it('simulates complete script execution with state persistence', async () => {
    const rpcLog: string[] = [];
    const hostCall: HostCallFn = async (method, args) => {
      rpcLog.push(method);
      if (method === 'locator_action') {
        const a = args as any;
        if (a.actionMethod === 'textContent') return '$99.99';
      }
      return undefined;
    };

    const source = `
      async function run(page, context) {
        await page.goto(context.url);
        await page.waitForLoadState('domcontentloaded');
        const price = await page.locator('.price-display').textContent();
        const prev = context.state.lastPrice;
        if (prev && price !== prev) {
          await context.notify('Price changed: ' + prev + ' -> ' + price);
        }
        context.state.lastPrice = price;
        return { price };
      }
    `;

    // First run
    const result1 = await executeScript(source, 'task-1', hostCall, {}, 'https://example.com');
    expect(result1.ok).toBe(true);
    if (result1.ok) {
      expect(result1.result).toEqual({ price: '$99.99' });
      expect(result1.state.lastPrice).toBe('$99.99');
      // No notify on first run (no prev price)
      expect(rpcLog).not.toContain('notify');
    }

    // Second run with previous state
    rpcLog.length = 0;
    const result2 = await executeScript(
      source,
      'task-1',
      hostCall,
      { lastPrice: '$109.99' },
      'https://example.com',
    );
    expect(result2.ok).toBe(true);
    if (result2.ok) {
      expect(result2.result).toEqual({ price: '$99.99' });
      // Notify should be called because price changed
      expect(rpcLog).toContain('notify');
    }
  });

  it('properly records execution duration', async () => {
    const hostCall: HostCallFn = async () => undefined;

    const source = `
      async function run(page, context) {
        return { done: true };
      }
    `;

    const result = await executeScript(source, 'task-1', hostCall, {});
    expect(result.ok).toBe(true);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.durationMs).toBeLessThan(5000);
  });
});
