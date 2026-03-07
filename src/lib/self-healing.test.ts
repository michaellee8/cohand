import { describe, it, expect, vi } from 'vitest';
import { selfHeal, isDegraded, getApprovalRequirement, type HealingContext } from './self-healing';
import type { Task, ScriptVersion, ScriptRun } from '../types';
import { REPAIR_BUDGET } from '../constants';

function makeTask(overrides?: Partial<Task>): Task {
  return {
    id: 'task-1',
    name: 'Test Task',
    description: 'Monitor prices',
    allowedDomains: ['example.com'],
    schedule: { type: 'manual' },
    activeScriptVersion: 3,
    lastKnownGoodVersion: 2,
    disabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeVersion(version: number, overrides?: Partial<ScriptVersion>): ScriptVersion {
  return {
    id: `task-1:v${version}`,
    taskId: 'task-1',
    version,
    source: `v${version} code`,
    checksum: '',
    generatedBy: 'explorer',
    astValidationPassed: true,
    securityReviewPassed: true,
    reviewDetails: [],
    createdAt: '',
    ...overrides,
  };
}

function makeRun(success: boolean, overrides?: Partial<ScriptRun>): ScriptRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    version: 3,
    success,
    error: success ? undefined : 'Selector not found',
    durationMs: 100,
    ranAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeContext(overrides?: Partial<HealingContext>): HealingContext {
  return {
    task: makeTask(),
    failedRun: makeRun(false),
    versions: [makeVersion(1), makeVersion(2), makeVersion(3)],
    executeScript: vi.fn().mockResolvedValue(makeRun(false)),
    repairScript: vi.fn().mockResolvedValue({ source: 'repaired code', astValid: true }),
    getA11yTree: vi.fn().mockResolvedValue('<tree/>'),
    securityReview: vi.fn().mockResolvedValue({ approved: true }),
    ...overrides,
  };
}

describe('selfHeal', () => {
  it('tries last_known_good first and succeeds', async () => {
    const executeScript = vi.fn().mockResolvedValueOnce(makeRun(true, { version: 2 }));
    const ctx = makeContext({ executeScript });

    const result = await selfHeal(ctx);

    expect(result).toEqual({ type: 'fallback_success', version: 2 });
    expect(executeScript).toHaveBeenCalledTimes(1);
    // Should have been called with version 2 (LKG)
    expect(executeScript.mock.calls[0][0].version).toBe(2);
  });

  it('tries previous versions after LKG fails', async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce(makeRun(false, { version: 2 }))  // LKG fails
      .mockResolvedValueOnce(makeRun(true, { version: 1 }));  // v1 succeeds

    const ctx = makeContext({ executeScript });

    const result = await selfHeal(ctx);

    expect(result).toEqual({ type: 'fallback_success', version: 1 });
    expect(executeScript).toHaveBeenCalledTimes(2);
  });

  it('skips LKG when it equals active version', async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce(makeRun(true, { version: 2 }));

    const ctx = makeContext({
      task: makeTask({ activeScriptVersion: 2, lastKnownGoodVersion: 2 }),
      executeScript,
    });

    const result = await selfHeal(ctx);

    // Should skip LKG (same as active) and go to previous versions
    // v3 and v1 are candidates (not active=2, not LKG=2)
    // v3 is first (descending sort), and it succeeds
    expect(result.type).toBe('fallback_success');
  });

  it('skips LKG when not set', async () => {
    const executeScript = vi.fn()
      .mockResolvedValueOnce(makeRun(true, { version: 2 }));

    const ctx = makeContext({
      task: makeTask({ lastKnownGoodVersion: undefined }),
      executeScript,
    });

    const result = await selfHeal(ctx);

    // Should skip LKG step and go to previous versions
    expect(result.type).toBe('fallback_success');
  });

  it('attempts LLM repair when all versions fail', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn().mockResolvedValue({ source: 'repaired code', astValid: true });
    const securityReview = vi.fn().mockResolvedValue({ approved: true });

    const ctx = makeContext({ executeScript, repairScript, securityReview });

    const result = await selfHeal(ctx);

    expect(result.type).toBe('repair_generated');
    if (result.type === 'repair_generated') {
      expect(result.source).toBe('repaired code');
      expect(result.version).toBe(4); // next after max version 3
    }
    expect(repairScript).toHaveBeenCalledTimes(1);
  });

  it('returns failed after REPAIR_BUDGET attempts', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn().mockResolvedValue({ source: 'bad code', astValid: false });
    const securityReview = vi.fn().mockResolvedValue({ approved: true });

    const ctx = makeContext({ executeScript, repairScript, securityReview });

    const result = await selfHeal(ctx);

    expect(result).toEqual({
      type: 'failed',
      reason: `Failed after ${REPAIR_BUDGET} repair attempts`,
    });
    expect(repairScript).toHaveBeenCalledTimes(REPAIR_BUDGET);
  });

  it('skips repair if AST validation fails', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn().mockResolvedValue({ source: 'invalid', astValid: false });
    const securityReview = vi.fn();

    const ctx = makeContext({ executeScript, repairScript, securityReview });

    const result = await selfHeal(ctx);

    expect(result.type).toBe('failed');
    // Security review should never be called if AST fails
    expect(securityReview).not.toHaveBeenCalled();
    expect(repairScript).toHaveBeenCalledTimes(REPAIR_BUDGET);
  });

  it('skips repair if security review fails', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn().mockResolvedValue({ source: 'repaired', astValid: true });
    const securityReview = vi.fn().mockResolvedValue({ approved: false });

    const ctx = makeContext({ executeScript, repairScript, securityReview });

    const result = await selfHeal(ctx);

    expect(result.type).toBe('failed');
    expect(securityReview).toHaveBeenCalledTimes(REPAIR_BUDGET);
    expect(repairScript).toHaveBeenCalledTimes(REPAIR_BUDGET);
  });

  it('returns repair_generated on successful repair', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn().mockResolvedValue({ source: 'fixed code', astValid: true });
    const securityReview = vi.fn().mockResolvedValue({ approved: true });
    const getA11yTree = vi.fn().mockResolvedValue('<a11y>test</a11y>');

    const ctx = makeContext({ executeScript, repairScript, securityReview, getA11yTree });

    const result = await selfHeal(ctx);

    expect(result).toEqual({
      type: 'repair_generated',
      source: 'fixed code',
      version: 4,
    });
    expect(getA11yTree).toHaveBeenCalled();
    expect(repairScript).toHaveBeenCalledWith('v3 code', 'Selector not found', '<a11y>test</a11y>');
    expect(securityReview).toHaveBeenCalledWith('fixed code', 'v3 code');
  });

  it('continues to next attempt when repair throws', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));
    const repairScript = vi.fn()
      .mockRejectedValueOnce(new Error('LLM timeout'))
      .mockResolvedValueOnce({ source: 'fixed', astValid: true });
    const securityReview = vi.fn().mockResolvedValue({ approved: true });

    const ctx = makeContext({ executeScript, repairScript, securityReview });

    const result = await selfHeal(ctx);

    expect(result.type).toBe('repair_generated');
    expect(repairScript).toHaveBeenCalledTimes(2);
  });

  it('only tries security-reviewed versions as fallbacks', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));

    const versions = [
      makeVersion(1, { securityReviewPassed: true }),
      makeVersion(2, { securityReviewPassed: true }),
      makeVersion(3, { securityReviewPassed: true }),
      // v4 exists but failed security review - should not be tried as fallback
    ];

    // Add a version that failed security review
    const v4 = makeVersion(4, { securityReviewPassed: false });
    versions.push(v4);

    const ctx = makeContext({
      task: makeTask({ activeScriptVersion: 3, lastKnownGoodVersion: 2 }),
      versions,
      executeScript,
      repairScript: vi.fn().mockResolvedValue({ source: 'x', astValid: false }),
    });

    await selfHeal(ctx);

    // Should try LKG (v2), then previous approved versions (v1 only, v4 not approved)
    // v3 is active, v2 is LKG, v4 is not approved => only v1 is a valid previous version
    const triedVersions = executeScript.mock.calls.map(
      (call: [ScriptVersion]) => call[0].version,
    );
    expect(triedVersions).not.toContain(4);
  });

  it('returns failed when no active version exists for repair', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));

    const ctx = makeContext({
      task: makeTask({ activeScriptVersion: 99 }), // no matching version
      executeScript,
    });

    const result = await selfHeal(ctx);

    expect(result).toEqual({ type: 'failed', reason: 'No active version found for repair' });
  });

  it('limits previous version fallbacks to 2', async () => {
    const executeScript = vi.fn().mockResolvedValue(makeRun(false));

    const versions = [
      makeVersion(1),
      makeVersion(2),
      makeVersion(3),
      makeVersion(4),
      makeVersion(5),
    ];

    const ctx = makeContext({
      task: makeTask({ activeScriptVersion: 5, lastKnownGoodVersion: undefined }),
      versions,
      executeScript,
      repairScript: vi.fn().mockResolvedValue({ source: 'x', astValid: false }),
    });

    await selfHeal(ctx);

    // No LKG, so should try up to 2 previous versions (v4, v3 - descending, excluding active v5)
    // Then REPAIR_BUDGET repair attempts
    // Total executeScript calls: 2 (previous versions only)
    expect(executeScript).toHaveBeenCalledTimes(2);
  });
});

