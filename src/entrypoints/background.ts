import { MessageRouter } from '../lib/message-router';
import { openDB } from '../lib/db';
import {
  putTask,
  getTask,
  getAllTasks,
  deleteTask as dbDeleteTask,
  putScriptVersion,
  getScriptVersionsForTask,
  capScriptVersions,
  getRunsForTask,
  addScriptRun,
  capRuns,
  putTaskState,
  getTaskState,
  putStateSnapshot,
  capStateSnapshots,
} from '../lib/db-helpers';
import {
  getRecentNotifications,
  markAsRead,
  getUnreadCount,
} from '../lib/notifications';
import { getUsageSummary, pruneOldUsage } from '../lib/llm-usage';
import { CDPManager } from '../lib/cdp';
import { RPCHandler } from '../lib/rpc-handler';
import { registerPageMethods, resetCumulativeReads, type HandlerContext } from '../lib/humanized-page-handler';
import {
  scheduleTask,
  unscheduleTask,
  syncSchedules,
  createAlarmHandler,
  openTaskExecutionWindow,
} from '../lib/scheduler';
import {
  addDomainPermission,
  removeDomainPermission,
  migrateStorage,
} from '../lib/storage';
import { createRemoteHandler } from '../lib/remote/remote-server';
import { claimTab, releaseTab } from '../lib/remote/remote-relay';
import type { ScriptVersion, ScriptRun } from '../types';

