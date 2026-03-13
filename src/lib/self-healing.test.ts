import { describe, it, expect, beforeEach, vi, type Mock } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from './db';
import {
  putTask,
  putScriptVersion,
  getTask,
  getScriptVersionsForTask,
  addScriptRun,
  getLatestVersion,
} from './db-helpers';
import {
  runSelfHealingLoop,
  detectDegradation,
  defaultRequireApproval,
  type SelfHealingParams,
  type SelfHealingResult,
} from './self-healing';
import type { Task, ScriptVersion, ScriptRun } from '../types';

// ---------------------------------------------------------------------------
// Mock modules
// ---------------------------------------------------------------------------

vi.mock('./explorer', () => ({
  repairScript: vi.fn(),
}));

vi.mock('./security/security-review', () => ({
  securityReview: vi.fn(),
}));

import { repairScript } from './explorer';
import { securityReview } from './security/security-review';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Price Monitor',
    description: 'Monitor price on example.com',
    allowedDomains: ['example.com'],
    schedule: { type: 'manual' },
    activeScriptVersion: 1,
    disabled: false,
    notifyEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const VALID_SCRIPT = `async function run(page, context) {
  await page.goto("https://example.com");
  const price = await page.locator('.price').textContent();
  return { price };
}`;

const REPAIRED_SCRIPT = `async function run(page, context) {
  await page.goto("https://example.com");
  const price = await page.locator('.new-price-selector').textContent();
  return { price };
}`;

const ACTION_SCRIPT = `async function run(page, context) {
  await page.goto("https://example.com");
  await page.click('[aria-label="Follow"]');
  return { followed: true };
}`;

