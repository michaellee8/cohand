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
import type { ScriptRun } from '../types';
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
      const execResponse = await chrome.runtime.sendMessage({
        type: 'SANDBOX_EXECUTE',
        taskId,
        source: activeVersion.source,
        state: currentState,
        tabId,
      });

      if (abortController.signal.aborted) {
        throw new Error('Execution cancelled');
      }

      // Record successful run
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
    executionAbortControllers.delete(taskId);

    // Save run record
    if (runRecord) {
      await addScriptRun(db, runRecord);
      await capRuns(db, taskId);
    }
  }
}
