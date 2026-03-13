// src/lib/quickjs-runner.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Build a comprehensive mock of quickjs-emscripten for the runner
// Since WASM isn't available in vitest, we mock the entire module.

let mockEvalCodeAsyncResult: { value?: any; error?: any } = { value: { dispose: vi.fn() } };
let mockDumpReturn: any = JSON.stringify({ result: { hello: 'world' }, state: {} });

const mockDispose = vi.fn();

function createMockHandle(value?: any) {
  return { dispose: vi.fn(), _value: value };
}

const mockContext = {
  alive: true,
  global: createMockHandle('global'),
  undefined: createMockHandle('undefined'),
  true: createMockHandle('true'),
  false: createMockHandle('false'),
  null: createMockHandle('null'),
  newString: vi.fn((str: string) => createMockHandle(str)),
  newNumber: vi.fn((n: number) => createMockHandle(n)),
  newObject: vi.fn(() => createMockHandle({})),
  newFunction: vi.fn((_name: string, _fn: Function) => createMockHandle('function')),
  newAsyncifiedFunction: vi.fn((_name: string, _fn: Function) => createMockHandle('asyncFunction')),
  setProp: vi.fn(),
  getProp: vi.fn(() => createMockHandle()),
  dump: vi.fn(() => mockDumpReturn),
  evalCode: vi.fn(() => mockEvalCodeAsyncResult),
  evalCodeAsync: vi.fn(async () => mockEvalCodeAsyncResult),
  dispose: vi.fn(() => { mockContext.alive = false; }),
};

const mockRuntime = {
  alive: true,
  newContext: vi.fn(() => {
    mockContext.alive = true;
    return mockContext;
  }),
  setMemoryLimit: vi.fn(),
  setMaxStackSize: vi.fn(),
  dispose: vi.fn(() => { mockRuntime.alive = false; }),
};

const mockModule = {
  newRuntime: vi.fn(() => {
    mockRuntime.alive = true;
    return mockRuntime;
  }),
};

vi.mock('quickjs-emscripten', () => ({
  newQuickJSAsyncWASMModule: vi.fn(() => Promise.resolve(mockModule)),
}));

import {
  createQuickJSExecutor,
  escapeSourceForTemplate,
  type RPCCallback,
  type QuickJSExecutionResult,
} from './quickjs-runner';