describe('isDegraded', () => {
  it('returns false for fewer than 5 runs', () => {
    const runs = [
      makeRun(false),
      makeRun(false),
      makeRun(false),
      makeRun(false),
    ];
    expect(isDegraded(runs)).toBe(false);
  });

  it('returns false when success rate >= 50%', () => {
    const runs = [
      makeRun(true),
      makeRun(true),
      makeRun(true),
      makeRun(false),
      makeRun(false),
    ];
    expect(isDegraded(runs)).toBe(false);
  });

  it('returns true when success rate < 50%', () => {
    const runs = [
      makeRun(false),
      makeRun(false),
      makeRun(false),
      makeRun(true),
      makeRun(false),
    ];
    expect(isDegraded(runs)).toBe(true);
  });

  it('only considers the last 10 runs', () => {
    // 12 runs: first 10 have 4 successes (40%) => degraded
    const runs = [
      makeRun(false), makeRun(false), makeRun(false), makeRun(false),
      makeRun(true), makeRun(true), makeRun(true), makeRun(true),
      makeRun(false), makeRun(false),
      // These are beyond first 10, should be ignored
      makeRun(true), makeRun(true),
    ];
    expect(isDegraded(runs)).toBe(true);
  });

  it('returns false for exactly 50% success rate', () => {
    const runs = [
      makeRun(true), makeRun(true), makeRun(true),
      makeRun(false), makeRun(false), makeRun(false),
    ];
    // 3/6 = 50%, not < 50%, so not degraded
    expect(isDegraded(runs)).toBe(false);
  });

  it('returns true for all failures', () => {
    const runs = [
      makeRun(false), makeRun(false), makeRun(false),
      makeRun(false), makeRun(false),
    ];
    expect(isDegraded(runs)).toBe(true);
  });

  it('returns false for empty runs', () => {
    expect(isDegraded([])).toBe(false);
  });
});