function makeScriptVersion(
  taskId: string,
  version: number,
  source: string = VALID_SCRIPT,
  overrides: Partial<ScriptVersion> = {},
): ScriptVersion {
  return {
    id: `${taskId}:v${version}`,
    taskId,
    version,
    source,
    checksum: `checksum-v${version}`,
    generatedBy: 'explorer',
    astValidationPassed: true,
    securityReviewPassed: true,
    reviewDetails: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRun(
  taskId: string,
  success: boolean,
  result?: unknown,
  overrides: Partial<ScriptRun> = {},
): ScriptRun {
  return {
    id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    version: 1,
    success,
    result,
    error: success ? undefined : 'some error',
    durationMs: 100,
    ranAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeMockModel() {
  return {
    id: 'test-model',
    name: 'Test Model',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

let db: IDBDatabase;

beforeEach(async () => {
  indexedDB = new IDBFactory();
  db = await openDB();
  vi.clearAllMocks();
});

// =========================================================================
// getLatestVersion
// =========================================================================

describe('getLatestVersion', () => {
  it('returns undefined when no versions exist', async () => {
    const result = await getLatestVersion(db, 'nonexistent');
    expect(result).toBeUndefined();
  });

  it('returns the highest version number', async () => {
    await putScriptVersion(db, makeScriptVersion('task-1', 1));
    await putScriptVersion(db, makeScriptVersion('task-1', 3));
    await putScriptVersion(db, makeScriptVersion('task-1', 2));

    const latest = await getLatestVersion(db, 'task-1');
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(3);
  });

  it('returns the single version when only one exists', async () => {
    await putScriptVersion(db, makeScriptVersion('task-1', 5));

    const latest = await getLatestVersion(db, 'task-1');
    expect(latest).toBeDefined();
    expect(latest!.version).toBe(5);
  });
});

// =========================================================================
// detectDegradation
// =========================================================================

describe('detectDegradation', () => {
  it('returns false with fewer than 3 runs', () => {
    const runs = [
      makeRun('task-1', true, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      makeRun('task-1', true, []),
    ];
    expect(detectDegradation(runs)).toBe(false);
  });

  it('returns false when all runs return similar counts', () => {
    const runs = Array.from({ length: 5 }, (_, i) =>
      makeRun('task-1', true, Array.from({ length: 10 }, (_, j) => j), {
        ranAt: new Date(Date.now() - i * 60000).toISOString(),
      }),
    );
    expect(detectDegradation(runs)).toBe(false);
  });

  it('detects degradation when latest run returns far fewer items', () => {
    const historicalRuns = Array.from({ length: 5 }, (_, i) =>
      makeRun('task-1', true, Array.from({ length: 10 }, (_, j) => j), {
        ranAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      }),
    );
    const latestRun = makeRun('task-1', true, [1], {
      ranAt: new Date().toISOString(),
    });

    expect(detectDegradation([latestRun, ...historicalRuns])).toBe(true);
  });

  it('does not flag degradation when historical average is below threshold', () => {
    const historicalRuns = Array.from({ length: 5 }, (_, i) =>
      makeRun('task-1', true, [1, 2, 3], {
        ranAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      }),
    );
    const latestRun = makeRun('task-1', true, [1], {
      ranAt: new Date().toISOString(),
    });

    expect(detectDegradation([latestRun, ...historicalRuns])).toBe(false);
  });

  it('counts object keys for non-array results', () => {
    const historicalRuns = Array.from({ length: 5 }, (_, i) =>
      makeRun(
        'task-1',
        true,
        { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8, i: 9, j: 10 },
        { ranAt: new Date(Date.now() - (i + 1) * 60000).toISOString() },
      ),
    );
    const latestRun = makeRun('task-1', true, { a: 1 }, {
      ranAt: new Date().toISOString(),
    });

    expect(detectDegradation([latestRun, ...historicalRuns])).toBe(true);
  });

  it('ignores failed runs in degradation calculation', () => {
    const successRuns = Array.from({ length: 5 }, (_, i) =>
      makeRun('task-1', true, Array.from({ length: 10 }, (_, j) => j), {
        ranAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      }),
    );
    const failedRun = makeRun('task-1', false, undefined, {
      ranAt: new Date().toISOString(),
    });

    // Failed run doesn't have a meaningful result, it shouldn't cause false positive
    // since it's filtered out from successful runs analysis
    expect(detectDegradation([failedRun, ...successRuns])).toBe(false);
  });

  it('returns 0 items for null/undefined results', () => {
    const historicalRuns = Array.from({ length: 5 }, (_, i) =>
      makeRun('task-1', true, Array.from({ length: 10 }, (_, j) => j), {
        ranAt: new Date(Date.now() - (i + 1) * 60000).toISOString(),
      }),
    );
    const latestRun = makeRun('task-1', true, null, {
      ranAt: new Date().toISOString(),
    });

    expect(detectDegradation([latestRun, ...historicalRuns])).toBe(true);
  });
});

// =========================================================================
// defaultRequireApproval
// =========================================================================

describe('defaultRequireApproval', () => {
  const task = makeTask();

  it('returns false for pure scraping scripts', () => {
    expect(defaultRequireApproval(task, VALID_SCRIPT)).toBe(false);
  });

  it('returns true for action scripts (click/fill/type)', () => {
    expect(defaultRequireApproval(task, ACTION_SCRIPT)).toBe(true);
  });

  it('returns true for scripts with page.fill', () => {
    const script = `async function run(page) {
      await page.fill('#email', 'test@test.com');
    }`;
    expect(defaultRequireApproval(task, script)).toBe(true);
  });

  it('returns true for scripts with page.type', () => {
    const script = `async function run(page) {
      await page.type('#search', 'hello');
    }`;
    expect(defaultRequireApproval(task, script)).toBe(true);
  });

  it('returns false for scripts with only goto', () => {
    const script = `async function run(page) {
      await page.goto("https://example.com");
      return {};
    }`;
    expect(defaultRequireApproval(task, script)).toBe(false);
  });
});

// =========================================================================
// runSelfHealingLoop
// =========================================================================

describe('runSelfHealingLoop', () => {
  // -----------------------------------------------------------------------
  // Step 1: Try lastKnownGoodVersion
  // -----------------------------------------------------------------------
  describe('Step 1: lastKnownGoodVersion fallback', () => {
    it('tries lastKnownGoodVersion first and succeeds', async () => {
      const task = makeTask({
        activeScriptVersion: 2,
        lastKnownGoodVersion: 1,
      });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));
      await putScriptVersion(db, makeScriptVersion('task-1', 2));

      const executeVersion = vi.fn().mockResolvedValue({ success: true });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 2,
        error: 'Selector not found',
        tabId: 1,
        db,
        executeVersion,
      });

      expect(result.outcome).toBe('fallback_success');
      expect(result.promotedVersion).toBe(1);
      expect(result.repairAttemptsUsed).toBe(0);

      // Verify task was updated
      const updatedTask = await getTask(db, 'task-1');
      expect(updatedTask!.activeScriptVersion).toBe(1);
    });

    it('skips lastKnownGoodVersion if same as failedVersion', async () => {
      const task = makeTask({
        activeScriptVersion: 1,
        lastKnownGoodVersion: 1,
      });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // Should not have called executeVersion for LKG (same as failed)
      // Instead moves to step 2 / step 3
      expect(result.outcome).toBe('disabled');
    });

    it('moves to step 2 when lastKnownGoodVersion fails', async () => {
      const task = makeTask({
        activeScriptVersion: 3,
        lastKnownGoodVersion: 2,
      });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));
      await putScriptVersion(db, makeScriptVersion('task-1', 2));
      await putScriptVersion(db, makeScriptVersion('task-1', 3));

      // LKG (v2) fails, v1 succeeds
      const executeVersion = vi.fn()
        .mockResolvedValueOnce({ success: false, error: 'Still broken' })
        .mockResolvedValueOnce({ success: true });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 3,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      expect(result.outcome).toBe('fallback_success');
      expect(result.promotedVersion).toBe(1);
      expect(executeVersion).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Step 2: Try previous versions
  // -----------------------------------------------------------------------
  describe('Step 2: previous version fallback', () => {
    it('tries up to 2 previous versions', async () => {
      const task = makeTask({ activeScriptVersion: 4 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));
      await putScriptVersion(db, makeScriptVersion('task-1', 2));
      await putScriptVersion(db, makeScriptVersion('task-1', 3));
      await putScriptVersion(db, makeScriptVersion('task-1', 4));

      // All fallbacks fail
      const executeVersion = vi.fn().mockResolvedValue({
        success: false,
        error: 'failed',
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 4,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // Should try v3 and v2 (most recent first, skip v4=failed)
      expect(executeVersion).toHaveBeenCalledTimes(2);
      expect(result.outcome).toBe('disabled');
    });

    it('promotes the first successful previous version', async () => {
      const task = makeTask({ activeScriptVersion: 3 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));
      await putScriptVersion(db, makeScriptVersion('task-1', 2));
      await putScriptVersion(db, makeScriptVersion('task-1', 3));

      // v2 succeeds
      const executeVersion = vi.fn()
        .mockResolvedValueOnce({ success: false })
        .mockResolvedValueOnce({ success: true });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 3,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      expect(result.outcome).toBe('fallback_success');
      // v2 is the first candidate tried (highest version excluding failed)
      // but the first call fails (v2), second call succeeds (v1)
      expect(result.promotedVersion).toBe(1);
    });

    it('skips versions that failed security review', async () => {
      const task = makeTask({ activeScriptVersion: 3 });
      await putTask(db, task);
      await putScriptVersion(
        db,
        makeScriptVersion('task-1', 1, VALID_SCRIPT, {
          securityReviewPassed: false,
        }),
      );
      await putScriptVersion(db, makeScriptVersion('task-1', 2));
      await putScriptVersion(db, makeScriptVersion('task-1', 3));

      const executeVersion = vi.fn().mockResolvedValue({
        success: true,
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 3,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // Should only try v2 (v1 failed security review)
      expect(executeVersion).toHaveBeenCalledTimes(1);
      expect(result.outcome).toBe('fallback_success');
      expect(result.promotedVersion).toBe(2);
    });
  });

  // -----------------------------------------------------------------------
  // Step 3-4: LLM Repair with security pipeline
  // -----------------------------------------------------------------------
  describe('Step 3-4: LLM repair', () => {
    it('repairs script and auto-promotes for scraping scripts', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      (securityReview as Mock).mockResolvedValue({
        approved: true,
        details: [
          { model: 'test-model', approved: true, issues: [] },
          { model: 'test-model', approved: true, issues: [] },
        ],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Selector not found',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
        a11yTree: '<div>test</div>',
      });

      expect(result.outcome).toBe('repair_success');
      expect(result.promotedVersion).toBe(2);
      expect(result.repairedSource).toBe(REPAIRED_SCRIPT);
      expect(result.repairAttemptsUsed).toBe(1);

      // Verify new version was saved
      const versions = await getScriptVersionsForTask(db, 'task-1');
      const v2 = versions.find(v => v.version === 2);
      expect(v2).toBeDefined();
      expect(v2!.source).toBe(REPAIRED_SCRIPT);
      expect(v2!.generatedBy).toBe('repair');

      // Verify task was updated
      const updatedTask = await getTask(db, 'task-1');
      expect(updatedTask!.activeScriptVersion).toBe(2);
    });

    it('requires approval for action scripts', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1, ACTION_SCRIPT));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: ACTION_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      (securityReview as Mock).mockResolvedValue({
        approved: true,
        details: [
          { model: 'test-model', approved: true, issues: [] },
          { model: 'test-model', approved: true, issues: [] },
        ],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('approval_pending');
      expect(result.repairAttemptsUsed).toBe(1);

      // Task should NOT be auto-updated for action scripts
      const updatedTask = await getTask(db, 'task-1');
      expect(updatedTask!.activeScriptVersion).toBe(1);
    });

    it('retries repair when AST validation fails on first attempt', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      // First repair returns invalid AST, second returns valid
      (repairScript as Mock)
        .mockResolvedValueOnce({
          source: 'async function run(page) { eval("bad"); }',
          astValid: false,
          astErrors: ['eval blocked'],
        })
        .mockResolvedValueOnce({
          source: REPAIRED_SCRIPT,
          astValid: true,
          astErrors: [],
        });

      (securityReview as Mock).mockResolvedValue({
        approved: true,
        details: [],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('repair_success');
      expect(result.repairAttemptsUsed).toBe(2);
      expect(repairScript).toHaveBeenCalledTimes(2);
    });

    it('retries when security review rejects', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      // First review rejects, second approves
      (securityReview as Mock)
        .mockResolvedValueOnce({
          approved: false,
          details: [{ model: 'test', approved: false, issues: ['suspicious'] }],
        })
        .mockResolvedValueOnce({
          approved: true,
          details: [{ model: 'test', approved: true, issues: [] }],
        });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('repair_success');
      expect(result.repairAttemptsUsed).toBe(2);
    });

    it('works without securityModels (skips review)', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        // No securityModels
      });

      expect(result.outcome).toBe('repair_success');
      expect(securityReview).not.toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // Step 6: Budget enforcement
  // -----------------------------------------------------------------------
  describe('Step 6: repair budget', () => {
    it('disables task after exhausting repair budget', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      // Both repair attempts fail AST validation
      (repairScript as Mock).mockResolvedValue({
        source: 'async function run(page) { eval("bad"); }',
        astValid: false,
        astErrors: ['eval blocked'],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('disabled');
      expect(result.repairAttemptsUsed).toBe(2);

      const updatedTask = await getTask(db, 'task-1');
      expect(updatedTask!.disabled).toBe(true);
    });

    it('limits to exactly REPAIR_BUDGET attempts', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      // All attempts fail (LLM throws)
      (repairScript as Mock).mockRejectedValue(new Error('LLM error'));

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
      });

      expect(result.outcome).toBe('disabled');
      expect(repairScript).toHaveBeenCalledTimes(2);
    });
  });

  // -----------------------------------------------------------------------
  // Step 7: Task disabling
  // -----------------------------------------------------------------------
  describe('Step 7: task disabling', () => {
    it('disables task when no LLM model is configured', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        // No model or apiKey
      });

      expect(result.outcome).toBe('disabled');
      expect(result.message).toContain('No LLM model/key configured');

      const updatedTask = await getTask(db, 'task-1');
      expect(updatedTask!.disabled).toBe(true);
    });

    it('sends notification when task is disabled', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });

      await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // Check notification was created
      const tx = db.transaction('notifications', 'readonly');
      const store = tx.objectStore('notifications');
      const allNotifs = await new Promise<any[]>((resolve, reject) => {
        const req = store.getAll();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });

      expect(allNotifs.length).toBeGreaterThanOrEqual(1);
      const notif = allNotifs.find((n: any) =>
        n.message.includes('paused'),
      );
      expect(notif).toBeDefined();
      expect(notif.message).toContain('[Cohand: Price Monitor]');
    });
  });

  // -----------------------------------------------------------------------
  // Edge cases
  // -----------------------------------------------------------------------
  describe('edge cases', () => {
    it('handles no lastKnownGoodVersion gracefully', async () => {
      const task = makeTask({
        activeScriptVersion: 1,
        lastKnownGoodVersion: undefined,
      });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // Should skip LKG step and eventually disable
      expect(result.outcome).toBe('disabled');
    });

    it('handles task with only one version (no fallbacks)', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
      });

      // No fallbacks available, no LLM, should disable
      expect(executeVersion).not.toHaveBeenCalled();
      expect(result.outcome).toBe('disabled');
    });

    it('custom requireApproval function is respected', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      (securityReview as Mock).mockResolvedValue({
        approved: true,
        details: [],
      });

      // Force approval required even for scraping script
      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
        requireApproval: () => true,
      });

      expect(result.outcome).toBe('approval_pending');
    });

    it('increments version number correctly from latest', async () => {
      const task = makeTask({ activeScriptVersion: 5 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 3));
      await putScriptVersion(db, makeScriptVersion('task-1', 4));
      await putScriptVersion(db, makeScriptVersion('task-1', 5));

      // All fallbacks fail
      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      (securityReview as Mock).mockResolvedValue({
        approved: true,
        details: [],
      });

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 5,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('repair_success');
      expect(result.promotedVersion).toBe(6);
    });

    it('handles LLM repair throwing on all attempts', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockRejectedValue(new Error('API timeout'));

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      expect(result.outcome).toBe('disabled');
      expect(result.repairAttemptsUsed).toBe(2);
    });

    it('handles security review throwing (fail-closed)', async () => {
      const task = makeTask({ activeScriptVersion: 1 });
      await putTask(db, task);
      await putScriptVersion(db, makeScriptVersion('task-1', 1));

      const executeVersion = vi.fn().mockResolvedValue({ success: false });
      const model = makeMockModel();

      (repairScript as Mock).mockResolvedValue({
        source: REPAIRED_SCRIPT,
        astValid: true,
        astErrors: [],
      });

      (securityReview as Mock).mockRejectedValue(
        new Error('Review service down'),
      );

      const result = await runSelfHealingLoop({
        task,
        failedVersion: 1,
        error: 'Error',
        tabId: 1,
        db,
        executeVersion,
        model,
        apiKey: 'test-key',
        securityModels: [model, model],
      });

      // Both attempts should fail due to review error, task disabled
      expect(result.outcome).toBe('disabled');
    });
  });
});
