// src/lib/quickjs-pool.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock quickjs-emscripten since WASM isn't available in vitest
vi.mock('quickjs-emscripten', () => ({
  newQuickJSAsyncWASMModule: vi.fn().mockImplementation(() =>
    Promise.resolve({ id: Math.random() })
  ),
}));

import { QuickJSPool } from './quickjs-pool';

describe('QuickJSPool', () => {
  let pool: QuickJSPool;

  beforeEach(() => {
    pool = new QuickJSPool();
  });

  it('initializes with default size of 3', async () => {
    await pool.init();
    expect(pool.totalCount).toBe(3);
    expect(pool.availableCount).toBe(3);
    expect(pool.isInitialized).toBe(true);
  });

  it('initializes with custom size', async () => {
    await pool.init(5);
    expect(pool.totalCount).toBe(5);
    expect(pool.availableCount).toBe(5);
  });

  it('init is idempotent', async () => {
    await pool.init(3);
    await pool.init(5); // should not change
    expect(pool.totalCount).toBe(3);
  });

  it('acquire returns a module', async () => {
    await pool.init(2);
    const mod = pool.acquire();
    expect(mod).not.toBeNull();
    expect(pool.availableCount).toBe(1);
  });

  it('acquire returns null when pool exhausted', async () => {
    await pool.init(1);
    pool.acquire();
    expect(pool.acquire()).toBeNull();
  });

  it('release returns module to pool', async () => {
    await pool.init(2);
    const mod = pool.acquire()!;
    expect(pool.availableCount).toBe(1);
    pool.release(mod);
    expect(pool.availableCount).toBe(2);
  });

  it('release ignores unknown modules', async () => {
    await pool.init(2);
    pool.release({} as any); // foreign module
    expect(pool.availableCount).toBe(2); // unchanged
  });

  it('release ignores already-available modules (no double release)', async () => {
    await pool.init(2);
    const mod = pool.acquire()!;
    pool.release(mod);
    pool.release(mod); // double release
    expect(pool.availableCount).toBe(2); // not 3
  });

  it('acquire returns null before init', () => {
    expect(pool.acquire()).toBeNull();
    expect(pool.isInitialized).toBe(false);
  });

  it('dispose resets the pool', async () => {
    await pool.init(3);
    pool.dispose();
    expect(pool.totalCount).toBe(0);
    expect(pool.availableCount).toBe(0);
    expect(pool.isInitialized).toBe(false);
  });
});
