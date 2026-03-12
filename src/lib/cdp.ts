// src/lib/cdp.ts

interface TabState {
  refCount: number;
  epoch: number;
  lastMouseX: number;
  lastMouseY: number;
}

export class CDPManager {
  private tabs = new Map<number, TabState>();

  /**
   * Attach debugger to a tab. Reference counted — multiple callers can attach,
   * actual detach only happens when refCount reaches 0.
   */
  async attach(tabId: number): Promise<void> {
    const existing = this.tabs.get(tabId);
    if (existing) {
      existing.refCount++;
      return;
    }

    await chrome.debugger.attach({ tabId }, '1.3');
    this.tabs.set(tabId, {
      refCount: 1,
      epoch: 0,
      lastMouseX: 0,
      lastMouseY: 0,
    });

    try {
      // Enable required CDP domains
      await this.send(tabId, 'DOM.enable');
      await this.send(tabId, 'Page.enable');
      await this.send(tabId, 'Input.enable');
    } catch (err) {
      // Partial enable failure — clean up
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Already detached
      }
      this.tabs.delete(tabId);
      throw err;
    }
  }

  /**
   * Decrement ref count. Actually detach when it reaches 0.
   */
  async detach(tabId: number): Promise<void> {
    const state = this.tabs.get(tabId);
    if (!state) return;

    state.refCount--;
    if (state.refCount <= 0) {
      try {
        await chrome.debugger.detach({ tabId });
      } catch {
        // Tab may have been closed
      }
      this.tabs.delete(tabId);
    }
  }

  /**
   * Send a CDP command to a tab.
   * Checks epoch before sending to detect stale navigations.
   */
  async send(tabId: number, method: string, params?: Record<string, unknown>): Promise<unknown> {
    const state = this.tabs.get(tabId);
    if (!state) throw new Error(`Tab ${tabId} not attached`);

    const epochBefore = state.epoch;
    const result = await chrome.debugger.sendCommand({ tabId }, method, params);

    // Check epoch after — navigation may have happened during command
    if (state.epoch !== epochBefore) {
      throw new CDPNavigationError(`Navigation detected during ${method}`);
    }

    return result;
  }

  /**
   * Get the current epoch for a tab.
   */
  getEpoch(tabId: number): number {
    return this.tabs.get(tabId)?.epoch ?? -1;
  }

  /**
   * Increment the epoch (called on navigation/detach events).
   */
  incrementEpoch(tabId: number): void {
    const state = this.tabs.get(tabId);
    if (state) state.epoch++;
  }

  /**
   * Check if epoch is still valid.
   */
  isEpochValid(tabId: number, expectedEpoch: number): boolean {
    const state = this.tabs.get(tabId);
    return state !== undefined && state.epoch === expectedEpoch;
  }

  /**
   * Get last known mouse position for a tab.
   */
  getMousePosition(tabId: number): { x: number; y: number } {
    const state = this.tabs.get(tabId);
    return { x: state?.lastMouseX ?? 0, y: state?.lastMouseY ?? 0 };
  }

  /**
   * Set last known mouse position for a tab.
   */
  setMousePosition(tabId: number, x: number, y: number): void {
    const state = this.tabs.get(tabId);
    if (state) {
      state.lastMouseX = x;
      state.lastMouseY = y;
    }
  }

  /**
   * Check if a tab is currently attached.
   */
  isAttached(tabId: number): boolean {
    return this.tabs.has(tabId);
  }

  /**
   * Force cleanup of a tab (e.g., tab closed).
   */
  cleanup(tabId: number): void {
    this.tabs.delete(tabId);
  }

  /**
   * Set up event listeners for navigation detection.
   * Call this once during service worker initialization.
   */
  setupListeners(): void {
    // Tab closed or debugger detached externally
    chrome.debugger.onDetach.addListener((source, reason) => {
      if (source.tabId) {
        this.incrementEpoch(source.tabId);
        this.cleanup(source.tabId);
      }
    });

    // CDP events for navigation detection
    chrome.debugger.onEvent.addListener((source, method, params: any) => {
      if (!source.tabId) return;

      if (
        method === 'Page.frameNavigated' &&
        params?.frame?.parentId === undefined
      ) {
        // Top-level navigation
        this.incrementEpoch(source.tabId);
      }

      if (method === 'Inspector.detached') {
        this.incrementEpoch(source.tabId);
        this.cleanup(source.tabId);
      }
    });
  }
}

export class CDPNavigationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CDPNavigationError';
  }
}
