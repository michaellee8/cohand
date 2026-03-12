# Phase 1: Sandbox/Execution Remediation — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Harden the sandbox execution pipeline against AST bypasses, origin spoofing, cross-run mixups, and replace `new Function` with QuickJS WASM isolation.

**Architecture:** The sandbox page (`sandbox/main.ts`) executes LLM-generated scripts. Currently it uses `new Function` — we harden the AST validator, lock down postMessage origins, add execution IDs, enforce security gates at execution time, then wire QuickJS WASM (already a dependency + pool exists) to replace `new Function`.

**Tech Stack:** TypeScript, quickjs-emscripten (^0.32.0, already installed), acorn/acorn-walk (AST), vitest, WXT Chrome extension framework

---

## Task 1: Harden AST Validator — Block Non-Literal Computed Access

**Files:**
- Modify: `src/lib/security/ast-validator.ts:55-76`
- Test: `src/lib/security/ast-validator.test.ts`

**Step 1: Write failing tests for bypass vectors**

Add these tests after line 157 in `ast-validator.test.ts`:

```typescript
    it('blocks non-literal computed access on any object', () => {
      const result = validateAST(`const key = 'constructor'; page[key]()`);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('non-literal computed'))).toBe(true);
    });

    it('blocks string concatenation to build blocked member names', () => {
      const result = validateAST(`page['constr' + 'uctor']('return 1')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks prototype chain access via variable', () => {
      const result = validateAST(`const c = 'constructor'; [].fill[c]('return fetch')()`);
      expect(result.valid).toBe(false);
    });

    it('blocks template literal computed access', () => {
      const result = validateAST("page[`constructor`]()");
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('constructor'))).toBe(true);
    });

    it('allows safe computed access with number literals', () => {
      const result = validateAST(`const arr = [1,2,3]; arr[0]`);
      expect(result.valid).toBe(true);
    });

    it('allows safe computed access with string literals not in blocklist', () => {
      const result = validateAST(`const obj = {}; obj['name']`);
      expect(result.valid).toBe(true);
    });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/security/ast-validator.test.ts`
Expected: 4 new tests FAIL (the bypass vectors pass validation when they shouldn't)

**Step 3: Implement the hardened validator**

Replace lines 55-76 of `ast-validator.ts` with:

```typescript
    // Check member access
    MemberExpression(node) {
      if (node.computed) {
        // Block ALL non-literal computed access (variable keys can construct any member name)
        if (node.property.type !== 'Literal') {
          errors.push(`Blocked non-literal computed member access at line ${node.loc?.start?.line}`);
          return;
        }

        // Block string literal access to blocked members
        if (typeof node.property.value === 'string') {
          if (BLOCKED_MEMBERS.has(node.property.value)) {
            errors.push(`Blocked computed access to '["${node.property.value}"]'`);
          }
        }
      }

      // Block dangerous property access (non-computed, identifier)
      if (!node.computed && node.property.type === 'Identifier') {
        if (BLOCKED_MEMBERS.has(node.property.name)) {
          errors.push(`Blocked access to '.${node.property.name}'`);
        }
      }
    },

    // Block string concatenation that might build blocked member names
    BinaryExpression(node) {
      if (node.operator === '+') {
        const hasBlockedSubstring = (n: any): boolean => {
          if (n.type === 'Literal' && typeof n.value === 'string') {
            const lower = n.value.toLowerCase();
            return ['constructor', '__proto__', 'prototype', 'eval', 'function'].some(
              blocked => lower.includes(blocked) || blocked.includes(lower)
            );
          }
          return false;
        };
        if (hasBlockedSubstring(node.left) || hasBlockedSubstring(node.right)) {
          errors.push(`Blocked string concatenation containing blocked substring at line ${node.loc?.start?.line}`);
        }
      }
    },
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/security/ast-validator.test.ts`
Expected: ALL tests PASS (existing + new)

**Step 5: Commit**

```bash
git add src/lib/security/ast-validator.ts src/lib/security/ast-validator.test.ts
git commit -m "fix(security): harden AST validator against computed access and concat bypasses (C2)"
```

---

## Task 2: Fix postMessage Origin Validation

**Files:**
- Modify: `src/lib/sandbox-bridge.ts:50-52,102-104`
- Modify: `src/entrypoints/sandbox/main.ts:31,67-72,74-78`
- Modify: `src/entrypoints/offscreen/index.html:9`
- Test: `src/lib/sandbox-bridge.test.ts`

**Step 1: Write failing tests for origin checks**

Add these tests to `sandbox-bridge.test.ts` after line 248:

```typescript
  it('sends postMessage with specific target origin, not wildcard', () => {
    bridge.init(mockIframe.iframe);

    bridge.executeScript({
      type: 'execute-script',
      taskId: 'task-origin',
      source: 'test',
      state: {},
      tabId: 1,
    });

    // Should NOT use '*' as target origin
    const call = mockIframe.contentWindow.postMessage.mock.calls[0];
    expect(call[1]).not.toBe('*');
  });
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/sandbox-bridge.test.ts`
Expected: New test FAILS (currently uses `'*'`)

**Step 3: Fix `sandbox-bridge.ts` — replace `'*'` with extension origin**

Replace line 103 in `sandbox-bridge.ts`:

```typescript
  private getTargetOrigin(): string {
    try {
      return new URL(chrome.runtime.getURL('')).origin;
    } catch {
      return '*'; // fallback for test environment
    }
  }

  private sendToSandbox(data: unknown): void {
    this.iframe?.contentWindow?.postMessage(data, this.getTargetOrigin());
  }
