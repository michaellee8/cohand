import { describe, it, expect } from 'vitest';
import type { Task, ScriptVersion, TaskState } from '../types';
import {
  exportTask,
  bundleToJson,
  validateImport,
  prepareForImport,
  computeChecksum,
  type TaskExportBundle,
} from './export-import';

// ── Fixtures ──────────────────────────────────────────────────────────

const SAFE_SOURCE = `
  async function run(page, context) {
    await page.goto('https://example.com');
    const text = await page.locator('.price').textContent();
    context.state.price = text;
    return { price: text };
  }
`;

const UNSAFE_SOURCE = `eval('alert(1)')`;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-abc',
    name: 'Test Task',
    description: 'A test task',
    allowedDomains: ['example.com'],
    schedule: { type: 'manual' },
    activeScriptVersion: 1,
    disabled: false,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeScript(overrides: Partial<ScriptVersion> = {}): ScriptVersion {
  return {
    id: 'task-abc:v1',
    taskId: 'task-abc',
    version: 1,
    source: SAFE_SOURCE,
    checksum: 'abc123',
    generatedBy: 'user_edit',
    astValidationPassed: true,
    securityReviewPassed: true,
    reviewDetails: [{ model: 'gpt-4', approved: true, issues: [] }],
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeState(): TaskState {
  return {
    taskId: 'task-abc',
    state: { price: '$9.99', lastRun: '2026-01-01' },
    updatedAt: '2026-01-01T00:00:00Z',
  };
}

function makeBundle(overrides: Partial<TaskExportBundle> = {}): TaskExportBundle {
  return {
    formatVersion: 1,
    exportedAt: '2026-01-01T00:00:00Z',
    cohandVersion: '0.1.0',
    task: makeTask(),
    scripts: [makeScript()],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe('exportTask', () => {
  it('creates a bundle with correct format version', () => {
    const bundle = exportTask(makeTask(), [makeScript()]);
    expect(bundle.formatVersion).toBe(1);
  });

  it('includes task and scripts', () => {
    const task = makeTask();
    const scripts = [makeScript()];
    const bundle = exportTask(task, scripts);
    expect(bundle.task).toEqual(task);
    expect(bundle.scripts).toEqual(scripts);
  });

  it('excludes state by default', () => {
    const bundle = exportTask(makeTask(), [makeScript()], makeState());
    expect(bundle.state).toBeUndefined();
  });

  it('includes state when opted in', () => {
    const state = makeState();
    const bundle = exportTask(makeTask(), [makeScript()], state, true);
    expect(bundle.state).toEqual(state);
  });

  it('includes exportedAt as ISO string', () => {
    const before = new Date().toISOString();
    const bundle = exportTask(makeTask(), [makeScript()]);
    const after = new Date().toISOString();
    expect(bundle.exportedAt >= before).toBe(true);
    expect(bundle.exportedAt <= after).toBe(true);
  });

  it('includes cohandVersion', () => {
    const bundle = exportTask(makeTask(), [makeScript()]);
    expect(bundle.cohandVersion).toBe('0.1.0');
  });
});

describe('bundleToJson', () => {
  it('produces valid JSON string', () => {
    const bundle = makeBundle();
    const json = bundleToJson(bundle);
    const parsed = JSON.parse(json);
    expect(parsed.formatVersion).toBe(1);
    expect(parsed.task.id).toBe('task-abc');
  });

  it('produces pretty-printed output', () => {
    const bundle = makeBundle();
    const json = bundleToJson(bundle);
    // Pretty-printed JSON has newlines
    expect(json).toContain('\n');
    expect(json).toContain('  ');
  });
});

describe('validateImport', () => {
  it('validates a correct bundle', async () => {
    const bundle = makeBundle();
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('rejects invalid JSON', async () => {
    const result = await validateImport('not json {{{');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid JSON');
  });

  it('rejects unsupported format version', async () => {
    const bundle = makeBundle({ formatVersion: 99 as never });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('format version'))).toBe(true);
  });

  it('rejects missing task', async () => {
    const bundle = makeBundle();
    delete (bundle as Record<string, unknown>).task;
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('task'))).toBe(true);
  });

  it('rejects missing scripts', async () => {
    const bundle = makeBundle();
    delete (bundle as Record<string, unknown>).scripts;
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('scripts'))).toBe(true);
  });

  it('rejects task with no allowed domains', async () => {
    const bundle = makeBundle({ task: makeTask({ allowedDomains: [] }) });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('allowed domains'))).toBe(true);
  });

  it('rejects task missing id', async () => {
    const bundle = makeBundle({ task: makeTask({ id: '' }) });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('id'))).toBe(true);
  });

  it('rejects task missing name', async () => {
    const bundle = makeBundle({ task: makeTask({ name: '' }) });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('name'))).toBe(true);
  });

  it('rejects scripts that fail AST validation', async () => {
    const bundle = makeBundle({
      scripts: [makeScript({ source: UNSAFE_SOURCE })],
    });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('AST validation'))).toBe(true);
  });

  it('warns about security review requirement', async () => {
    const bundle = makeBundle();
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.warnings.some(w => w.includes('security review'))).toBe(true);
  });

  it('warns about included state', async () => {
    const bundle = makeBundle({ state: makeState() });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.warnings.some(w => w.includes('state'))).toBe(true);
  });

  it('warns on checksum mismatch', async () => {
    // Compute the real checksum first, then set a wrong one
    const script = makeScript({ checksum: 'wrong-checksum-value' });
    const bundle = makeBundle({ scripts: [script] });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.warnings.some(w => w.includes('checksum mismatch'))).toBe(true);
  });

  it('does not warn on checksum match', async () => {
    const realChecksum = await computeChecksum(SAFE_SOURCE);
    const script = makeScript({ checksum: realChecksum });
    const bundle = makeBundle({ scripts: [script] });
    const result = await validateImport(JSON.stringify(bundle));
    expect(result.warnings.some(w => w.includes('checksum mismatch'))).toBe(false);
  });
});

