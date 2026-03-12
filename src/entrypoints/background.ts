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
  putRecording,
  putRecordingStep,
  deleteRecordingStep as dbDeleteRecordingStep,
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
  setCodexOAuthTokens,
  getEncryptionKeyEncoded,
  setEncryptionKeyEncoded,
} from '../lib/storage';
import { createRemoteHandler } from '../lib/remote/remote-server';
import { claimTab, releaseTab } from '../lib/remote/remote-relay';
import {
  addOAuthRedirectRule,
  removeOAuthRedirectRule,
  startAdaptiveMonitor,
  exchangeCodeForToken,
  generatePKCE,
  buildAuthUrl,
  cleanupStaleOAuthState,
} from '../lib/codex-oauth';
import {
  generateEncryptionKey,
  exportKey,
  importKey,
  encrypt,
} from '../lib/crypto';
import { validateAST } from '../lib/security/ast-validator';
import { executeTaskAsync } from '../lib/execution-orchestrator';
import type { ScriptVersion, ScriptRun, RecordingStep } from '../types';

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
  // Override domains for test executions (temp taskId -> domains)
  const testDomainOverrides = new Map<string, string[]>();

  // Recording port (long-lived connection from sidepanel)
  let recordingPort: chrome.runtime.Port | null = null;

  let db: IDBDatabase;
  let initPromise: Promise<void>;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  async function getTabUrl(tabId: number): Promise<string> {
    const tab = await chrome.tabs.get(tabId);
    return tab.url || '';
  }

  async function ensureOffscreen(): Promise<void> {
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
          // Check test domain overrides first (for TEST_SCRIPT temp tasks)
          const override = testDomainOverrides.get(taskId);
          if (override) return override;
          const task = await getTask(db, taskId);
          return task?.allowedDomains ?? [];
        },
        getTabUrl,
        getTabId: (taskId: string) => taskTabMap.get(taskId),
      };
      registerPageMethods(rpcHandler, handlerCtx);

      // Start listening for RPC connections (long-lived ports)
      rpcHandler.listen();

      // Listen for recording stream port connections
      chrome.runtime.onConnect.addListener((port) => {
        if (port.name === 'recording-stream') {
          recordingPort = port;
          port.onDisconnect.addListener(() => { recordingPort = null; });
        }
      });

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

      // Clean up any stale OAuth state from interrupted flows
      await cleanupStaleOAuthState();

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
        astValidationPassed: msg.astValidationPassed ?? false,
        securityReviewPassed: msg.securityReviewPassed ?? false,
        reviewDetails: msg.reviewDetails ?? [],
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
    executeTaskAsync(taskId, tabId, {
      db,
      taskTabMap,
      executionAbortControllers,
      claimTab,
      releaseTab,
      cdp,
      ensureOffscreen,
    }).catch(err =>
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

  // ---------------------------------------------------------------------------
  // Script generation (wizard flow)
  // ---------------------------------------------------------------------------

  router.on('GENERATE_SCRIPT', async (msg) => {
    // Return page observation data. Per the design doc, the side panel
    // makes all LLM calls — the wizard store handles script generation,
    // AST validation, and security review directly.
    const treeResponse = await chrome.tabs.sendMessage(msg.tabId, {
      type: 'GET_A11Y_TREE',
    });

    const tab = await chrome.tabs.get(msg.tabId);
    let screenshot: string | undefined;
    try {
      screenshot = await chrome.tabs.captureVisibleTab(tab.windowId!, { format: 'png' });
    } catch {
      // May fail on restricted pages
    }

    return {
      source: '',
      astValid: false,
      securityPassed: false,
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

    // Validate AST before test execution (H12)
    const validation = validateAST(source);
    if (!validation.valid) {
      return { ok: false, error: `AST validation failed: ${validation.errors.join(', ')}` };
    }

    try {
      // Claim tab
      if (!claimTab(tabId, 'local')) {
        return { ok: false, error: 'Tab under remote control' };
      }

      const tempTaskId = `test-${Date.now()}`;
      taskTabMap.set(tempTaskId, tabId);
      resetCumulativeReads(tempTaskId);
      testDomainOverrides.set(tempTaskId, domains ?? []);

      try {
        await ensureOffscreen();
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
        testDomainOverrides.delete(tempTaskId);
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
    if (tab.windowId == null) {
      return { dataUrl: null, error: 'Tab has no associated window' };
    }
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
        format: 'png',
      });
      return { dataUrl };
    } catch (err) {
      return {
        dataUrl: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
    await ensureOffscreen();
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
  // Recording
  // ---------------------------------------------------------------------------

  router.on('START_RECORDING', async (msg) => {
    const sessionId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await putRecording(db, {
      id: sessionId,
      startedAt: new Date().toISOString(),
      activeTabId: msg.tabId,
      trackedTabs: [msg.tabId],
      stepCount: 0,
    });
    return { ok: true as const, sessionId };
  });

  router.on('STOP_RECORDING', async (_msg) => {
    // Could update recording.completedAt here in future
    return { ok: true as const };
  });

  router.on('DELETE_RECORDING_STEP', async (msg) => {
    await dbDeleteRecordingStep(db, msg.stepId);
    return { ok: true as const };
  });

  router.on('RECORDING_ACTION', async (msg, sender) => {
    // Fire-and-forget enrichment (screenshot + persist + forward)
    // Return { ok: true } immediately; enrichment runs in background.
    (async () => {
      try {
        // Capture screenshot
        let screenshot: string | undefined;
        try {
          if (sender.tab?.windowId != null) {
            screenshot = await chrome.tabs.captureVisibleTab(
              sender.tab.windowId,
              { format: 'png' },
            );
          }
        } catch {
          // Screenshot may fail on restricted pages
        }

        const step: RecordingStep = {
          id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          recordingId: '', // Set by the sidepanel store
          sequenceIndex: 0, // Set by the sidepanel store
          status: 'enriched',
          ...msg.action,
          screenshot,
        };

        // Persist step to IndexedDB (without screenshot)
        const { screenshot: _, ...stepWithoutScreenshot } = step;
        await putRecordingStep(db, stepWithoutScreenshot as any);

        // Forward enriched step via recording port
        recordingPort?.postMessage({ type: 'RECORDING_STEP', step });
      } catch (err) {
        console.error('[Cohand] Failed to process recording action:', err);
      }
    })();

    return { ok: true as const };
  });

  // ---------------------------------------------------------------------------
  // OAuth
  // ---------------------------------------------------------------------------

  router.on('START_CODEX_OAUTH', async () => {
    const { verifier, challenge } = await generatePKCE();
    const state = crypto.randomUUID();
    await chrome.storage.local.set({
      _oauthPkce: { verifier, state, createdAt: Date.now() },
    });
    await addOAuthRedirectRule(chrome.runtime.id);
    const authUrl = buildAuthUrl(challenge, state);
    const tab = await chrome.tabs.create({ url: authUrl });
    if (tab.id) startAdaptiveMonitor(tab.id);
    return { ok: true as const };
  });

  router.on('OAUTH_CALLBACK', async (msg) => {
    const pkceData = (await chrome.storage.local.get('_oauthPkce'))._oauthPkce as
      | { verifier: string; state: string; createdAt: number }
      | undefined;
    if (!pkceData || pkceData.state !== msg.state) {
      throw new Error('Invalid OAuth state');
    }

    await removeOAuthRedirectRule();

    const creds = await exchangeCodeForToken(msg.code, pkceData.verifier);

    // Encrypt tokens before storage
    let keyEncoded = await getEncryptionKeyEncoded();
    if (!keyEncoded) {
      const cryptoKey = await generateEncryptionKey();
      keyEncoded = await exportKey(cryptoKey);
      await setEncryptionKeyEncoded(keyEncoded);
    }

    const key = await importKey(keyEncoded);
    await setCodexOAuthTokens({
      access: await encrypt(key, creds.access),
      refresh: await encrypt(key, creds.refresh),
      expires: creds.expires,
      accountId: creds.accountId,
    });

    await chrome.storage.local.remove('_oauthPkce');
    return { ok: true as const };
  });

  router.on('LOGOUT_CODEX', async () => {
    await setCodexOAuthTokens(null);
    return { ok: true as const };
  });

  // ---------------------------------------------------------------------------
  // Start listening
  // ---------------------------------------------------------------------------

  // Initialize async — gate message handling until init completes
  initPromise = init();
  router.setGate(initPromise);
  router.listen();
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
