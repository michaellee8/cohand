import { describe, it, expect } from 'vitest';
import { MessageRouter } from './message-router';

describe('MessageRouter', () => {
  it('dispatches to registered handler', async () => {
    const router = new MessageRouter();
    router.on('GET_TASKS', async () => ({ tasks: [] }));
    const result = await router.handleMessage({ type: 'GET_TASKS' }, {} as any);
    expect(result).toEqual({ tasks: [] });
  });

  it('returns error for unknown message type', async () => {
    const router = new MessageRouter();
    const result = await router.handleMessage(
      { type: 'UNKNOWN' } as any,
      {} as any,
    );
    expect(result).toHaveProperty('error');
  });

  it('propagates handler errors', async () => {
    const router = new MessageRouter();
    router.on('GET_TASKS', async () => {
      throw new Error('boom');
    });
    await expect(
      router.handleMessage({ type: 'GET_TASKS' }, {} as any),
    ).rejects.toThrow('boom');
  });

  it('passes message and sender to handler', async () => {
    const router = new MessageRouter();
    let receivedMessage: any;
    let receivedSender: any;
    router.on('GET_TASK', async (msg, sender) => {
      receivedMessage = msg;
      receivedSender = sender;
      return { task: undefined };
    });
    const msg = { type: 'GET_TASK' as const, taskId: 'test-123' };
    const sender = { tab: { id: 1 } } as any;
    await router.handleMessage(msg, sender);
    expect(receivedMessage).toEqual(msg);
    expect(receivedSender).toEqual(sender);
  });

  it('registers and invokes the listen method', () => {
    const router = new MessageRouter();
    router.on('GET_UNREAD_COUNT', async () => ({ count: 0 }));

    let capturedListener: any;
    (globalThis as any).chrome = {
      runtime: {
        onMessage: {
          addListener: (fn: any) => {
            capturedListener = fn;
          },
        },
      },
    };

    router.listen();
    expect(typeof capturedListener).toBe('function');

    // Verify listener returns true for async response
    const sendResponse = () => {};
    const result = capturedListener(
      { type: 'GET_UNREAD_COUNT' },
      {},
      sendResponse,
    );
    expect(result).toBe(true);
  });
});