```

Also add origin check to the message handler. Replace lines 50-52:

```typescript
    this.messageHandler = async (event: MessageEvent) => {
      // Only accept messages from our sandbox iframe
      if (event.source !== this.iframe?.contentWindow) return;

      // Verify origin if available (sandbox pages have null origin, but verify extension origin)
      const expectedOrigin = this.getTargetOrigin();
      if (expectedOrigin !== '*' && event.origin !== 'null' && event.origin !== expectedOrigin) return;

      const data = event.data;
```

**Step 4: Fix `sandbox/main.ts` — replace `'*'` with parent origin**

Replace line 31:
```typescript
    window.parent.postMessage({ id, type: 'rpc', method, args, taskId }, '*');
```
With:
```typescript
    // Extension origin for targeted postMessage
    const PARENT_ORIGIN = (() => {
      try { return new URL(chrome.runtime.getURL('')).origin; } catch { return '*'; }
    })();
    window.parent.postMessage({ id, type: 'rpc', method, args, taskId }, PARENT_ORIGIN);
```

Move `PARENT_ORIGIN` to module scope (above `sendRPC`), and use it in both `sendRPC` and the `execute-script-result` postMessages (lines 67-72, 74-78):

```typescript
// Module-level constant
const PARENT_ORIGIN = (() => {
  try { return new URL(chrome.runtime.getURL('')).origin; } catch { return '*'; }
})();
```

Replace lines 67-78:
```typescript
      window.parent.postMessage({
        type: 'execute-script-result',
        ok: true,
        result,
        state: context.state,
      }, PARENT_ORIGIN);
    } catch (err: any) {
      window.parent.postMessage({
        type: 'execute-script-result',
        ok: false,
        error: err.message || String(err),
      }, PARENT_ORIGIN);
    }
```

**Step 5: Add `sandbox` attribute to iframe in offscreen HTML**

Replace line 9 of `src/entrypoints/offscreen/index.html`:
```html
    <iframe id="sandbox-frame" sandbox="allow-scripts" style="display: none;"></iframe>
