import {
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncWASMModule,
} from 'quickjs-emscripten';
import { QUICKJS_MODULE_POOL_SIZE } from '../constants';

/**
 * Pool of pre-initialized QuickJS WASM modules.
 *
 * The design calls for 3 modules (QUICKJS_MODULE_POOL_SIZE) because Asyncify
 * allows only one suspension per module at a time.  Pooling lets up to 3 tasks
 * execute concurrently on different tabs.
 *
 * Usage:
 *   const pool = new QuickJSPool();
 *   await pool.init();
 *   const mod = await pool.acquire();
 *   try { ... } finally { pool.release(mod); }
 */
export class QuickJSPool {
  private modules: QuickJSAsyncWASMModule[] = [];
  private available: QuickJSAsyncWASMModule[] = [];
  private waiters: Array<(mod: QuickJSAsyncWASMModule) => void> = [];
  private initialized = false;

  /**
   * Pre-create `size` WASM modules so they are warm when first needed.
   */
  async init(size: number = QUICKJS_MODULE_POOL_SIZE): Promise<void> {
    if (this.initialized) return;

    const promises: Promise<QuickJSAsyncWASMModule>[] = [];
    for (let i = 0; i < size; i++) {
      promises.push(newQuickJSAsyncWASMModule());
    }

    this.modules = await Promise.all(promises);
    this.available = [...this.modules];
    this.initialized = true;
  }

  /**
   * Acquire a module from the pool.  If none are available the call awaits
   * until one is released.
   */
  async acquire(): Promise<QuickJSAsyncWASMModule> {
    if (!this.initialized) {
      throw new Error('QuickJSPool not initialized — call init() first');
    }

    const mod = this.available.pop();
    if (mod) return mod;

    // All modules in use — park a waiter
    return new Promise<QuickJSAsyncWASMModule>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /**
   * Return a module to the pool.  If any callers are waiting for a module
   * the oldest waiter is immediately resolved.
   */
  release(mod: QuickJSAsyncWASMModule): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Hand directly to the next waiter — skip the available queue
      waiter(mod);
    } else {
      this.available.push(mod);
    }
  }

  /** Number of modules currently available (idle). */
  get availableCount(): number {
    return this.available.length;
  }

  /** Total number of modules in the pool. */
  get size(): number {
    return this.modules.length;
  }

  /** Whether init() has been called successfully. */
  get isInitialized(): boolean {
    return this.initialized;
  }
}
