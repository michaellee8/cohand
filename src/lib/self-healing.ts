// src/lib/self-healing.ts
//
// Self-healing orchestrator: on script failure, tries fallback versions,
// then LLM repair with full security pipeline, tiered approval, and budget enforcement.

import type { Task, ScriptVersion, ScriptRun } from '../types';
import type { ModelLike } from './pi-ai-bridge';
import type { SecurityReviewResult } from './security/security-review';
import type { ScriptGenerationResult } from './explorer';
import {
  getScriptVersionsForTask,
  getRunsForTask,
  putScriptVersion,
  putTask,
  putNotification,
  capScriptVersions,
  getLatestVersion,
  getRecordingSteps,
  getRecordingPageSnapshots,
} from './db-helpers';
import { validateAST } from './security/ast-validator';
import { securityReview } from './security/security-review';
import { repairScript } from './explorer';
import { REPAIR_BUDGET } from '../constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SelfHealingOutcome =
  | 'fallback_success'
  | 'repair_success'
  | 'approval_pending'
  | 'budget_exhausted'
  | 'disabled';

export interface SelfHealingResult {
  outcome: SelfHealingOutcome;
  /** The version that was promoted (if any). */
  promotedVersion?: number;
  /** The repaired script source (if repair succeeded). */
  repairedSource?: string;
  /** Number of repair attempts consumed. */
  repairAttemptsUsed: number;
  /** Human-readable message describing what happened. */
  message: string;
}

export interface SelfHealingParams {
  task: Task;
  failedVersion: number;
  error: string;
  tabId: number;
  db: IDBDatabase;
  /** Execute a specific script version and return success/failure. */
  executeVersion: (version: ScriptVersion) => Promise<{
    success: boolean;
    result?: unknown;
    error?: string;
  }>;
  /** LLM model for repair. */
  model?: ModelLike;
  /** API key for LLM calls. */
  apiKey?: string;
  /** Models for security review [model1, model2]. */
  securityModels?: [ModelLike, ModelLike];
  /** Current a11y tree for repair context. */
  a11yTree?: string;
  /** Whether to require user approval for action scripts (default: true for actions). */
  requireApproval?: (task: Task, repairedSource: string) => boolean;
}

// ---------------------------------------------------------------------------
// Degradation detection
// ---------------------------------------------------------------------------

const ROLLING_WINDOW = 10;
const DEGRADATION_THRESHOLD_HIGH = 8;
const DEGRADATION_THRESHOLD_LOW = 2;

/**
 * Detect degradation: if a script that historically returned 8+ items per run
 * now returns 0-2, it is flagged as degraded.
 *
 * Returns true if the latest run appears degraded relative to the rolling history.
 */
export function detectDegradation(runs: ScriptRun[]): boolean {
  if (runs.length < 3) return false;

  // Sort newest first
  const sorted = [...runs].sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  const recent = sorted.slice(0, ROLLING_WINDOW);

  // Only consider successful runs for item-count analysis
  const successfulRuns = recent.filter(r => r.success);
  if (successfulRuns.length < 3) return false;

  // Count items in result (array length or object key count)
  const itemCounts = successfulRuns.map(r => countItems(r.result));

  // Historical average (excluding the most recent run)
  const historicalCounts = itemCounts.slice(1);
  if (historicalCounts.length === 0) return false;

  const historicalAvg =
    historicalCounts.reduce((sum, c) => sum + c, 0) / historicalCounts.length;
  const latestCount = itemCounts[0];

  // If historical average >= 8 items but latest is <= 2, flag as degraded
  return (
    historicalAvg >= DEGRADATION_THRESHOLD_HIGH &&
    latestCount <= DEGRADATION_THRESHOLD_LOW
  );
}

/**
 * Count items in a script result (array length, object key count, or 0).
 */
function countItems(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === 'object') return Object.keys(result).length;
  return 0;
}

// ---------------------------------------------------------------------------
// Default approval policy
// ---------------------------------------------------------------------------

/**
 * Default tiered approval: scraping scripts auto-promote, action scripts
 * require user approval.
 *
 * Heuristic: if the script source contains page.click, page.fill, or page.type
 * calls beyond initial navigation, it is classified as an "action" script.
 */