describe('quickjs-runner', () => {
  const mockRpcCallback: RPCCallback = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock state
    mockContext.alive = true;
    mockRuntime.alive = true;

    // Default: successful eval returning JSON
    mockDumpReturn = JSON.stringify({ result: { hello: 'world' }, state: {} });
    mockEvalCodeAsyncResult = {
      value: createMockHandle('resultHandle'),
    };
  });

  it('exports createQuickJSExecutor as a function', () => {
    expect(typeof createQuickJSExecutor).toBe('function');
  });

  it('exports RPCCallback type (compile-time check)', () => {
    // Type check - if this compiles, the type is exported correctly
    const cb: RPCCallback = async (_taskId, _method, _args) => undefined;
    expect(typeof cb).toBe('function');
  });

  it('exports QuickJSExecutionResult type (compile-time check)', () => {
    // Type check
    const result: QuickJSExecutionResult = { ok: true, result: 'test', state: {} };
    expect(result.ok).toBe(true);
  });

  it('returns a successful result for a simple script', async () => {
    const result = await createQuickJSExecutor(
      'async function run(page, context) { return { hello: "world" }; }',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toEqual({ hello: 'world' });
    expect(result.state).toEqual({});
  });

  it('creates a WASM module, runtime, and context', async () => {
    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    // Verify the chain: module -> runtime -> context
    expect(mockModule.newRuntime).toHaveBeenCalled();
    expect(mockRuntime.newContext).toHaveBeenCalled();
    expect(mockRuntime.setMemoryLimit).toHaveBeenCalled();
    expect(mockRuntime.setMaxStackSize).toHaveBeenCalled();
  });

  it('sets memory limit from constants', async () => {
    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    // QUICKJS_MEMORY_LIMIT = 32 * 1024 * 1024
    expect(mockRuntime.setMemoryLimit).toHaveBeenCalledWith(32 * 1024 * 1024);
  });

  it('injects __stateJson into global scope', async () => {
    const state = { count: 42, name: 'test' };
    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      state,
      mockRpcCallback,
    );

    // Should create a string handle with serialized state
    expect(mockContext.newString).toHaveBeenCalledWith(JSON.stringify(state));
    // Should set it on global
    expect(mockContext.setProp).toHaveBeenCalledWith(
      mockContext.global,
      '__stateJson',
      expect.anything(),
    );
  });

  it('injects __hostCall as an asyncified function', async () => {
    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(mockContext.newAsyncifiedFunction).toHaveBeenCalledWith(
      '__hostCall',
      expect.any(Function),
    );
    expect(mockContext.setProp).toHaveBeenCalledWith(
      mockContext.global,
      '__hostCall',
      expect.anything(),
    );
  });

  it('evaluates code using evalCodeAsync', async () => {
    await createQuickJSExecutor(
      'async function run() { return 42; }',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(mockContext.evalCodeAsync).toHaveBeenCalledWith(
      expect.stringContaining('async function run() { return 42; }'),
      'sandbox.js',
    );
  });

  it('returns error when evalCodeAsync returns an error', async () => {
    const errorHandle = createMockHandle('error');
    mockEvalCodeAsyncResult = { error: errorHandle };
    mockDumpReturn = { message: 'ReferenceError: foo is not defined' };

    const result = await createQuickJSExecutor(
      'foo()',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('ReferenceError: foo is not defined');
    expect(errorHandle.dispose).toHaveBeenCalled();
  });

  it('returns error string when error dump is not an object', async () => {
    const errorHandle = createMockHandle('error');
    mockEvalCodeAsyncResult = { error: errorHandle };
    mockDumpReturn = 'some plain error string';

    const result = await createQuickJSExecutor(
      'throw "bad"',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('some plain error string');
  });

  it('disposes handles on success path', async () => {
    const valueHandle = createMockHandle('resultValue');
    mockEvalCodeAsyncResult = { value: valueHandle };

    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    // The result value handle should be disposed
    expect(valueHandle.dispose).toHaveBeenCalled();
    // Context and runtime should be disposed in finally
    expect(mockContext.dispose).toHaveBeenCalled();
    expect(mockRuntime.dispose).toHaveBeenCalled();
  });

  it('disposes context and runtime on error', async () => {
    const errorHandle = createMockHandle('error');
    mockEvalCodeAsyncResult = { error: errorHandle };
    mockDumpReturn = { message: 'test error' };

    await createQuickJSExecutor(
      'bad code',
      'task-1',
      {},
      mockRpcCallback,
    );

    // Context and runtime should still be disposed
    expect(mockContext.dispose).toHaveBeenCalled();
    expect(mockRuntime.dispose).toHaveBeenCalled();
  });

  it('handles exceptions from the WASM module creation', async () => {
    const { newQuickJSAsyncWASMModule } = await import('quickjs-emscripten');
    (newQuickJSAsyncWASMModule as any).mockRejectedValueOnce(
      new Error('WASM load failed'),
    );

    const result = await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(result.ok).toBe(false);
    expect(result.error).toBe('WASM load failed');
  });

  it('passes state through to the result', async () => {
    mockDumpReturn = JSON.stringify({
      result: 'ok',
      state: { count: 42, updated: true },
    });

    const result = await createQuickJSExecutor(
      'async function run(page, context) { context.state.updated = true; }',
      'task-1',
      { count: 42 },
      mockRpcCallback,
    );

    expect(result.ok).toBe(true);
    expect(result.state).toEqual({ count: 42, updated: true });
  });

  it('wrapper script includes page methods', async () => {
    await createQuickJSExecutor(
      'async function run(page) { await page.goto("https://example.com"); }',
      'task-1',
      {},
      mockRpcCallback,
    );

    const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
    // The wrapper should contain the page method definitions
    expect(evalCall).toContain('goto');
    expect(evalCall).toContain('click');
    expect(evalCall).toContain('fill');
    expect(evalCall).toContain('waitForSelector');
    expect(evalCall).toContain('getByRole');
    expect(evalCall).toContain('getByText');
    expect(evalCall).toContain('getByLabel');
    expect(evalCall).toContain('locator');
  });

  it('wrapper script includes locator methods', async () => {
    await createQuickJSExecutor(
      'async function run() {}',
      'task-1',
      {},
      mockRpcCallback,
    );

    const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
    expect(evalCall).toContain('textContent');
    expect(evalCall).toContain('getAttribute');
    expect(evalCall).toContain('boundingBox');
    expect(evalCall).toContain('isVisible');
    expect(evalCall).toContain('count');
  });

  it('handles non-JSON dump result gracefully', async () => {
    mockDumpReturn = 42; // not a string
    mockEvalCodeAsyncResult = { value: createMockHandle(42) };

    const result = await createQuickJSExecutor(
      'async function run() { return 42; }',
      'task-1',
      {},
      mockRpcCallback,
    );

    expect(result.ok).toBe(true);
    expect(result.result).toBe(42);
  });

  describe('escapeSourceForTemplate', () => {
    it('escapes backticks in source', () => {
      const source = 'var s = `hello`;';
      const escaped = escapeSourceForTemplate(source);
      expect(escaped).toBe('var s = \\`hello\\`;');
      // The escaped form should not contain unescaped backticks
      expect(escaped).not.toMatch(/(?<!\\)`/);
    });

    it('escapes template literal interpolation syntax', () => {
      const source = 'var s = `value is ${x}`;';
      const escaped = escapeSourceForTemplate(source);
      expect(escaped).toBe('var s = \\`value is \\${x}\\`;');
      // Should not contain unescaped ${ sequences
      expect(escaped).not.toMatch(/(?<!\\)\$\{/);
    });

    it('escapes backslashes in source', () => {
      const source = 'var re = /a\\nb/;';
      const escaped = escapeSourceForTemplate(source);
      expect(escaped).toBe('var re = /a\\\\nb/;');
    });

    it('handles combined backticks, template expressions, and backslashes', () => {
      const source = 'var s = `path: C:\\\\Users\\\\${name}`;';
      const escaped = escapeSourceForTemplate(source);
      // Backslashes doubled, backticks escaped, ${ escaped
      expect(escaped).toBe('var s = \\`path: C:\\\\\\\\Users\\\\\\\\\\${name}\\`;');
      // Key: no unescaped backticks or ${ in result
      expect(escaped).not.toMatch(/(?<!\\)`/);
      expect(escaped).not.toMatch(/(?<!\\)\$\{/);
    });

    it('leaves normal source unchanged', () => {
      const source = 'async function run(page) { return 42; }';
      const escaped = escapeSourceForTemplate(source);
      expect(escaped).toBe(source);
    });
  });

  describe('dangerous globals stripping (Layer 4 hardening)', () => {
    it('sets eval, Function, Proxy, Reflect to undefined on global', async () => {
      await createQuickJSExecutor(
        'async function run() {}',
        'task-1',
        {},
        mockRpcCallback,
      );

      // Check that setProp was called with undefined for each dangerous global
      const setPropCalls = mockContext.setProp.mock.calls as any[];
      const dangerousGlobals = ['eval', 'Function', 'Proxy', 'Reflect'];
      for (const name of dangerousGlobals) {
        const found = setPropCalls.some(
          (call: any[]) => call[0] === mockContext.global && call[1] === name && call[2] === mockContext.undefined,
        );
        expect(found, `Expected ${name} to be set to undefined on global`).toBe(true);
      }
    });

    it('executes hardening script to strip function constructors', async () => {
      await createQuickJSExecutor(
        'async function run() {}',
        'task-1',
        {},
        mockRpcCallback,
      );

      // Check that evalCode was called with the hardening script
      const evalCodeCalls = mockContext.evalCode.mock.calls as any[];
      expect(evalCodeCalls.length).toBeGreaterThanOrEqual(1);
      const hardeningCall = evalCodeCalls.find(
        (call: any[]) => (call[0] as string).includes('AF') && (call[0] as string).includes('GF'),
      );
      expect(hardeningCall).toBeDefined();
      expect(hardeningCall[1]).toBe('hardening.js');
    });
  });

  describe('script interpolation safety', () => {
    it('wrapper correctly contains scripts with backticks', async () => {
      const sourceWithBackticks = 'async function run() { var s = `hello`; return s; }';
      await createQuickJSExecutor(
        sourceWithBackticks,
        'task-1',
        {},
        mockRpcCallback,
      );

      const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
      // The wrapper should contain the escaped backticks
      expect(evalCall).toContain('\\`hello\\`');
      // The wrapper should still be valid (starts with IIFE, ends properly)
      expect(evalCall).toContain('(async function()');
      expect(evalCall.trim().endsWith('})()'));
    });

    it('wrapper correctly contains scripts with template literal syntax', async () => {
      const sourceWithTemplate = 'async function run() { var x = 1; var s = `val: ${x}`; return s; }';
      await createQuickJSExecutor(
        sourceWithTemplate,
        'task-1',
        {},
        mockRpcCallback,
      );

      const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
      // The template expression should be escaped
      expect(evalCall).toContain('\\${x}');
      // The wrapper IIFE structure should remain intact
      expect(evalCall).toContain('(async function()');
      expect(evalCall.trim().endsWith('})()'));
    });

    it('wrapper correctly contains scripts with backslashes', async () => {
      const sourceWithBackslash = 'async function run() { return "line1\\nline2"; }';
      await createQuickJSExecutor(
        sourceWithBackslash,
        'task-1',
        {},
        mockRpcCallback,
      );

      const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
      // Backslash should be escaped
      expect(evalCall).toContain('\\\\n');
      expect(evalCall).toContain('(async function()');
    });

    it('existing wrapper tests still pass after escaping', async () => {
      // A normal script without special characters should work identically
      await createQuickJSExecutor(
        'async function run(page, context) { return { hello: "world" }; }',
        'task-1',
        {},
        mockRpcCallback,
      );

      const evalCall = (mockContext.evalCodeAsync.mock.calls as any[])[0][0] as string;
      // Normal source should appear as-is (no special chars to escape)
      expect(evalCall).toContain('async function run(page, context) { return { hello: "world" }; }');
      expect(evalCall).toContain('(async function()');
      expect(evalCall).toContain('JSON.parse(__stateJson)');
    });
  });
});