describe('prepareForImport', () => {
  it('generates new task ID', () => {
    const bundle = makeBundle();
    const prepared = prepareForImport(bundle);
    expect(prepared.task.id).not.toBe(bundle.task.id);
    expect(prepared.task.id).toMatch(/^task-/);
  });

  it('resets security review flags', () => {
    const bundle = makeBundle({
      scripts: [makeScript({ securityReviewPassed: true })],
    });
    const prepared = prepareForImport(bundle);
    for (const script of prepared.scripts) {
      expect(script.securityReviewPassed).toBe(false);
      expect(script.reviewDetails).toEqual([]);
    }
  });

  it('updates timestamps', () => {
    const bundle = makeBundle();
    const before = new Date().toISOString();
    const prepared = prepareForImport(bundle);
    const after = new Date().toISOString();
    expect(prepared.task.createdAt >= before).toBe(true);
    expect(prepared.task.createdAt <= after).toBe(true);
    expect(prepared.task.updatedAt >= before).toBe(true);
    expect(prepared.task.updatedAt <= after).toBe(true);
  });

  it('preserves original task data', () => {
    const bundle = makeBundle();
    const prepared = prepareForImport(bundle);
    expect(prepared.task.name).toBe(bundle.task.name);
    expect(prepared.task.description).toBe(bundle.task.description);
    expect(prepared.task.allowedDomains).toEqual(bundle.task.allowedDomains);
  });

  it('updates script IDs to reference new task ID', () => {
    const bundle = makeBundle({
      scripts: [makeScript({ version: 1 }), makeScript({ version: 2, id: 'task-abc:v2' })],
    });
    const prepared = prepareForImport(bundle);
    for (const script of prepared.scripts) {
      expect(script.id).toContain(bundle.task.id);
      expect(script.id).toContain(`:v${script.version}`);
    }
  });
});

describe('computeChecksum', () => {
  it('computes SHA-256 hash', async () => {
    const hash = await computeChecksum('hello world');
    // Known SHA-256 of "hello world"
    expect(hash).toBe('b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9');
  });

  it('same input produces same hash', async () => {
    const a = await computeChecksum('test input');
    const b = await computeChecksum('test input');
    expect(a).toBe(b);
  });

  it('different input produces different hash', async () => {
    const a = await computeChecksum('input A');
    const b = await computeChecksum('input B');
    expect(a).not.toBe(b);
  });

  it('returns a 64-character hex string', async () => {
    const hash = await computeChecksum('anything');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