export function defaultRequireApproval(
  _task: Task,
  source: string,
): boolean {
  // Count action-like calls (excluding goto which is navigation)
  const actionPattern = /page\.(click|fill|type)\s*\(/g;
  const matches = source.match(actionPattern);
  return (matches?.length ?? 0) > 0;
}

// ---------------------------------------------------------------------------
// Self-healing orchestrator
// ---------------------------------------------------------------------------

export async function runSelfHealingLoop(
  params: SelfHealingParams,
): Promise<SelfHealingResult> {
  const {
    task,
    failedVersion,
    error,
    db,
    executeVersion,
    model,
    apiKey,
    securityModels,
    a11yTree,
  } = params;

  const requireApproval = params.requireApproval ?? defaultRequireApproval;

  // -----------------------------------------------------------------------
  // Step 1: Try lastKnownGoodVersion
  // -----------------------------------------------------------------------
  if (
    task.lastKnownGoodVersion !== undefined &&
    task.lastKnownGoodVersion !== failedVersion
  ) {
    const versions = await getScriptVersionsForTask(db, task.id);
    const lkg = versions.find(v => v.version === task.lastKnownGoodVersion);
    if (lkg) {
      const result = await executeVersion(lkg);
      if (result.success) {
        // Promote back to active
        await putTask(db, {
          ...task,
          activeScriptVersion: lkg.version,
          updatedAt: new Date().toISOString(),
        });
        return {
          outcome: 'fallback_success',
          promotedVersion: lkg.version,
          repairAttemptsUsed: 0,
          message: `Fell back to last known good version v${lkg.version}.`,
        };
      }
    }
  }

  // -----------------------------------------------------------------------
  // Step 2: Try up to 2 previous successful versions (most recent first)
  // -----------------------------------------------------------------------
  const allVersions = await getScriptVersionsForTask(db, task.id);
  const candidates = allVersions
    .filter(
      v =>
        v.version !== failedVersion &&
        v.version !== task.lastKnownGoodVersion &&
        v.securityReviewPassed &&
        v.astValidationPassed,
    )
    .sort((a, b) => b.version - a.version)
    .slice(0, 2);

  for (const candidate of candidates) {
    const result = await executeVersion(candidate);
    if (result.success) {
      await putTask(db, {
        ...task,
        activeScriptVersion: candidate.version,
        lastKnownGoodVersion: candidate.version,
        updatedAt: new Date().toISOString(),
      });
      return {
        outcome: 'fallback_success',
        promotedVersion: candidate.version,
        repairAttemptsUsed: 0,
        message: `Fell back to previous version v${candidate.version}.`,
      };
    }
  }

  // -----------------------------------------------------------------------
  // Step 3-6: LLM Repair (up to REPAIR_BUDGET attempts)
  // -----------------------------------------------------------------------
  if (!model || !apiKey) {
    // Cannot repair without LLM — disable the task
    return disableTask(db, task, 0, 'No LLM model/key configured for repair.');
  }

  // Get the failing script source
  const failingScript = allVersions.find(v => v.version === failedVersion);
  if (!failingScript) {
    return disableTask(db, task, 0, 'Failing script version not found.');
  }

  // Get the latest version number for creating new versions
  const latestVersion = await getLatestVersion(db, task.id);
  let nextVersionNumber = (latestVersion?.version ?? failedVersion) + 1;

  let repairAttemptsUsed = 0;

  for (
    let attempt = 0;
    attempt < REPAIR_BUDGET;
    attempt++, repairAttemptsUsed++
  ) {
    // Step 3: LLM repair
    // Load recording context if this script originated from a recording
    let recordingContext = '';
    if (failingScript.generatedBy === 'recording' && failingScript.recordingId) {
      try {
        const steps = await getRecordingSteps(db, failingScript.recordingId);
        const snapshots = await getRecordingPageSnapshots(db, failingScript.recordingId);
        if (steps.length > 0) {
          recordingContext = `\n\nOriginal recording steps:\n${steps.map(s =>
            `${s.sequenceIndex}. ${s.action} on ${s.selector ?? s.url ?? '(unknown)'}`
          ).join('\n')}`;
        }
        if (snapshots.length > 0) {
          recordingContext += `\n\nPage snapshots available: ${snapshots.length}`;
        }
      } catch { /* non-fatal: proceed without recording context */ }
    }

    let repairResult: ScriptGenerationResult;
    try {
      repairResult = await repairScript(model, apiKey, {
        source: failingScript.source,
        error: error + recordingContext,
        a11yTree: a11yTree ?? '',
      });
    } catch (repairError) {
      // LLM repair failed — count attempt and continue
      continue;
    }

    // Step 4: Full security pipeline on repaired script
    // 4a: AST validation
    const astResult = validateAST(repairResult.source);
    if (!astResult.valid) {
      // AST invalid — try next attempt
      continue;
    }

    // 4b: Dual-model security review
    let reviewResult: SecurityReviewResult | undefined;
    if (securityModels) {
      try {
        reviewResult = await securityReview(
          repairResult.source,
          securityModels,
          apiKey,
          failingScript.source,
        );
      } catch (_reviewError) {
        // Fail-closed: review error = rejection
        continue;
      }

      if (!reviewResult.approved) {
        // Security review rejected — try next attempt
        continue;
      }
    }

    // Step 5: Tiered approval
    const needsApproval = requireApproval(task, repairResult.source);

    // Save the repaired version
    const newVersion: ScriptVersion = {
      id: `${task.id}:v${nextVersionNumber}`,
      taskId: task.id,
      version: nextVersionNumber,
      source: repairResult.source,
      checksum: await computeChecksum(repairResult.source),
      generatedBy: 'repair',
      astValidationPassed: true,
      securityReviewPassed: reviewResult?.approved ?? true,
      reviewDetails: reviewResult?.details ?? [],
      createdAt: new Date().toISOString(),
    };

    await putScriptVersion(db, newVersion);
    await capScriptVersions(db, task.id);

    if (needsApproval) {
      // Action script — requires user approval, do NOT auto-promote
      await sendNotification(
        db,
        task,
        `Task '${task.name}' was repaired (v${failedVersion}->v${nextVersionNumber}) but requires your approval. [Review]`,
      );

      return {
        outcome: 'approval_pending',
        promotedVersion: nextVersionNumber,
        repairedSource: repairResult.source,
        repairAttemptsUsed: repairAttemptsUsed + 1,
        message: `Repair succeeded but action script requires user approval (v${nextVersionNumber}).`,
      };
    }

    // Scraping script — auto-promote with notification
    await putTask(db, {
      ...task,
      activeScriptVersion: nextVersionNumber,
      updatedAt: new Date().toISOString(),
    });

    await sendNotification(
      db,
      task,
      `Task '${task.name}' self-healed (v${failedVersion}->v${nextVersionNumber}). [Review] [Revert]`,
    );

    return {
      outcome: 'repair_success',
      promotedVersion: nextVersionNumber,
      repairedSource: repairResult.source,
      repairAttemptsUsed: repairAttemptsUsed + 1,
      message: `Self-healed via LLM repair: v${failedVersion} -> v${nextVersionNumber}.`,
    };
  }

  // -----------------------------------------------------------------------
  // Step 7: Exhausted repair budget — disable task
  // -----------------------------------------------------------------------
  return disableTask(
    db,
    task,
    repairAttemptsUsed,
    `Repair budget exhausted after ${repairAttemptsUsed} attempts.`,
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function disableTask(
  db: IDBDatabase,
  task: Task,
  repairAttemptsUsed: number,
  reason: string,
): Promise<SelfHealingResult> {
  await putTask(db, {
    ...task,
    disabled: true,
    updatedAt: new Date().toISOString(),
  });

  await sendNotification(
    db,
    task,
    `Task '${task.name}' paused: ${reason} Open the page and click 'Reinspect' to regenerate.`,
  );

  return {
    outcome: 'disabled',
    repairAttemptsUsed,
    message: `Task disabled: ${reason}`,
  };
}

async function sendNotification(
  db: IDBDatabase,
  task: Task,
  message: string,
): Promise<void> {
  try {
    await putNotification(db, {
      id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId: task.id,
      message: `[Cohand: ${task.name}] ${message}`,
      isRead: 0,
      createdAt: new Date().toISOString(),
    });
  } catch (_err) {
    // Best-effort notification — do not fail self-healing
  }
}

/**
 * Compute SHA-256 checksum of script source.
 * Falls back to a simple hash if SubtleCrypto is not available (e.g., in tests).
 */
async function computeChecksum(source: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data = encoder.encode(source);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback for environments without SubtleCrypto
    let hash = 0;
    for (let i = 0; i < source.length; i++) {
      const char = source.charCodeAt(i);
      hash = ((hash << 5) - hash + char) | 0;
    }
    return `fallback-${Math.abs(hash).toString(16)}`;
  }
}
