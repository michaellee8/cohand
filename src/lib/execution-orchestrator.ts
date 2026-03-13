import {
  getTask,
  getScriptVersionsForTask,
  getTaskState,
  putTaskState,
  addScriptRun,
  capRuns,
  putStateSnapshot,
  capStateSnapshots,
} from './db-helpers';
import { resetCumulativeReads } from './humanized-page-handler';
import { validateAST } from './security/ast-validator';
import { scanReturnValue, scanState } from './security/injection-scanner';
import { runSelfHealingLoop } from './self-healing';
import type { ScriptRun, ScriptVersion } from '../types';
import type { ModelLike } from './pi-ai-bridge';
import type { CDPManager } from './cdp';

// ---------------------------------------------------------------------------
// Context type — all dependencies injected by the caller
// ---------------------------------------------------------------------------

export interface ExecutionContext {
  db: IDBDatabase;
  taskTabMap: Map<string, number>;
  executionAbortControllers: Map<string, AbortController>;
  claimTab: (tabId: number, mode: 'local' | 'remote', sessionId?: string) => boolean;
  releaseTab: (tabId: number, sessionId?: string) => void;
  cdp: CDPManager;
  ensureOffscreen: () => Promise<void>;
  /** Optional callback invoked when taskTabMap is mutated, for write-through persistence. */
  onTaskTabMapChange?: () => void;
  /** Optional LLM model for self-healing repair. */
  repairModel?: ModelLike;
  /** Optional API key for self-healing LLM calls. */
  repairApiKey?: string;
  /** Optional pair of models for security review during self-healing. */
  securityModels?: [ModelLike, ModelLike];
  /** Optional a11y tree provider for self-healing repair context. */
  getA11yTree?: (tabId: number) => Promise<string>;
}

// ---------------------------------------------------------------------------
// Execution orchestrator
// ---------------------------------------------------------------------------

/**
 * Runs a task's active script in the sandbox, recording the result as a ScriptRun.
 *
 * Behaviour:
 * - If the task already has an in-flight execution, the previous one is aborted.
 * - The tab is claimed via `claimTab` and released only if claiming succeeded.
 * - An AbortController is registered in `executionAbortControllers` for the
 *   duration of the run and removed on completion.
 */