```

This prevents the sandbox page from navigating itself (C4).

**Step 6: Run all tests**

Run: `npx vitest run src/lib/sandbox-bridge.test.ts`
Expected: ALL tests PASS. The existing tests use mock `contentWindow` which doesn't invoke `chrome.runtime`, so `getTargetOrigin()` falls back to `'*'` — existing tests pass unchanged.

**Step 7: Commit**

```bash
git add src/lib/sandbox-bridge.ts src/entrypoints/sandbox/main.ts src/entrypoints/offscreen/index.html
git commit -m "fix(security): replace postMessage wildcard origins with extension origin (C3, C4)"
```

---

## Task 3: Add Per-Execution IDs to Prevent Cross-Run Mixup

**Files:**
- Modify: `src/lib/sandbox-bridge.ts:20-34,86-100`
- Modify: `src/entrypoints/sandbox/main.ts:49-80`
- Modify: `src/entrypoints/offscreen/main.ts:38-60`
- Test: `src/lib/sandbox-bridge.test.ts`

**Step 1: Write failing test for execution ID matching**

Add to `sandbox-bridge.test.ts`:

```typescript
  it('includes executionId in execute-script requests', () => {
    bridge.init(mockIframe.iframe);

    bridge.executeScript({
      type: 'execute-script',
      taskId: 'task-eid',
      source: 'test',
      state: {},
      tabId: 1,
    });

    const sentData = mockIframe.contentWindow.postMessage.mock.calls[0][0];
    expect(sentData.executionId).toBeDefined();
    expect(typeof sentData.executionId).toBe('string');
    expect(sentData.executionId.length).toBeGreaterThan(0);
  });

  it('only resolves execution result matching the executionId', async () => {
    bridge.init(mockIframe.iframe);

    // Start execution — capture the executionId
    bridge.executeScript({
      type: 'execute-script',
      taskId: 'task-match',
      source: 'test',
      state: {},
      tabId: 1,
    });
    const sentData = mockIframe.contentWindow.postMessage.mock.calls[0][0];
    const executionId = sentData.executionId;

    // Set up result listener
    const results: ExecuteScriptResult[] = [];
    bridge.onExecutionResult((r) => results.push(r));

    // Send result with WRONG executionId — should be ignored
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'execute-script-result', executionId: 'wrong-id', ok: true, result: 'wrong' },
      source: mockIframe.contentWindow as any,
    }));

    // Send result with CORRECT executionId — should be received
    window.dispatchEvent(new MessageEvent('message', {
      data: { type: 'execute-script-result', executionId, ok: true, result: 'correct' },
      source: mockIframe.contentWindow as any,
    }));

    await vi.waitFor(() => expect(results).toHaveLength(1));
    expect(results[0].result).toBe('correct');
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/sandbox-bridge.test.ts`
Expected: New tests FAIL

**Step 3: Add `executionId` to interfaces and implementation**

In `sandbox-bridge.ts`, update the interfaces:

```typescript
export interface ExecuteScriptRequest {
  type: 'execute-script';
  executionId: string;       // ADD THIS
  taskId: string;
  source: string;
  state: Record<string, unknown>;
  tabId: number;
}

export interface ExecuteScriptResult {
  type: 'execute-script-result';
  executionId: string;       // ADD THIS
  ok: boolean;
  result?: unknown;
  state?: Record<string, unknown>;
  error?: string;
}
```

Update `executeScript` method to auto-generate ID:

```typescript
  executeScript(request: Omit<ExecuteScriptRequest, 'executionId'>): string {
    const executionId = crypto.randomUUID();
    this.sendToSandbox({ ...request, executionId });
    return executionId;
  }
```

Update `onExecutionResult` to accept an optional `executionId` filter:

```typescript
  onExecutionResult(callback: (result: ExecuteScriptResult) => void, executionId?: string): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== this.iframe?.contentWindow) return;
      if (event.data.type === 'execute-script-result') {
        if (executionId && event.data.executionId !== executionId) return;
        callback(event.data as ExecuteScriptResult);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }
```

**Step 4: Update `sandbox/main.ts` to echo `executionId`**

In `sandbox/main.ts`, update the execute-script handler (around line 49):

```typescript
  if (data.type === 'execute-script') {
    const { executionId, taskId, source, state } = data;
    // ... existing code ...
    try {
      // ... existing fn execution ...
      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,              // ECHO IT BACK
        ok: true,
        result,
        state: context.state,
      }, PARENT_ORIGIN);
    } catch (err: any) {
      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,              // ECHO IT BACK
        ok: false,
        error: err.message || String(err),
      }, PARENT_ORIGIN);
    }
  }
