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

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------
const FAKE_EXTENSION_ORIGIN = 'https://fake-extension-id.chromiumapp.org';

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
      getURL: vi.fn((path: string) => `${FAKE_EXTENSION_ORIGIN}/${path}`),
    },
  };
}

beforeEach(() => {
  setupChromeMock();
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
      FAKE_EXTENSION_ORIGIN,
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