export async function executeTaskAsync(
  taskId: string,
  tabId: number,
  ctx: ExecutionContext,
): Promise<void> {
  const {
    db,
    taskTabMap,
    executionAbortControllers,
    claimTab,
    releaseTab,
    cdp,
    ensureOffscreen,
  } = ctx;

  // --- Concurrent execution guard ---
  // If a previous execution is still in flight, abort it.
  const existing = executionAbortControllers.get(taskId);
  if (existing) {
    existing.abort();
    executionAbortControllers.delete(taskId);
  }

  const abortController = new AbortController();
  executionAbortControllers.set(taskId, abortController);

  const startTime = Date.now();
  let runRecord: ScriptRun | undefined;
  let claimed = false;

  try {
    // Claim tab for local execution
    if (!claimTab(tabId, 'local')) {
      throw new Error('Tab is already under remote control');
    }
    claimed = true;

    // Map task to tab
    taskTabMap.set(taskId, tabId);
    ctx.onTaskTabMapChange?.();
    resetCumulativeReads(taskId);

    // Get task and active script
    const task = await getTask(db, taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const versions = await getScriptVersionsForTask(db, taskId);
    const activeVersion = versions.find(v => v.version === task.activeScriptVersion);
    if (!activeVersion) throw new Error(`Script version ${task.activeScriptVersion} not found`);

    // Re-validate AST before execution (H12 — enforce security gates)
    const validation = validateAST(activeVersion.source);
    if (!validation.valid) {
      throw new Error(`Script failed AST validation: ${validation.errors.join(', ')}`);
    }

    // Enforce security review gate — script must have passed dual-model review
    if (!activeVersion.securityReviewPassed) {
      throw new Error(`Script version ${activeVersion.version} has not passed security review`);
    }

    // Get current state
    const taskState = await getTaskState(db, taskId);
    const currentState = taskState?.state ?? {};

    // Ensure offscreen document is created (hosts the sandbox iframe)
    await ensureOffscreen();

    // Attach debugger
    await cdp.attach(tabId);

    try {
      // Send execution request to offscreen document.
      // Flow: service worker -> offscreen doc -> sandbox iframe -> script runs
      // RPCs flow back: sandbox -> offscreen -> service worker RPC port -> CDP
      let execResponse = await chrome.runtime.sendMessage({
        type: 'SANDBOX_EXECUTE',
        taskId,
        source: activeVersion.source,
        state: currentState,
        tabId,
      });

      if (abortController.signal.aborted) {
        throw new Error('Execution cancelled');
      }

      // Scan return value before storing (Layer 5 — output scanning)
      if (execResponse?.ok && execResponse.result !== undefined) {
        const resultScan = scanReturnValue(execResponse.result);
        if (!resultScan.safe) {
          execResponse = {
            ok: false,
            error: `Output scan blocked: ${resultScan.flags.join(', ')}`,
          };
        }
      }

      // Scan state before persistence (Layer 5 — output scanning)
      if (execResponse?.ok && execResponse.state) {
        const stateScan = scanState(execResponse.state);
        if (!stateScan.safe) {
          execResponse = {
            ok: false,
            error: `State scan blocked: ${stateScan.flags.join(', ')}`,
          };
        }
      }

      // Record run
      runRecord = {
        id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        taskId,
        version: activeVersion.version,
        success: execResponse?.ok ?? false,
        result: execResponse?.result,
        error: execResponse?.ok ? undefined : execResponse?.error,
        durationMs: Date.now() - startTime,
        ranAt: new Date().toISOString(),
      };

      // Update state if execution returned new state
      if (execResponse?.ok && execResponse.state) {
        await putTaskState(db, {
          taskId,
          state: execResponse.state,
          updatedAt: new Date().toISOString(),
        });
      }

      // On failure, snapshot state
      if (!execResponse?.ok) {
        await putStateSnapshot(db, {
          id: runRecord.id,
          taskId,
          state: currentState,
          createdAt: runRecord.ranAt,
        });
        await capStateSnapshots(db, taskId);
      }
    } finally {
      await cdp.detach(tabId);
    }
  } catch (err: unknown) {
    // Record error run
    runRecord = {
      id: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      taskId,
      version: 0,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startTime,
      ranAt: new Date().toISOString(),
    };
  } finally {
    // Only release if we successfully claimed
    if (claimed) {
      releaseTab(tabId);
    }
    taskTabMap.delete(taskId);
    // Only delete our own abort controller (a newer execution may have replaced it)
    if (executionAbortControllers.get(taskId) === abortController) {
      executionAbortControllers.delete(taskId);
    }

    // Save run record
    if (runRecord) {
      try {
        await addScriptRun(db, runRecord);
        await capRuns(db, taskId);
      } catch (err) {
        console.error(`[Cohand] Failed to save run record for ${taskId}:`, err);
      }

      // --- Self-healing on failure ---
      if (!runRecord.success && runRecord.version > 0) {
        try {
          const task = await getTask(db, taskId);
          if (task && !task.disabled) {
            const a11yTree = ctx.getA11yTree
              ? await ctx.getA11yTree(tabId)
              : undefined;

            await runSelfHealingLoop({
              task,
              failedVersion: runRecord.version,
              error: runRecord.error ?? 'Unknown error',
              tabId,
              db,
              executeVersion: async (version: ScriptVersion) => {
                try {
                  await cdp.attach(tabId);
                  const resp = await chrome.runtime.sendMessage({
                    type: 'SANDBOX_EXECUTE',
                    taskId,
                    source: version.source,
                    state: {},
                    tabId,
                  });
                  await cdp.detach(tabId);

                  // Apply output scanning (Layer 5) to self-healing executions too
                  if (resp?.ok) {
                    const resultScan = scanReturnValue(resp.result);
                    if (!resultScan.safe) {
                      return { success: false, error: `Return value blocked: ${resultScan.flags.join(', ')}` };
                    }
                    if (resp.state) {
                      const stateScan = scanState(resp.state);
                      if (!stateScan.safe) {
                        return { success: false, error: `State blocked: ${stateScan.flags.join(', ')}` };
                      }
                    }
                  }

                  return {
                    success: resp?.ok ?? false,
                    result: resp?.result,
                    error: resp?.ok ? undefined : resp?.error,
                  };
                } catch (execErr) {
                  try { await cdp.detach(tabId); } catch { /* ignore */ }
                  return {
                    success: false,
                    error: execErr instanceof Error ? execErr.message : String(execErr),
                  };
                }
              },
              model: ctx.repairModel,
              apiKey: ctx.repairApiKey,
              securityModels: ctx.securityModels,
              a11yTree,
            });
          }
        } catch (healErr) {
          console.error(`[Cohand] Self-healing failed for ${taskId}:`, healErr);
        }
      }
    }
  }
}
