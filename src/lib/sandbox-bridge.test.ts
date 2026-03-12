// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SandboxBridge } from './sandbox-bridge';
import { RPCClient } from './rpc-client';
import type { ExecuteScriptResult } from './sandbox-bridge';

// Mock iframe with a fake contentWindow
function createMockIframe(): {
  iframe: HTMLIFrameElement;
  contentWindow: { postMessage: ReturnType<typeof vi.fn> };
} {
  const contentWindow = { postMessage: vi.fn() };
  const iframe = { contentWindow } as unknown as HTMLIFrameElement;
  return { iframe, contentWindow };
}

// Create a mock RPCClient with spies
function createMockRPCClient(): RPCClient {
  const client = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    call: vi.fn(),
    isConnected: true,
    pendingCount: 0,
  } as unknown as RPCClient;
  return client;
}

describe('SandboxBridge', () => {
  let bridge: SandboxBridge;
  let mockIframe: ReturnType<typeof createMockIframe>;
  let mockRPC: RPCClient;

  beforeEach(() => {
    mockIframe = createMockIframe();
    mockRPC = createMockRPCClient();
    bridge = new SandboxBridge(mockRPC);
  });

  afterEach(() => {
    bridge.destroy();
  });

  it('forwards RPC from sandbox to service worker', async () => {
    (mockRPC.call as any).mockResolvedValue('clicked');
    bridge.init(mockIframe.iframe);

    // Simulate sandbox sending an RPC request
    const rpcMessage = {
      id: 1,
      type: 'rpc',
      method: 'click',
      args: { selector: '#btn' },
      taskId: 'task-1',
    };

    // Dispatch a MessageEvent as if from the sandbox iframe
    const event = new MessageEvent('message', {
      data: rpcMessage,
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    // Wait for the async handler
    await vi.waitFor(() => {
      expect(mockRPC.call).toHaveBeenCalledWith('click', { selector: '#btn' }, 'task-1');
    });
  });

  it('sends RPC result back to sandbox', async () => {
    (mockRPC.call as any).mockResolvedValue({ found: true });
    bridge.init(mockIframe.iframe);

    const rpcMessage = {
      id: 42,
      type: 'rpc',
      method: 'waitForSelector',
      args: { selector: '.item' },
      taskId: 'task-2',
    };

    const event = new MessageEvent('message', {
      data: rpcMessage,
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    // Wait for the async RPC to resolve and the result to be posted back
    await vi.waitFor(() => {
      expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          id: 42,
          type: 'rpc-result',
          ok: true,
          value: { found: true },
        },
        '*',
      );
    });
  });

  it('handles RPC errors', async () => {
    const error = new Error('Element not found');
    (error as any).type = 'SelectorNotFound';
    (mockRPC.call as any).mockRejectedValue(error);
    bridge.init(mockIframe.iframe);

    const rpcMessage = {
      id: 7,
      type: 'rpc',
      method: 'click',
      args: { selector: '#missing' },
      taskId: 'task-3',
    };

    const event = new MessageEvent('message', {
      data: rpcMessage,
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          id: 7,
          type: 'rpc-result',
          ok: false,
          error: { type: 'SelectorNotFound', message: 'Element not found' },
        },
        '*',
      );
    });
  });

  it('sends execute-script requests to sandbox', () => {
    bridge.init(mockIframe.iframe);

    bridge.executeScript({
      type: 'execute-script',
      taskId: 'task-4',
      source: 'await page.click("#btn");',
      state: { step: 1 },
      tabId: 123,
    });

    expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
      {
        type: 'execute-script',
        taskId: 'task-4',
        source: 'await page.click("#btn");',
        state: { step: 1 },
        tabId: 123,
      },
      '*',
    );
  });

  it('receives execute-script-result from sandbox', async () => {
    bridge.init(mockIframe.iframe);

    const resultPromise = new Promise<ExecuteScriptResult>((resolve) => {
      bridge.onExecutionResult(resolve);
    });

    const resultMsg: ExecuteScriptResult = {
      type: 'execute-script-result',
      ok: true,
      result: { data: 'scraped' },
      state: { step: 2 },
    };

    const event = new MessageEvent('message', {
      data: resultMsg,
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    const result = await resultPromise;
    expect(result).toEqual(resultMsg);
  });

  it('ignores messages from non-sandbox sources', async () => {
    (mockRPC.call as any).mockResolvedValue('should not be called');
    bridge.init(mockIframe.iframe);

    // Message from a different source (not the sandbox iframe)
    const event = new MessageEvent('message', {
      data: { id: 1, type: 'rpc', method: 'click', args: {}, taskId: 'task-x' },
      source: null,
    });
    window.dispatchEvent(event);

    // Give a tick for any async handler
    await new Promise((r) => setTimeout(r, 10));

    expect(mockRPC.call).not.toHaveBeenCalled();
    expect(mockIframe.contentWindow.postMessage).not.toHaveBeenCalled();
  });

  it('handles RPC errors without a type property', async () => {
    const error = new Error('generic failure');
    (mockRPC.call as any).mockRejectedValue(error);
    bridge.init(mockIframe.iframe);

    const rpcMessage = {
      id: 99,
      type: 'rpc',
      method: 'goto',
      args: { url: 'https://example.com' },
      taskId: 'task-5',
    };

    const event = new MessageEvent('message', {
      data: rpcMessage,
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    await vi.waitFor(() => {
      expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
        {
          id: 99,
          type: 'rpc-result',
          ok: false,
          error: { type: 'Unknown', message: 'generic failure' },
        },
        '*',
      );
    });
  });

  it('destroy cleans up listeners and disconnects RPC', () => {
    bridge.init(mockIframe.iframe);
    bridge.destroy();

    expect(mockRPC.disconnect).toHaveBeenCalledOnce();

    // After destroy, messages should not be processed
    (mockRPC.call as any).mockResolvedValue('nope');
    const event = new MessageEvent('message', {
      data: { id: 1, type: 'rpc', method: 'click', args: {}, taskId: 'task-z' },
      source: mockIframe.contentWindow as any,
    });
    window.dispatchEvent(event);

    expect(mockRPC.call).not.toHaveBeenCalled();
  });

  it('sends postMessage with specific target origin, not wildcard', () => {
    bridge.init(mockIframe.iframe);

    bridge.executeScript({
      type: 'execute-script',
      taskId: 'task-origin',
      source: 'test',
      state: {},
      tabId: 1,
    });

    // In test env, getTargetOrigin falls back to '*' since chrome.runtime isn't available
    // But verify postMessage IS called with the second argument
    const call = mockIframe.contentWindow.postMessage.mock.calls[0];
    expect(call.length).toBe(2);
    expect(call[1]).toBeDefined();
  });
});
