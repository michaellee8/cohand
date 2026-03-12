import {
  newQuickJSAsyncWASMModule,
  type QuickJSAsyncWASMModule,
  type QuickJSAsyncRuntime,
  type QuickJSAsyncContext,
  type QuickJSHandle,
} from 'quickjs-emscripten';
import { QUICKJS_MEMORY_LIMIT } from '../constants';

/**
 * Callback that bridges from QuickJS to the host environment.
 * Used to forward page actions (click, fill, goto, etc.) to the real browser via CDP.
 */
export type RPCCallback = (
  taskId: string,
  method: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Result of executing a script inside QuickJS.
 */
export interface QuickJSExecutionResult {
  ok: boolean;
  result?: unknown;
  state?: Record<string, unknown>;
  error?: string;
}

/**
 * The wrapper script that runs INSIDE QuickJS.
 * It creates page/context objects from the injected __hostCall and __stateJson globals,
 * then calls the user's run(page, context) function.
 *
 * This script has NO access to browser globals — only what we explicitly inject.
 */
function buildWrapperScript(source: string, taskId: string): string {
  return `
(async function() {
  // Parse the injected state
  var state = JSON.parse(__stateJson);

  // Simple page methods that forward to host via __hostCall
  var simpleMethods = [
    'goto', 'click', 'fill', 'type', 'scroll',
    'waitForSelector', 'waitForLoadState',
    'url', 'title'
  ];

  // Locator methods
  var locatorMethods = [
    'click', 'fill', 'type', 'textContent',
    'getAttribute', 'boundingBox', 'isVisible', 'count', 'all'
  ];

  function createLocator(locatorMethod, locatorArgs) {
    var loc = {};
    for (var i = 0; i < locatorMethods.length; i++) {
      (function(method) {
        loc[method] = function() {
          var actionArgs = [];
          for (var j = 0; j < arguments.length; j++) actionArgs.push(arguments[j]);
          return __hostCall(JSON.stringify({
            type: 'locator_action',
            taskId: ${JSON.stringify(taskId)},
            locatorMethod: locatorMethod,
            locatorArgs: locatorArgs,
            actionMethod: method,
            actionArgs: actionArgs
          }));
        };
      })(locatorMethods[i]);
    }
    return loc;
  }

  var page = {};
  for (var i = 0; i < simpleMethods.length; i++) {
    (function(method) {
      page[method] = function() {
        var args = [];
        for (var j = 0; j < arguments.length; j++) args.push(arguments[j]);
        return __hostCall(JSON.stringify({
          type: 'page_action',
          taskId: ${JSON.stringify(taskId)},
          method: method,
          args: args
        }));
      };
    })(simpleMethods[i]);
  }

  // Locator-returning methods
  var locatorReturning = ['getByRole', 'getByText', 'getByLabel'];
  for (var i = 0; i < locatorReturning.length; i++) {
    (function(method) {
      page[method] = function() {
        var args = [];
        for (var j = 0; j < arguments.length; j++) args.push(arguments[j]);
        return createLocator(method, args);
      };
    })(locatorReturning[i]);
  }

  page.locator = function(selector) {
    return createLocator('locator', [selector]);
  };

  var context = {
    url: '',
    state: state,
    notify: function(message) {
      return __hostCall(JSON.stringify({
        type: 'notify',
        taskId: ${JSON.stringify(taskId)},
        message: message
      }));
    }
  };

  // User script defines run(page, context)
  ${source}

  var result = undefined;
  if (typeof run === 'function') {
    result = run(page, context);
  }

  // Return JSON-encoded result and state
  return JSON.stringify({
    result: result,
    state: context.state
  });
})()
`;
}

/**
 * Convert a host value to a QuickJS handle.
 */
function hostValueToHandle(ctx: QuickJSAsyncContext, value: unknown): QuickJSHandle {
  if (value === undefined || value === null) {
    return ctx.undefined;
  }
  if (typeof value === 'string') {
    return ctx.newString(value);
  }
  if (typeof value === 'number') {
    return ctx.newNumber(value);
  }
  if (typeof value === 'boolean') {
    return value ? ctx.true : ctx.false;
  }
  // For objects/arrays, serialize to JSON and parse inside QuickJS
  return ctx.newString(JSON.stringify(value));
}

/**
 * Execute a user script inside a QuickJS WASM sandbox.
 *
 * The script is expected to define an async function `run(page, context)`.
 * Page methods are proxied through __hostCall back to the host environment.
 *
 * @param source - The user script source code
 * @param taskId - Task ID for routing RPC calls
 * @param state - Initial state object passed to the script
 * @param rpcCallback - Host function for forwarding page actions
 * @returns Execution result with ok/error status
 */
export async function createQuickJSExecutor(
  source: string,
  taskId: string,
  state: Record<string, unknown>,
  rpcCallback: RPCCallback,
): Promise<QuickJSExecutionResult> {
  let wasmModule: QuickJSAsyncWASMModule | undefined;
  let runtime: QuickJSAsyncRuntime | undefined;
  let ctx: QuickJSAsyncContext | undefined;

  try {
    // Create a fresh WASM module (in production, use the pool)
    wasmModule = await newQuickJSAsyncWASMModule();

    // Create runtime with memory limits
    runtime = wasmModule.newRuntime();
    runtime.setMemoryLimit(QUICKJS_MEMORY_LIMIT);
    runtime.setMaxStackSize(1024 * 1024); // 1MB stack

    // Create async context
    ctx = runtime.newContext();

    // Inject __stateJson as a global string
    const stateJsonHandle = ctx.newString(JSON.stringify(state));
    ctx.setProp(ctx.global, '__stateJson', stateJsonHandle);
    stateJsonHandle.dispose();

    // Inject __hostCall as an async global function
    const hostCallHandle = ctx.newAsyncifiedFunction('__hostCall', async function (argHandle: QuickJSHandle) {
      const argStr = ctx!.dump(argHandle);
      const parsed = JSON.parse(argStr);

      let result: unknown;
      if (parsed.type === 'page_action') {
        result = await rpcCallback(taskId, parsed.method, {
          args: parsed.args,
          taskId: parsed.taskId,
        });
      } else if (parsed.type === 'locator_action') {
        result = await rpcCallback(taskId, 'locator_action', {
          taskId: parsed.taskId,
          locatorMethod: parsed.locatorMethod,
          locatorArgs: parsed.locatorArgs,
          actionMethod: parsed.actionMethod,
          actionArgs: parsed.actionArgs,
        });
      } else if (parsed.type === 'notify') {
        result = await rpcCallback(taskId, 'notify', {
          message: parsed.message,
          taskId: parsed.taskId,
        });
      }

      return hostValueToHandle(ctx!, result);
    });
    ctx.setProp(ctx.global, '__hostCall', hostCallHandle);
    hostCallHandle.dispose();

    // Build and execute the wrapped script
    const wrappedScript = buildWrapperScript(source, taskId);
    const evalResult = await ctx.evalCodeAsync(wrappedScript, 'sandbox.js');

    if ('error' in evalResult && evalResult.error) {
      const errorVal = ctx.dump(evalResult.error);
      evalResult.error.dispose();
      return {
        ok: false,
        error: typeof errorVal === 'object' && errorVal?.message
          ? errorVal.message
          : String(errorVal),
      };
    }

    // Success path
    const resultHandle = evalResult.value;
    const rawResult = ctx.dump(resultHandle);
    resultHandle.dispose();

    // Parse the JSON result from the wrapper
    if (typeof rawResult === 'string') {
      try {
        const parsed = JSON.parse(rawResult);
        return {
          ok: true,
          result: parsed.result,
          state: parsed.state,
        };
      } catch {
        return {
          ok: true,
          result: rawResult,
          state,
        };
      }
    }

    return {
      ok: true,
      result: rawResult,
      state,
    };
  } catch (err: any) {
    return {
      ok: false,
      error: err.message || String(err),
    };
  } finally {
    // Dispose in reverse order: context -> runtime
    // The WASM module is not disposed (it's reusable)
    if (ctx && ctx.alive) {
      ctx.dispose();
    }
    if (runtime && runtime.alive) {
      runtime.dispose();
    }
  }
}