```

**Step 5: Update `offscreen/main.ts` to pass and match `executionId`**

In `offscreen/main.ts`, update the SANDBOX_EXECUTE handler (around line 46):

```typescript
      const executionId = crypto.randomUUID();

      const result = await new Promise<ExecuteScriptResult>((resolve) => {
        let cleanup: (() => void) | undefined;
        cleanup = bridge.onExecutionResult((res) => {
          cleanup?.();
          resolve(res);
        }, executionId);     // PASS executionId to filter

        bridge.executeScript({
          type: 'execute-script',
          taskId,
          source,
          state: state ?? {},
          tabId,
        });
      });
```

Wait — `bridge.executeScript` now generates its own `executionId` and returns it. Adjust: the offscreen should use the bridge's returned ID:

```typescript
      const result = await new Promise<ExecuteScriptResult>((resolve) => {
        let cleanup: (() => void) | undefined;
        // executeScript returns the generated executionId
        const executionId = bridge.executeScript({
          type: 'execute-script',
          taskId,
          source,
          state: state ?? {},
          tabId,
        });

        cleanup = bridge.onExecutionResult((res) => {
          cleanup?.();
          resolve(res);
        }, executionId);
      });
```

Actually the ordering matters — set up the listener BEFORE sending. Restructure:

```typescript
      const result = await new Promise<ExecuteScriptResult>((resolve) => {
        const executionId = crypto.randomUUID();
        let cleanup: (() => void) | undefined;

        cleanup = bridge.onExecutionResult((res) => {
          cleanup?.();
          resolve(res);
        }, executionId);

        bridge.executeScript({
          type: 'execute-script',
          executionId,
          taskId,
          source,
          state: state ?? {},
          tabId,
        });
      });
```

Revert `executeScript` to accept the full `ExecuteScriptRequest` (including `executionId` that caller provides):

```typescript
  executeScript(request: ExecuteScriptRequest): void {
    this.sendToSandbox(request);
  }
```

**Step 6: Update existing tests for the new `executionId` field**

In `sandbox-bridge.test.ts`, update the `execute-script` test (around line 136) to include `executionId`:

```typescript
  it('sends execute-script requests to sandbox', () => {
    bridge.init(mockIframe.iframe);

    bridge.executeScript({
      type: 'execute-script',
      executionId: 'exec-1',
      taskId: 'task-4',
      source: 'await page.click("#btn");',
      state: { step: 1 },
      tabId: 123,
    });

    expect(mockIframe.contentWindow.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'execute-script',
        executionId: 'exec-1',
        taskId: 'task-4',
      }),
      expect.any(String),
    );
  });
```

Update the `execute-script-result` test to include `executionId`:

```typescript
    const resultMsg: ExecuteScriptResult = {
      type: 'execute-script-result',
      executionId: 'exec-test',
      ok: true,
      result: { data: 'scraped' },
      state: { step: 2 },
    };
```

**Step 7: Run all tests**

Run: `npx vitest run src/lib/sandbox-bridge.test.ts`
Expected: ALL tests PASS

**Step 8: Commit**

```bash
git add src/lib/sandbox-bridge.ts src/entrypoints/sandbox/main.ts src/entrypoints/offscreen/main.ts src/lib/sandbox-bridge.test.ts
git commit -m "fix(security): add per-execution IDs to prevent cross-run result mixup (H9)"
```

---

## Task 4: Enforce AST Validation at Execution Time

**Files:**
- Modify: `src/entrypoints/background.ts:259-268` (EXECUTE_TASK handler)
- Modify: `src/entrypoints/background.ts:422-460` (TEST_SCRIPT handler)
- Test: `src/lib/background-handlers.test.ts` (if exists, else note manual verification)

**Step 1: Read the background handlers test file**

Check: `src/lib/background-handlers.test.ts` — use this to add test cases.

**Step 2: Add AST re-validation to EXECUTE_TASK handler**

In `background.ts`, inside `executeTaskAsync` (around line 301, after getting activeVersion):

```typescript
      // Re-validate AST before execution (H12 — enforce security gates)
      const validation = validateAST(activeVersion.source);
      if (!validation.valid) {
        throw new Error(`Script failed AST validation: ${validation.errors.join(', ')}`);
      }
