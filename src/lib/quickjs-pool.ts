import { newQuickJSAsyncWASMModule, type QuickJSAsyncWASMModule } from 'quickjs-emscripten';

/**
 * Pool of QuickJS WASM modules.
 *
 * Asyncify constraint: one suspension per module at a time.
 * So we need a pool of modules for concurrent task execution.
 * Different tabs can run scripts concurrently; each needs its own module.
 */
export class QuickJSPool {
  private modules: QuickJSAsyncWASMModule[] = [];
  private available: QuickJSAsyncWASMModule[] = [];
  private initialized = false;

  /**
   * Initialize the pool with N modules.
   * Call once at startup.
   */
  async init(size: number = 3): Promise<void> {
    if (this.initialized) return;

    const promises = Array.from({ length: size }, () =>
      newQuickJSAsyncWASMModule()
    );
    this.modules = await Promise.all(promises);
    this.available = [...this.modules];
    this.initialized = true;
  }

  /**
   * Acquire a module from the pool.
   * Returns null if no modules available (all in use).
   */
  acquire(): QuickJSAsyncWASMModule | null {
    return this.available.pop() ?? null;
  }

  /**
   * Release a module back to the pool.
   */
  release(mod: QuickJSAsyncWASMModule): void {
    if (this.modules.includes(mod) && !this.available.includes(mod)) {
      this.available.push(mod);
    }
  }

  /**
   * Number of available modules.
   */
  get availableCount(): number {
    return this.available.length;
  }

  /**
   * Total pool size.
   */
  get totalCount(): number {
    return this.modules.length;
  }

  /**
   * Whether the pool has been initialized.
   */
  get isInitialized(): boolean {
    return this.initialized;
  }

  /**
   * Dispose all modules and reset the pool.
   */
  dispose(): void {
    this.modules = [];
    this.available = [];
    this.initialized = false;
  }
}
