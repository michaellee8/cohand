import type { Task, ScriptVersion, ScriptRun } from '../types';
import { REPAIR_BUDGET } from '../constants';

export type HealingAction =
  | { type: 'fallback_success'; version: number }
  | { type: 'repair_generated'; source: string; version: number }
  | { type: 'failed'; reason: string };

export interface HealingContext {
  task: Task;
  failedRun: ScriptRun;
  versions: ScriptVersion[];
  executeScript: (version: ScriptVersion) => Promise<ScriptRun>;
  repairScript: (failedSource: string, error: string, a11yTree: string) => Promise<{ source: string; astValid: boolean }>;
  getA11yTree: () => Promise<string>;
  securityReview: (source: string, previousApproved?: string) => Promise<{ approved: boolean }>;
}

/**
 * Self-healing loop. Tries:
 * 1. last_known_good version
 * 2. Up to 2 previous successful versions
 * 3. LLM repair (up to REPAIR_BUDGET attempts)
 */
export async function selfHeal(ctx: HealingContext): Promise<HealingAction> {
  const { task, failedRun, versions } = ctx;

  // Sort versions by version number descending
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const activeVersion = sorted.find(v => v.version === task.activeScriptVersion);

  // Step 1: Try last_known_good version
  if (task.lastKnownGoodVersion && task.lastKnownGoodVersion !== task.activeScriptVersion) {
    const lkgVersion = sorted.find(v => v.version === task.lastKnownGoodVersion);
    if (lkgVersion) {
      const run = await ctx.executeScript(lkgVersion);
      if (run.success) {
        return { type: 'fallback_success', version: lkgVersion.version };
      }
    }
  }

  // Step 2: Try up to 2 previous versions (excluding active and LKG)
  const previousVersions = sorted.filter(
    v => v.version !== task.activeScriptVersion &&
         v.version !== task.lastKnownGoodVersion &&
         v.securityReviewPassed,
  ).slice(0, 2);

  for (const pv of previousVersions) {
    const run = await ctx.executeScript(pv);
    if (run.success) {
      return { type: 'fallback_success', version: pv.version };
    }
  }

  // Step 3: LLM Repair (up to REPAIR_BUDGET attempts)
  if (!activeVersion) {
    return { type: 'failed', reason: 'No active version found for repair' };
  }

  for (let attempt = 0; attempt < REPAIR_BUDGET; attempt++) {
    try {
      const a11yTree = await ctx.getA11yTree();
      const repaired = await ctx.repairScript(
        activeVersion.source,
        failedRun.error || 'Unknown error',
        a11yTree,
      );

      if (!repaired.astValid) continue;

      // Security review
      const review = await ctx.securityReview(repaired.source, activeVersion.source);
      if (!review.approved) continue;

      // New version number
      const newVersion = (sorted[0]?.version ?? 0) + 1;

      return {
        type: 'repair_generated',
        source: repaired.source,
        version: newVersion,
      };
    } catch {
      // Repair attempt failed, continue to next attempt
    }
  }

  return { type: 'failed', reason: `Failed after ${REPAIR_BUDGET} repair attempts` };
}

/**
 * Check if a task is degraded based on rolling success rate.
 * Track last 10 runs: if success rate drops below 50%, flag as degraded.
 */
export function isDegraded(recentRuns: ScriptRun[]): boolean {
  if (recentRuns.length < 5) return false;

  const last10 = recentRuns.slice(0, 10);
  const successRate = last10.filter(r => r.success).length / last10.length;

  // If less than 50% success in recent runs, consider degraded
  return successRate < 0.5;
}

/**
 * Determine approval requirement for a repaired script.
 * Scraping scripts: auto-promote with notification
 * Action scripts: require user approval
 */
export function getApprovalRequirement(task: Task): 'auto' | 'manual' {
  const actionKeywords = /\b(follow|like|post|submit|send|delete|buy|subscribe|unfollow|unlike|block|report|comment|reply|share|retweet|bookmark|save|add|remove|cancel|order|checkout|purchase)\b/i;

  if (actionKeywords.test(task.description) || actionKeywords.test(task.name)) {
    return 'manual';
  }

  return 'auto';
}
