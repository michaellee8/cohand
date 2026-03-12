import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RPCClient, RPCError } from './rpc-client';

function createMockPort(): {
  port: chrome.runtime.Port;
  listeners: { message: Function[]; disconnect: Function[] };
} {
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
  return { port, listeners };
}

describe('RPCClient', () => {
  let client: RPCClient;
  let mockPort: ReturnType<typeof createMockPort>;

  beforeEach(() => {
    mockPort = createMockPort();
    (globalThis as any).chrome = {
      runtime: {
        connect: vi.fn(() => mockPort.port),
      },
    };
    client = new RPCClient();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it('call() sends message and resolves on success response', async () => {
    client.connect();

    const callPromise = client.call('click', { selector: '#btn' }, 'task-1');

    // Verify message was posted
    expect(mockPort.port.postMessage).toHaveBeenCalledOnce();
    const sentMsg = (mockPort.port.postMessage as any).mock.calls[0][0];
    expect(sentMsg).toMatchObject({
      id: 1,
      taskId: 'task-1',
      method: 'click',
      args: { selector: '#btn' },
    });
    expect(sentMsg.deadline).toBeTypeOf('number');

    // Simulate success response
    for (const listener of mockPort.listeners.message) {
      listener({ id: 1, ok: true, value: 'clicked' });
    }

    const result = await callPromise;
    expect(result).toBe('clicked');
    expect(client.pendingCount).toBe(0);
  });

  it('call() rejects on error response', async () => {
    client.connect();

    const callPromise = client.call('click', { selector: '#gone' }, 'task-2');

    // Simulate error response
    for (const listener of mockPort.listeners.message) {
      listener({
        id: 1,
        ok: false,
        error: { type: 'SelectorNotFound', message: 'Element not found' },
      });
    }

    await expect(callPromise).rejects.toThrow(RPCError);
    await expect(callPromise).rejects.toMatchObject({
      type: 'SelectorNotFound',
      message: 'Element not found',
    });
  });

  it('call() rejects on timeout', async () => {
    client.connect();

    const callPromise = client.call('goto', { url: 'https://example.com' }, 'task-3', 5000);

    // Advance timers past deadline
    vi.advanceTimersByTime(5001);

    await expect(callPromise).rejects.toThrow(RPCError);
    await expect(callPromise).rejects.toMatchObject({
      type: 'DeadlineExceeded',
      message: 'RPC timeout',
    });
    expect(client.pendingCount).toBe(0);
  });

  it('all pending rejected on disconnect', async () => {
    client.connect();

    const call1 = client.call('click', { selector: '#a' }, 'task-4');
    const call2 = client.call('fill', { selector: '#b', value: 'hi' }, 'task-4');

    expect(client.pendingCount).toBe(2);

    // Simulate port disconnect
    for (const listener of mockPort.listeners.disconnect) {
      listener();
    }

    await expect(call1).rejects.toThrow(RPCError);
    await expect(call1).rejects.toMatchObject({ type: 'OwnerDisconnected' });
    await expect(call2).rejects.toThrow(RPCError);
    await expect(call2).rejects.toMatchObject({ type: 'OwnerDisconnected' });
    expect(client.pendingCount).toBe(0);
    expect(client.isConnected).toBe(false);
  });

  it('call() throws if not connected', async () => {
    // Never called connect()
    await expect(
      client.call('click', { selector: '#x' }, 'task-5'),
    ).rejects.toThrow(RPCError);
    await expect(
      client.call('click', { selector: '#x' }, 'task-5'),
    ).rejects.toMatchObject({ type: 'OwnerDisconnected' });
  });

  it('increments ids correctly across calls', async () => {
    client.connect();

    client.call('click', { selector: '#a' }, 'task-6');
    client.call('fill', { selector: '#b', value: 'x' }, 'task-6');
    client.call('goto', { url: 'https://example.com' }, 'task-6');

    const calls = (mockPort.port.postMessage as any).mock.calls;
    expect(calls[0][0].id).toBe(1);
    expect(calls[1][0].id).toBe(2);
    expect(calls[2][0].id).toBe(3);
  });

  it('disconnect() calls port.disconnect and clears port', () => {
    client.connect();
    expect(client.isConnected).toBe(true);

    client.disconnect();
    expect(mockPort.port.disconnect).toHaveBeenCalledOnce();
    expect(client.isConnected).toBe(false);
  });

  it('disconnect() rejects all pending RPCs', async () => {
    client.connect();

    const call1 = client.call('click', { selector: '#a' }, 'task-d1');
    const call2 = client.call('fill', { selector: '#b', value: 'hi' }, 'task-d1');

    expect(client.pendingCount).toBe(2);

    client.disconnect();

    await expect(call1).rejects.toThrow(RPCError);
    await expect(call1).rejects.toMatchObject({
      type: 'OwnerDisconnected',
      message: 'Client disconnected',
    });
    await expect(call2).rejects.toThrow(RPCError);
    await expect(call2).rejects.toMatchObject({
      type: 'OwnerDisconnected',
      message: 'Client disconnected',
    });
    expect(client.pendingCount).toBe(0);
  });

  it('disconnect() clears pending timers', async () => {
    client.connect();

    const call1 = client.call('click', { selector: '#a' }, 'task-d2').catch(() => {});
    const call2 = client.call('fill', { selector: '#b', value: 'x' }, 'task-d2').catch(() => {});

    expect(client.pendingCount).toBe(2);

    client.disconnect();

    await call1;
    await call2;

    // If timers were not cleared, advancing time would cause issues.
    // With fake timers we can verify no timeout fires after disconnect.
    expect(client.pendingCount).toBe(0);
    // Advance past any potential timeout — should not throw
    vi.advanceTimersByTime(60_000);
    expect(client.pendingCount).toBe(0);
  });

  it('disconnect() with no pending RPCs still disconnects port', () => {
    client.connect();
    expect(client.pendingCount).toBe(0);

    client.disconnect();

    expect(mockPort.port.disconnect).toHaveBeenCalledOnce();
    expect(client.isConnected).toBe(false);
    expect(client.pendingCount).toBe(0);
  });

  it('ignores responses for unknown ids', async () => {
    client.connect();

    const callPromise = client.call('click', { selector: '#a' }, 'task-7');

    // Send response for a different id
    for (const listener of mockPort.listeners.message) {
      listener({ id: 999, ok: true, value: 'wrong' });
    }

    // Original call should still be pending
    expect(client.pendingCount).toBe(1);

    // Now send the correct response
    for (const listener of mockPort.listeners.message) {
      listener({ id: 1, ok: true, value: 'correct' });
    }

    const result = await callPromise;
    expect(result).toBe('correct');
  });

  it('resolves with undefined value on success with no value', async () => {
    client.connect();

    const callPromise = client.call('click', { selector: '#btn' }, 'task-8');

    for (const listener of mockPort.listeners.message) {
      listener({ id: 1, ok: true });
    }

    const result = await callPromise;
    expect(result).toBeUndefined();
  });
});
