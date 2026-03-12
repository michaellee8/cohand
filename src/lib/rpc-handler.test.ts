import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RPCHandler } from './rpc-handler';
import type { ScriptRPC } from '../types';

function createMockPort(name = 'script-rpc'): {
  port: chrome.runtime.Port;
  listeners: { message: Function[]; disconnect: Function[] };
} {
  const listeners = { message: [] as Function[], disconnect: [] as Function[] };
  const port = {
    name,
    postMessage: vi.fn(),
    onMessage: {
      addListener: (fn: Function) => listeners.message.push(fn),
    },
    onDisconnect: {
      addListener: (fn: Function) => listeners.disconnect.push(fn),
    },
    disconnect: vi.fn(),
  } as unknown as chrome.runtime.Port;
  return { port, listeners };
}

describe('RPCHandler', () => {
  let handler: RPCHandler;

  beforeEach(() => {
    handler = new RPCHandler();
  });

  it('dispatches to registered method handler', async () => {
    handler.register('click', async (rpc) => ({
      ok: true,
      value: `clicked ${rpc.args.selector}`,
    }));

    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 1,
      taskId: 'task-1',
      method: 'click',
      args: { selector: '#btn' },
      deadline: Date.now() + 60_000,
    };

    // Trigger the message listener
    await listeners.message[0](rpc);

    expect(port.postMessage).toHaveBeenCalledWith({
      id: 1,
      ok: true,
      value: 'clicked #btn',
    });
  });

  it('returns error for unknown method', async () => {
    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 2,
      taskId: 'task-2',
      method: 'nonexistent',
      args: {},
      deadline: Date.now() + 60_000,
    };

    await listeners.message[0](rpc);

    expect(port.postMessage).toHaveBeenCalledWith({
      id: 2,
      ok: false,
      error: { type: 'Unknown', message: 'Unknown RPC method: nonexistent' },
    });
  });

  it('returns deadline exceeded for expired RPCs', async () => {
    handler.register('click', async () => ({ ok: true, value: 'done' }));

    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 3,
      taskId: 'task-3',
      method: 'click',
      args: { selector: '#btn' },
      deadline: Date.now() - 1000, // already expired
    };

    await listeners.message[0](rpc);

    expect(port.postMessage).toHaveBeenCalledWith({
      id: 3,
      ok: false,
      error: { type: 'DeadlineExceeded', message: 'RPC deadline exceeded before processing' },
    });
  });

  it('catches handler errors', async () => {
    handler.register('boom', async () => {
      throw new Error('Handler exploded');
    });

    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 4,
      taskId: 'task-4',
      method: 'boom',
      args: {},
      deadline: Date.now() + 60_000,
    };

    await listeners.message[0](rpc);

    expect(port.postMessage).toHaveBeenCalledWith({
      id: 4,
      ok: false,
      error: { type: 'TargetDetached', message: 'Error: Handler exploded' },
    });
  });

  it('ignores ports with wrong name', () => {
    const { port, listeners } = createMockPort('other-port');
    handler.handleConnection(port);

    // No message listener should be attached
    expect(listeners.message).toHaveLength(0);
  });

  it('listen() wires into chrome.runtime.onConnect', () => {
    let capturedListener: Function | undefined;
    (globalThis as any).chrome = {
      runtime: {
        onConnect: {
          addListener: (fn: Function) => {
            capturedListener = fn;
          },
        },
      },
    };

    handler.listen();
    expect(typeof capturedListener).toBe('function');

    delete (globalThis as any).chrome;
  });

  it('handler receives full rpc object', async () => {
    let receivedRpc: ScriptRPC | undefined;
    handler.register('fill', async (rpc) => {
      receivedRpc = rpc;
      return { ok: true };
    });

    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 5,
      taskId: 'task-5',
      method: 'fill',
      args: { selector: '#input', value: 'hello' },
      deadline: Date.now() + 60_000,
    };

    await listeners.message[0](rpc);

    expect(receivedRpc).toEqual(rpc);
    expect(port.postMessage).toHaveBeenCalledWith({
      id: 5,
      ok: true,
    });
  });

  it('handler returning error result sends error response', async () => {
    handler.register('goto', async () => ({
      ok: false as const,
      error: { type: 'DomainDisallowed', message: 'Blocked domain' },
    }));

    const { port, listeners } = createMockPort();
    handler.handleConnection(port);

    const rpc: ScriptRPC = {
      id: 6,
      taskId: 'task-6',
      method: 'goto',
      args: { url: 'https://evil.com' },
      deadline: Date.now() + 60_000,
    };

    await listeners.message[0](rpc);

    expect(port.postMessage).toHaveBeenCalledWith({
      id: 6,
      ok: false,
      error: { type: 'DomainDisallowed', message: 'Blocked domain' },
    });
  });
});