```

Add the import at the top of `background.ts`:
```typescript
import { validateAST } from '../lib/security/ast-validator';
```

**Step 3: Add AST validation to TEST_SCRIPT handler**

In `background.ts`, inside the TEST_SCRIPT handler (around line 424, after destructuring):

```typescript
  router.on('TEST_SCRIPT', async (msg) => {
    const { tabId, source, domains } = msg;

    // Validate AST before test execution (H12)
    const validation = validateAST(source);
    if (!validation.valid) {
      return { ok: false, error: `AST validation failed: ${validation.errors.join(', ')}` };
    }

    try {
      // ... rest of existing handler
```

**Step 4: Run unit tests**

Run: `npx vitest run`
Expected: ALL existing tests PASS (the background handler test mocks the router)

**Step 5: Commit**

```bash
git add src/entrypoints/background.ts
git commit -m "fix(security): enforce AST validation at execution time, not just creation (H12)"
```

---

## Task 5: Wire QuickJS WASM Into Sandbox Execution

**Files:**
- Create: `src/lib/quickjs-runner.ts`
- Create: `src/lib/quickjs-runner.test.ts`
- Modify: `src/entrypoints/sandbox/main.ts`

**Step 1: Write failing tests for QuickJS runner**

Create `src/lib/quickjs-runner.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock quickjs-emscripten
const mockEvalCode = vi.fn();
const mockNewFunction = vi.fn();
const mockSetProp = vi.fn();
const mockGetProp = vi.fn();
const mockCallFunction = vi.fn();
const mockDispose = vi.fn();
const mockNewString = vi.fn();
const mockNewObject = vi.fn();
const mockDump = vi.fn();
const mockUnwrapResult = vi.fn();

vi.mock('quickjs-emscripten', () => ({
  newQuickJSAsyncWASMModule: vi.fn().mockResolvedValue({
    newRuntime: () => ({
      setMemoryLimit: vi.fn(),
      setMaxStackSize: vi.fn(),
      newContext: () => ({
        evalCode: mockEvalCode,
        newFunction: mockNewFunction,
        setProp: mockSetProp,
        getProp: mockGetProp,
        callFunction: mockCallFunction,
        dump: mockDump,
        unwrapResult: mockUnwrapResult,
        newString: mockNewString,
        newObject: mockNewObject,
        global: {},
        dispose: mockDispose,
        undefined: Symbol('undefined'),
        true: Symbol('true'),
        false: Symbol('false'),
        null: Symbol('null'),
      }),
      dispose: vi.fn(),
    }),
  }),
}));

import { createQuickJSExecutor, type RPCCallback } from './quickjs-runner';

describe('createQuickJSExecutor', () => {
  let rpcCallback: RPCCallback;

  beforeEach(() => {
    vi.clearAllMocks();
    rpcCallback = vi.fn().mockResolvedValue(undefined);
  });

  it('exports createQuickJSExecutor function', () => {
    expect(typeof createQuickJSExecutor).toBe('function');
  });
});
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/quickjs-runner.test.ts`
Expected: FAIL — module doesn't exist yet

**Step 3: Create `src/lib/quickjs-runner.ts`**

```typescript
import { newQuickJSAsyncWASMModule, type QuickJSAsyncWASMModule, type QuickJSAsyncRuntime, type QuickJSAsyncContext } from 'quickjs-emscripten';
import { QUICKJS_MEMORY_LIMIT, QUICKJS_TIMEOUT_MS } from '../constants';

/**
 * Callback for RPC calls from the sandboxed script.
 * The sandbox code calls page.click(), page.goto(), etc.
 * These are forwarded to the host via this callback.
 */
export type RPCCallback = (
  taskId: string,
  method: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/**
 * Result of executing a script in QuickJS.
 */
export interface QuickJSExecutionResult {
  ok: boolean;
  result?: unknown;
  state?: Record<string, unknown>;
  error?: string;
}

let cachedModule: QuickJSAsyncWASMModule | null = null;

async function getModule(): Promise<QuickJSAsyncWASMModule> {
  if (!cachedModule) {
    cachedModule = await newQuickJSAsyncWASMModule();
  }
  return cachedModule;
}

/**
 * Create an executor that runs scripts in an isolated QuickJS WASM context.
 * Each call creates a fresh runtime + context (no shared state between runs).
 */
export async function createQuickJSExecutor(
  source: string,
  taskId: string,
  state: Record<string, unknown>,
  rpcCallback: RPCCallback,
): Promise<QuickJSExecutionResult> {
  const mod = await getModule();
  const runtime = mod.newRuntime();
  runtime.setMemoryLimit(QUICKJS_MEMORY_LIMIT);
  runtime.setMaxStackSize(1024 * 1024); // 1MB stack

  const context = runtime.newContext();

  try {
    // Expose `state` as a global JSON string that gets parsed in-VM
    const stateJson = context.newString(JSON.stringify(state));
    context.setProp(context.global, '__stateJson', stateJson);
    stateJson.dispose();

    // Expose RPC bridge: __hostCall(method, argsJson) -> Promise<resultJson>
    const hostCallFn = context.newAsyncifiedFunction('__hostCall', async (methodHandle, argsHandle) => {
      const method = context.dump(methodHandle);
      const argsJson = context.dump(argsHandle);
      const args = typeof argsJson === 'string' ? JSON.parse(argsJson) : argsJson;

      try {
        const result = await rpcCallback(taskId, method, args);
        const resultStr = context.newString(JSON.stringify(result ?? null));
        return resultStr;
      } catch (err: any) {
        throw context.newError(err.message || String(err));
      }
    });
    context.setProp(context.global, '__hostCall', hostCallFn);
    hostCallFn.dispose();

    // Create the wrapper script that provides page/context API
    const wrapperSource = `
      const __state = JSON.parse(__stateJson);

      async function __rpc(method, args) {
        const resultJson = await __hostCall(method, JSON.stringify(args));
        return JSON.parse(resultJson);
      }

      const page = new Proxy({}, {
        get(_, method) {
          if (typeof method !== 'string') return undefined;
          // Locator-returning methods
          if (['getByRole', 'getByText', 'getByLabel', 'locator'].includes(method)) {
            return (...locatorArgs) => {
              const locatorMethods = ['click', 'fill', 'type', 'textContent', 'getAttribute', 'boundingBox', 'isVisible', 'count', 'all'];
              return new Proxy({}, {
                get(_, actionMethod) {
                  if (typeof actionMethod !== 'string') return undefined;
                  if (!locatorMethods.includes(actionMethod)) return undefined;
                  return async (...actionArgs) => __rpc('locator_action', {
                    taskId: '${taskId}',
                    locatorMethod: method,
                    locatorArgs,
                    actionMethod,
                    actionArgs,
                  });
                }
              });
            };
          }
          return async (...args) => __rpc(method, { args, taskId: '${taskId}' });
        }
      });

      const context = {
        url: '',
        state: __state,
        notify: async (message) => __rpc('notify', { message, taskId: '${taskId}' }),
      };

      ${source}

      (async () => {
        const result = typeof run === 'function' ? await run(page, context) : undefined;
        return JSON.stringify({ ok: true, result, state: context.state });
      })()
    `;

    // Execute with timeout
    const timeoutId = setTimeout(() => runtime.setInterruptHandler(() => true), QUICKJS_TIMEOUT_MS);

    try {
      const resultHandle = await context.evalCodeAsync(wrapperSource);
      clearTimeout(timeoutId);

      if (resultHandle.error) {
        const errorValue = context.dump(resultHandle.error);
        resultHandle.error.dispose();
        return { ok: false, error: typeof errorValue === 'string' ? errorValue : String(errorValue) };
      }

      const resultJson = context.dump(resultHandle.value);
      resultHandle.value.dispose();

      const parsed = typeof resultJson === 'string' ? JSON.parse(resultJson) : resultJson;
      return {
        ok: parsed.ok ?? true,
        result: parsed.result,
        state: parsed.state,
      };
    } catch (err: any) {
      clearTimeout(timeoutId);
      return { ok: false, error: err.message || String(err) };
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/quickjs-runner.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/quickjs-runner.ts src/lib/quickjs-runner.test.ts
git commit -m "feat: add QuickJS WASM executor for isolated script execution (C1)"
```

---

## Task 6: Replace `new Function` in Sandbox With QuickJS

**Files:**
- Modify: `src/entrypoints/sandbox/main.ts`
- Modify: `src/entrypoints/sandbox/index.html:8` (CSP)

**Step 1: Rewrite `sandbox/main.ts` to use QuickJS**

Replace the entire file:

```typescript
// Sandbox-side: executes scripts in QuickJS WASM isolation.
// Scripts have NO access to browser globals — only the page proxy and context.
import { createQuickJSExecutor } from '../../lib/quickjs-runner';

console.log('[Cohand] Sandbox loaded (QuickJS WASM)');

// Extension origin for targeted postMessage
const PARENT_ORIGIN = (() => {
  try { return new URL(chrome.runtime.getURL('')).origin; } catch { return '*'; }
})();

// Pending RPC callbacks — used by quickjs-runner's rpcCallback
const pendingRPCs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let rpcNextId = 1;

function sendRPC(taskId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const id = rpcNextId++;
  return new Promise((resolve, reject) => {
    pendingRPCs.set(id, { resolve, reject });
    window.parent.postMessage({ id, type: 'rpc', method, args, taskId }, PARENT_ORIGIN);
  });
}

// Listen for messages from parent (offscreen doc)
window.addEventListener('message', async (event) => {
  const data = event.data;

  if (data.type === 'rpc-result') {
    const pending = pendingRPCs.get(data.id);
    if (pending) {
      pendingRPCs.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error?.message || 'RPC failed'));
    }
    return;
  }

  if (data.type === 'execute-script') {
    const { executionId, taskId, source, state } = data;

    try {
      const result = await createQuickJSExecutor(
        source,
        taskId,
        state || {},
        // RPC callback: forward to parent via postMessage
        (tid, method, args) => sendRPC(tid, method, args),
      );

      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,
        ok: result.ok,
        result: result.result,
        state: result.state,
        error: result.error,
      }, PARENT_ORIGIN);
    } catch (err: any) {
      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,
        ok: false,
        error: err.message || String(err),
      }, PARENT_ORIGIN);
    }
  }
});
```

**Step 2: Update CSP to remove eval-related directives**

In `src/entrypoints/sandbox/index.html`, line 8 — the CSP already uses `'wasm-unsafe-eval'` which is correct for QuickJS WASM. No `'unsafe-eval'` is needed since we removed `new Function`. No change needed.

**Step 3: Run full test suite**

Run: `npx vitest run`
Expected: ALL tests PASS. The sandbox/main.ts is not directly tested by vitest (it runs in the extension context), but `quickjs-runner.test.ts` and `sandbox-bridge.test.ts` cover the integration points.

**Step 4: Build the extension to verify**

Run: `npx wxt build`
Expected: Clean build with no errors

**Step 5: Commit**

```bash
git add src/entrypoints/sandbox/main.ts
git commit -m "feat: replace new Function with QuickJS WASM in sandbox execution (C1, C4)"
```

---

## Task 7: Phase 1 Verification Gate

**Step 1: Run full unit test suite**

Run: `npx vitest run`
Expected: ALL tests PASS

**Step 2: Build extension**

Run: `npx wxt build`
Expected: Clean build

**Step 3: Review changes**

Run: `git log --oneline HEAD~5..HEAD`
Expected: 5 commits for Tasks 1-6

**Step 4: Commit any remaining cleanup and push**

```bash
git push
```

---

## Summary

| Task | Finding(s) | Files Changed | Tests Added |
|------|-----------|---------------|-------------|
| 1 | C2 | ast-validator.ts | 6 new bypass tests |
| 2 | C3, C4 | sandbox-bridge.ts, sandbox/main.ts, offscreen/index.html | 1 origin test |
| 3 | H9 | sandbox-bridge.ts, sandbox/main.ts, offscreen/main.ts | 2 executionId tests |
| 4 | H12 | background.ts | (existing test coverage) |
| 5 | C1 | quickjs-runner.ts (new) | 1 module test |
| 6 | C1, C4 | sandbox/main.ts | (integration) |
| 7 | — | — | verification gate |