export default defineBackground(() => {
  console.log('[Cohand] Service worker started');
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });

  // ---------------------------------------------------------------------------
  // Shared state
  // ---------------------------------------------------------------------------
  const cdp = new CDPManager();
  const rpcHandler = new RPCHandler();
  const router = new MessageRouter();

  // Track which tab is executing which task (taskId -> tabId)
  const taskTabMap = new Map<string, number>();
  // Track in-flight execution abort controllers
  const executionAbortControllers = new Map<string, AbortController>();

  let db: IDBDatabase;

  // ---------------------------------------------------------------------------
  // Helper: get tab URL
  // ---------------------------------------------------------------------------
  async function getTabUrl(tabId: number): Promise<string> {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------
  async function init() {
    try {
      // Migrate chrome.storage.local schema
      await migrateStorage();

      // Open IndexedDB
      db = await openDB();

      // Set up CDP listeners (navigation detection)
      cdp.setupListeners();

      // Register humanized page RPC methods
      const handlerCtx: HandlerContext = {
        cdp,
        getAllowedDomains: async (taskId: string) => {
          const task = await getTask(db, taskId);
          return task?.allowedDomains ?? [];
        },
        getTabUrl,
        getTabId: (taskId: string) => taskTabMap.get(taskId),
      };
      registerPageMethods(rpcHandler, handlerCtx);

      // Start listening for RPC connections (long-lived ports)
      rpcHandler.listen();

      // Register remote mode handler
      const remoteHandler = createRemoteHandler(cdp, getTabUrl);
      chrome.runtime.onMessageExternal.addListener(remoteHandler);

      // Sync alarm schedules with DB tasks
      const tasks = await getAllTasks(db);
      await syncSchedules(tasks);

      // Register alarm handler for scheduled tasks
      const alarmHandler = createAlarmHandler(async (taskId: string) => {
        console.log(`[Cohand] Alarm fired for task ${taskId}`);
        await openTaskExecutionWindow(taskId);
      });
      chrome.alarms.onAlarm.addListener(alarmHandler);

      // Prune old LLM usage on startup
      pruneOldUsage(db).catch(err =>
        console.error('[Cohand] Failed to prune LLM usage:', err),
      );

      console.log('[Cohand] Service worker initialized');
    } catch (err) {
      console.error('[Cohand] Init error:', err);
    }
  }

  // ---------------------------------------------------------------------------
  // Task CRUD handlers
  // ---------------------------------------------------------------------------

  router.on('CREATE_TASK', async (msg) => {
    await putTask(db, msg.task);

    // If scriptSource provided, create initial script version
    if (msg.scriptSource) {
      const sv: ScriptVersion = {
        id: `${msg.task.id}:v1`,
        taskId: msg.task.id,
        version: 1,
        source: msg.scriptSource,
        checksum: await sha256(msg.scriptSource),
        generatedBy: 'explorer',
        astValidationPassed: true, // validated before reaching here
        securityReviewPassed: true,
        reviewDetails: [],
        createdAt: new Date().toISOString(),
      };
      await putScriptVersion(db, sv);
    }

    // Initialize empty state
    await putTaskState(db, {
      taskId: msg.task.id,
      state: {},
      updatedAt: new Date().toISOString(),
    });

    // Schedule if interval
    await scheduleTask(msg.task);

    return { ok: true as const };
  });

  router.on('UPDATE_TASK', async (msg) => {
    await putTask(db, msg.task);
    await scheduleTask(msg.task);
    return { ok: true as const };
  });

  router.on('DELETE_TASK', async (msg) => {
    await dbDeleteTask(db, msg.taskId);
    await unscheduleTask(msg.taskId);
    // Cancel any in-flight execution
    executionAbortControllers.get(msg.taskId)?.abort();
    executionAbortControllers.delete(msg.taskId);
    taskTabMap.delete(msg.taskId);
    return { ok: true as const };
  });

  router.on('GET_TASKS', async () => {
    const tasks = await getAllTasks(db);
    return { tasks };
  });

  router.on('GET_TASK', async (msg) => {
    const task = await getTask(db, msg.taskId);
    return { task };
  });

  // ---------------------------------------------------------------------------
  // Script runs
  // ---------------------------------------------------------------------------

  router.on('GET_RUNS', async (msg) => {
    const runs = await getRunsForTask(db, msg.taskId, msg.limit ?? 20);
    return { runs };
  });

  // ---------------------------------------------------------------------------
  // Script execution
  // ---------------------------------------------------------------------------

  router.on('EXECUTE_TASK', async (msg) => {
    const { taskId, tabId } = msg;

    // Fire and forget — execution runs asynchronously
    executeTaskAsync(taskId, tabId).catch(err =>
      console.error(`[Cohand] Execution error for task ${taskId}:`, err),
    );

    return { ok: true as const };
  });

  router.on('CANCEL_EXECUTION', async (msg) => {
    const controller = executionAbortControllers.get(msg.taskId);
    if (controller) {
      controller.abort();
      executionAbortControllers.delete(msg.taskId);
    }
    return { ok: true as const };
  });

  async function executeTaskAsync(taskId: string, tabId: number): Promise<void> {
    const abortController = new AbortController();
    executionAbortControllers.set(taskId, abortController);

    const startTime = Date.now();
    let runRecord: ScriptRun | undefined;

    try {
      // Claim tab for local execution
      if (!claimTab(tabId, 'local')) {
        throw new Error('Tab is already under remote control');
      }

      // Map task to tab
      taskTabMap.set(taskId, tabId);
      resetCumulativeReads(taskId);

      // Get task and active script
      const task = await getTask(db, taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);

      const versions = await getScriptVersionsForTask(db, taskId);
      const activeVersion = versions.find(v => v.version === task.activeScriptVersion);
      if (!activeVersion) throw new Error(`Script version ${task.activeScriptVersion} not found`);

      // Get current state
      const taskState = await getTaskState(db, taskId);
      const currentState = taskState?.state ?? {};

      // Attach debugger
      await cdp.attach(tabId);

      try {
        // Execute via offscreen/sandbox bridge (the offscreen doc handles this
        // via the long-lived port RPC mechanism)
        // For now, create a run record. The actual script execution flows through
        // the sandbox -> offscreen -> RPC -> service worker pipeline.
        // The service worker's role here is to set up the context and record results.

        // Send execution request to offscreen document via chrome.runtime messaging
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
      // Always clean up
      releaseTab(tabId);
      taskTabMap.delete(taskId);
      executionAbortControllers.delete(taskId);

      // Save run record
      if (runRecord) {
        await addScriptRun(db, runRecord);
        await capRuns(db, taskId);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Script generation (wizard flow)
  // ---------------------------------------------------------------------------

  router.on('GENERATE_SCRIPT', async (msg) => {
    // Forward a11y tree request to content script
    const treeResponse = await chrome.tabs.sendMessage(msg.tabId, {
      type: 'GET_A11Y_TREE',
    });

    // Get screenshot
    const tab = await chrome.tabs.get(msg.tabId);
    let screenshot: string | undefined;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
    } catch {
      // May fail on restricted pages
    }

    // The actual LLM call happens in the side panel (per design doc).
    // This handler returns the observation data for the side panel to use.
    // However, the wizard store expects source back, so we return observation data
    // and the side panel will call the LLM from there.
    return {
      source: '',
      astValid: false,
      securityPassed: false,
      // Observation data attached for the side panel
      observation: {
        a11yTree: JSON.stringify(treeResponse?.tree ?? treeResponse, null, 2),
        screenshot,
        url: tab.url || '',
        title: tab.title || '',
      },
    } as any;
  });

  router.on('TEST_SCRIPT', async (msg) => {
    const { tabId, source, domains } = msg;

    try {
      // Claim tab
      if (!claimTab(tabId, 'local')) {
        return { ok: false, error: 'Tab under remote control' };
      }

      const tempTaskId = `test-${Date.now()}`;
      taskTabMap.set(tempTaskId, tabId);
      resetCumulativeReads(tempTaskId);

      try {
        await cdp.attach(tabId);
        try {
          // Execute test via sandbox
          const result = await chrome.runtime.sendMessage({
            type: 'SANDBOX_EXECUTE',
            taskId: tempTaskId,
            source,
            state: {},
            tabId,
          });

          return {
            ok: result?.ok ?? false,
            result: result?.result,
            error: result?.error,
          };
        } finally {
          await cdp.detach(tabId);
        }
      } finally {
        taskTabMap.delete(tempTaskId);
        releaseTab(tabId);
      }
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // ---------------------------------------------------------------------------
  // Page observation
  // ---------------------------------------------------------------------------

  router.on('GET_A11Y_TREE', async (msg) => {
    const response = await chrome.tabs.sendMessage(msg.tabId, {
      type: 'GET_A11Y_TREE',
    });
    return { tree: response?.tree ?? response };
  });

  router.on('SCREENSHOT', async (msg) => {
    const tab = await chrome.tabs.get(msg.tabId);
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId!, {
      format: 'png',
    });
    return { dataUrl };
  });

  // ---------------------------------------------------------------------------
  // CDP control
  // ---------------------------------------------------------------------------

  router.on('ATTACH_DEBUGGER', async (msg) => {
    await cdp.attach(msg.tabId);
    return { ok: true as const };
  });

  router.on('DETACH_DEBUGGER', async (msg) => {
    await cdp.detach(msg.tabId);
    return { ok: true as const };
  });

  // ---------------------------------------------------------------------------
  // Notifications
  // ---------------------------------------------------------------------------

  router.on('GET_NOTIFICATIONS', async (msg) => {
    const notifications = await getRecentNotifications(db, msg.limit ?? 50);
    return { notifications };
  });

  router.on('MARK_NOTIFICATION_READ', async (msg) => {
    await markAsRead(db, msg.notificationId);
    return { ok: true as const };
  });

  router.on('GET_UNREAD_COUNT', async () => {
    const count = await getUnreadCount(db);
    return { count };
  });

  // ---------------------------------------------------------------------------
  // LLM Usage
  // ---------------------------------------------------------------------------

  router.on('GET_USAGE_SUMMARY', async (msg) => {
    const summary = await getUsageSummary(db, msg.sinceDaysAgo ?? 30);
    return { summary };
  });

  // ---------------------------------------------------------------------------
  // Offscreen document
  // ---------------------------------------------------------------------------

  router.on('ENSURE_OFFSCREEN', async () => {
    try {
      const existingContexts = await chrome.runtime.getContexts({
        contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT],
      });
      if (existingContexts.length === 0) {
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: [chrome.offscreen.Reason.WORKERS],
          justification: 'QuickJS WASM sandbox for script execution',
        });
      }
    } catch (err) {
      console.error('[Cohand] Failed to create offscreen document:', err);
    }
    return { ok: true as const };
  });

  // ---------------------------------------------------------------------------
  // Domain permissions
  // ---------------------------------------------------------------------------

  router.on('ADD_DOMAIN_PERMISSION', async (msg) => {
    await addDomainPermission(msg.permission);
    return { ok: true as const };
  });

  router.on('REMOVE_DOMAIN_PERMISSION', async (msg) => {
    await removeDomainPermission(msg.domain);
    return { ok: true as const };
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------
  router.listen();

  // Initialize async
  init();
});

// ---------------------------------------------------------------------------
// Utility
// ---------------------------------------------------------------------------

async function sha256(text: string): Promise<string> {
  const data = new TextEncoder().encode(text);
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}
