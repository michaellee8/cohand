import { QUICKJS_TIMEOUT_MS } from '../constants';

/**
 * Host function that scripts can call.
 * Maps to RPC calls via postMessage -> offscreen -> service worker -> CDP.
 */
export type HostCallFn = (method: string, args: Record<string, unknown>) => Promise<unknown>;

export interface ExecutionResult {
  ok: true;
  result: unknown;
  state: Record<string, unknown>;
  durationMs: number;
}

export interface ExecutionError {
  ok: false;
  error: string;
  durationMs: number;
}

export type ExecutionOutcome = ExecutionResult | ExecutionError;

/**
 * Execute a script with the given host function bridge.
 *
 * In the real sandbox, this uses QuickJS WASM.
 * For now, it uses a controlled `new Function` wrapper in the sandbox context.
 * The sandbox iframe's CSP and lack of chrome.* APIs provide the isolation.
 *
 * QuickJS integration happens when we wire the actual sandbox.ts.
 */
export async function executeScript(
  source: string,
  taskId: string,
  hostCallFn: HostCallFn,
  initialState: Record<string, unknown>,
  contextUrl?: string,
): Promise<ExecutionOutcome> {
  const startTime = Date.now();
  const state = { ...initialState };

  // Create page proxy
  const page = createPageProxy(taskId, hostCallFn);

  // Create context object
  const context = {
    url: contextUrl || '',
    state,
    notify: async (message: string) => {
      await hostCallFn('notify', { message, taskId });
    },
  };

  // Set up timeout
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Script execution timeout')), QUICKJS_TIMEOUT_MS);
  });

  try {
    // Wrap source to extract run function and call it.
    // Use `return` so the async IIFE yields the run() result.
    const wrappedSource = `
      ${source}
      ;return (typeof run === 'function' ? run(page, context) : undefined)
    `;

    // Execute with timeout
    const fn = new Function('page', 'context', `return (async () => { ${wrappedSource} })()`);
    const executionPromise = fn(page, context);
    const result = await Promise.race([
      executionPromise,
      timeoutPromise,
    ]);

    return {
      ok: true,
      result,
      state: context.state,
      durationMs: Date.now() - startTime,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err.message || String(err),
      durationMs: Date.now() - startTime,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create a proxy page object whose methods call the host function.
 */
function createPageProxy(taskId: string, hostCallFn: HostCallFn): Record<string, Function> {
  const simpleMethods = [
    'goto', 'click', 'fill', 'type', 'scroll',
    'waitForSelector', 'waitForLoadState',
    'url', 'title',
  ];

  const page: Record<string, Function> = {};

  for (const method of simpleMethods) {
    page[method] = async (...args: unknown[]) => {
      return hostCallFn(method, { args, taskId });
    };
  }

  // getByRole, getByText, getByLabel return locator-like objects
  for (const method of ['getByRole', 'getByText', 'getByLabel']) {
    page[method] = (...args: unknown[]) => {
      return createLocatorProxy(taskId, hostCallFn, method, args);
    };
  }

  // locator(selector) returns a locator-like object
  page.locator = (selector: string) => {
    return createLocatorProxy(taskId, hostCallFn, 'locator', [selector]);
  };

  return page;
}

/**
 * Create a locator proxy whose methods call the host function with the locator context.
 */
function createLocatorProxy(
  taskId: string,
  hostCallFn: HostCallFn,
  locatorMethod: string,
  locatorArgs: unknown[],
): Record<string, Function> {
  const locatorMethods = [
    'click', 'fill', 'type', 'textContent',
    'getAttribute', 'boundingBox', 'isVisible', 'count', 'all',
  ];

  const locator: Record<string, Function> = {};

  for (const method of locatorMethods) {
    locator[method] = async (...args: unknown[]) => {
      return hostCallFn('locator_action', {
        taskId,
        locatorMethod,
        locatorArgs,
        actionMethod: method,
        actionArgs: args,
      });
    };
  }

  return locator;
}
