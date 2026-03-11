import type { Task, ScriptVersion, TaskState } from '../types';
import { validateAST } from './security/ast-validator';

export interface TaskExportBundle {
  formatVersion: 1;
  exportedAt: string;
  cohandVersion: string;
  task: Task;
  scripts: ScriptVersion[];
  state?: TaskState;
}

export interface ImportValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const COHAND_VERSION = '0.1.0';

/**
 * Export a task and its scripts as a JSON bundle.
 */
export function exportTask(
  task: Task,
  scripts: ScriptVersion[],
  state?: TaskState,
  includeState = false,
): TaskExportBundle {
  return {
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    cohandVersion: COHAND_VERSION,
    task,
    scripts,
    state: includeState ? state : undefined,
  };
}

/**
 * Export a bundle as a downloadable JSON string.
 */
export function bundleToJson(bundle: TaskExportBundle): string {
  return JSON.stringify(bundle, null, 2);
}

/**
 * Parse and validate an import bundle.
 * Re-runs AST validation and checksum verification on all scripts.
 */
export async function validateImport(json: string): Promise<ImportValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  let bundle: TaskExportBundle;
  try {
    bundle = JSON.parse(json);
  } catch {
    return { valid: false, errors: ['Invalid JSON'], warnings: [] };
  }

  // Check format version
  if (bundle.formatVersion !== 1) {
    errors.push(`Unsupported format version: ${bundle.formatVersion}`);
  }

  // Check required fields
  if (!bundle.task) errors.push('Missing task field');
  if (!bundle.scripts || !Array.isArray(bundle.scripts)) errors.push('Missing scripts array');

  if (errors.length > 0) {
    return { valid: false, errors, warnings };
  }

  // Validate task fields
  if (!bundle.task.id) errors.push('Task missing id');
  if (!bundle.task.name) errors.push('Task missing name');
  if (!bundle.task.allowedDomains || bundle.task.allowedDomains.length === 0) {
    errors.push('Task has no allowed domains');
  }

  // Re-run AST validation on all scripts
  for (const script of bundle.scripts) {
    const validation = validateAST(script.source);
    if (!validation.valid) {
      errors.push(
        `Script v${script.version} failed AST validation: ${validation.errors.join(', ')}`,
      );
    }

    // Recompute checksum and warn if mismatch
    if (script.checksum) {
      const checksum = await computeChecksum(script.source);
      if (checksum !== script.checksum) {
        warnings.push(`Script v${script.version} checksum mismatch (possible tampering)`);
      }
    }
  }

  // Warn about security review requirement
  warnings.push('Imported scripts require security review before execution');

  // Warn if state included (may contain scraped data)
  if (bundle.state) {
    warnings.push('Bundle includes task state (may contain scraped data)');
  }

  return { valid: errors.length === 0, errors, warnings };
}

/**
 * Prepare a bundle for import by resetting security review flags.
 * Imported scripts must be re-reviewed before they can run.
 */
export function prepareForImport(bundle: TaskExportBundle): TaskExportBundle {
  const newTaskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return {
    ...bundle,
    task: {
      ...bundle.task,
      // Generate new ID to avoid conflicts
      id: newTaskId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    scripts: bundle.scripts.map((s) => ({
      ...s,
      // Reset security review — must be re-reviewed
      securityReviewPassed: false,
      reviewDetails: [],
      // Update script references to new task ID
      id: `${newTaskId}:v${s.version}`,
      taskId: newTaskId,
    })),
  };
}

/**
 * Compute SHA-256 checksum of script source.
 */
export async function computeChecksum(source: string): Promise<string> {
  const encoded = new TextEncoder().encode(source);
  const hash = await crypto.subtle.digest('SHA-256', encoded);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Trigger a file download in the browser.
 */
export function downloadBundle(bundle: TaskExportBundle): void {
  const json = bundleToJson(bundle);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cohand-task-${bundle.task.name.replace(/\s+/g, '-').toLowerCase()}.json`;
  a.click();
  URL.revokeObjectURL(url);
}