describe('getApprovalRequirement', () => {
  it('returns auto for scraping tasks', () => {
    const task = makeTask({ name: 'Price Monitor', description: 'Monitor product prices daily' });
    expect(getApprovalRequirement(task)).toBe('auto');
  });

  it('returns manual for action tasks with "follow"', () => {
    const task = makeTask({ name: 'Auto Follow', description: 'Follow new users' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "like"', () => {
    const task = makeTask({ name: 'Auto Like', description: 'Like recent posts' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "post"', () => {
    const task = makeTask({ description: 'Post a comment on each thread' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "submit"', () => {
    const task = makeTask({ description: 'Submit the form automatically' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "send"', () => {
    const task = makeTask({ description: 'Send messages to contacts' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "delete"', () => {
    const task = makeTask({ description: 'Delete old posts' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual for action tasks with "comment"', () => {
    const task = makeTask({ description: 'Comment on new posts' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns manual when keyword is in name', () => {
    const task = makeTask({ name: 'Subscribe Bot', description: 'Manage newsletter subscriptions' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });

  it('returns auto for read-only task descriptions', () => {
    const task = makeTask({ name: 'Stock Checker', description: 'Check stock availability and prices' });
    expect(getApprovalRequirement(task)).toBe('auto');
  });

  it('is case insensitive', () => {
    const task = makeTask({ description: 'FOLLOW all new accounts' });
    expect(getApprovalRequirement(task)).toBe('manual');
  });
});
