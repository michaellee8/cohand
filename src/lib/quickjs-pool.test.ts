import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the quickjs-emscripten module since WASM is not available in vitest
const createMockModule = () => ({
  newRuntime: vi.fn(() => ({
    alive: true,
    newContext: vi.fn(),
    setMemoryLimit: vi.fn(),
    setMaxStackSize: vi.fn(),
    dispose: vi.fn(),
  })),
  _id: Math.random(),
});

vi.mock('quickjs-emscripten', () => ({
  newQuickJSAsyncWASMModule: vi.fn(() => Promise.resolve(createMockModule())),
}));

import { QuickJSPool } from './quickjs-pool';

describe('QuickJSPool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates the specified number of modules on init', async () => {
    const pool = new QuickJSPool();
    await pool.init(3);

    expect(pool.size).toBe(3);
    expect(pool.availableCount).toBe(3);
    expect(pool.isInitialized).toBe(true);
  });

  it('init() is idempotent — second call is a no-op', async () => {
    const { newQuickJSAsyncWASMModule } = await import('quickjs-emscripten');
    const pool = new QuickJSPool();

    await pool.init(2);
    const callCount = (newQuickJSAsyncWASMModule as any).mock.calls.length;

    await pool.init(2);
    expect((newQuickJSAsyncWASMModule as any).mock.calls.length).toBe(callCount);
    expect(pool.size).toBe(2);
  });

  it('acquire() returns a module and decrements available count', async () => {
    const pool = new QuickJSPool();
    await pool.init(2);

    const mod = await pool.acquire();
    expect(mod).toBeDefined();
    expect(pool.availableCount).toBe(1);
  });

  it('release() returns a module and increments available count', async () => {
    const pool = new QuickJSPool();
    await pool.init(2);

    const mod = await pool.acquire();
    expect(pool.availableCount).toBe(1);

    pool.release(mod);
    expect(pool.availableCount).toBe(2);
  });

  it('acquire() blocks when all modules are in use, resolves on release', async () => {
    const pool = new QuickJSPool();
    await pool.init(1);

    const mod1 = await pool.acquire();
    expect(pool.availableCount).toBe(0);

    // This should block because there are no available modules
    let resolved = false;
    const acquirePromise = pool.acquire().then((m) => {
      resolved = true;
      return m;
    });

    // Should still be waiting
    await new Promise((r) => setTimeout(r, 10));
    expect(resolved).toBe(false);

    // Release the module — waiter should resolve
    pool.release(mod1);

    const mod2 = await acquirePromise;
    expect(resolved).toBe(true);
    expect(mod2).toBe(mod1);
  });

  it('multiple waiters are served in FIFO order', async () => {
    const pool = new QuickJSPool();
    await pool.init(1);

    const mod = await pool.acquire();

    const order: number[] = [];

    const p1 = pool.acquire().then((m) => { order.push(1); return m; });
    const p2 = pool.acquire().then((m) => { order.push(2); return m; });

    // Release once — first waiter served
    pool.release(mod);
    const m1 = await p1;

    // Release again — second waiter served
    pool.release(m1);
    await p2;

    expect(order).toEqual([1, 2]);
  });

  it('acquire() throws if pool is not initialized', async () => {
    const pool = new QuickJSPool();

    await expect(pool.acquire()).rejects.toThrow('not initialized');
  });

  it('uses default pool size from QUICKJS_MODULE_POOL_SIZE', async () => {
    const pool = new QuickJSPool();
    await pool.init(); // no arg = default

    // QUICKJS_MODULE_POOL_SIZE = 3
    expect(pool.size).toBe(3);
  });

  it('handles concurrent acquire/release without deadlock', async () => {
    const pool = new QuickJSPool();
    await pool.init(2);

    // Acquire all modules
    const m1 = await pool.acquire();
    const m2 = await pool.acquire();
    expect(pool.availableCount).toBe(0);

    // Start 3 more acquires that will block
    const p3 = pool.acquire();
    const p4 = pool.acquire();
    const p5 = pool.acquire();

    // Release modules one by one
    pool.release(m1);
    pool.release(m2);

    const m3 = await p3;
    const m4 = await p4;

    pool.release(m3);
    const m5 = await p5;

    // All resolved, release final
    pool.release(m4);
    pool.release(m5);

    expect(pool.availableCount).toBe(2);
  });
});
