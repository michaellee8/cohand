import { MessageRouter } from '../lib/message-router';
import { openDB } from '../lib/db';
import {
  putTask,
  getTask,
  getAllTasks,
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
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(err =>
    console.error('[Cohand] Failed to set panel behavior:', err),
  );

  // ---------------------------------------------------------------------------
  // Shared state
  // ---------------------------------------------------------------------------
  const cdp = new CDPManager();
  const rpcHandler = new RPCHandler();
  const router = new MessageRouter();

  // Track which tab is executing which task (taskId -> tabId)
  const taskTabMap = new Map<string, number>();

  // Write-through persistence for taskTabMap
  async function persistTaskTabMap(): Promise<void> {
    const obj = Object.fromEntries(taskTabMap);
    await chrome.storage.session.set({ taskTabMap: obj });
  }

  async function restoreTaskTabMap(): Promise<void> {
    try {
      const result = await chrome.storage.session.get('taskTabMap');
      if (result.taskTabMap && typeof result.taskTabMap === 'object') {
        for (const [k, v] of Object.entries(result.taskTabMap)) {
          if (typeof v === 'number') taskTabMap.set(k, v);
        }
      }
    } catch {}
  }

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

  let offscreenMutex: Promise<void> | null = null;

  async function ensureOffscreen(): Promise<void> {
    if (offscreenMutex) {
      await offscreenMutex;
      return;
    }
    offscreenMutex = (async () => {
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
    })();
    await offscreenMutex;
    offscreenMutex = null;
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

      // Restore taskTabMap from session storage (survives SW restarts)
      await restoreTaskTabMap();

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

      // Navigation capture: detect top-frame navigations while recording
      chrome.webNavigation.onCompleted.addListener((details) => {
        if (details.frameId !== 0) return; // top frame only
        if (!recordingPort) return; // not recording

        // Read active recording session to populate recordingId
        chrome.storage.session.get('activeRecording').then(result => {
          const activeRecording = result.activeRecording as
            | { sessionId: string; tabId: number }
            | undefined;
          const recordingId = activeRecording?.sessionId ?? '';

          const step: RecordingStep = {
            id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            recordingId,
            sequenceIndex: 0,
            status: 'enriched',
            action: 'navigate',
            url: details.url,
            pageTitle: undefined,
          };

          // Try to get the page title
          chrome.tabs.get(details.tabId).then(tab => {
            step.pageTitle = tab.title;
            recordingPort?.postMessage({ type: 'RECORDING_STEP', step });
            putRecordingStep(db, step as any).catch(err =>
              console.error('[Cohand] Failed to persist nav step:', err),
            );
          }).catch(() => {
            recordingPort?.postMessage({ type: 'RECORDING_STEP', step });
            putRecordingStep(db, step as any).catch(() => {});
          });
        }).catch(() => {});
      });

      console.log('[Cohand] Service worker initialized');
    } catch (err) {
      console.error('[Cohand] Init error:', err);
      throw err; // Rethrow so gate promise rejects and router refuses messages
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
    // Cascade delete related records in a single transaction
    const tx = db.transaction(
      ['tasks', 'script_versions', 'script_runs', 'task_state', 'state_snapshots', 'notifications', 'llm_usage'],
      'readwrite',
    );

    // Delete task itself
    tx.objectStore('tasks').delete(msg.taskId);

    // Delete related records via index cursor
    const deleteByCursor = (storeName: string, indexName: string, range: IDBKeyRange | IDBValidKey) => {
      const store = tx.objectStore(storeName);
      const index = store.index(indexName);
      const request = index.openCursor(range);
      request.onsuccess = () => {
        const cursor = request.result;
        if (cursor) { cursor.delete(); cursor.continue(); }
      };
    };

    // Simple-key indexes use IDBKeyRange.only; compound-key indexes use bound range
    deleteByCursor('script_versions', 'by_task', IDBKeyRange.only(msg.taskId));
    deleteByCursor('script_runs', 'by_task_time', IDBKeyRange.bound([msg.taskId], [msg.taskId, '\uffff']));
    deleteByCursor('state_snapshots', 'by_task', IDBKeyRange.only(msg.taskId));
    deleteByCursor('notifications', 'by_task_time', IDBKeyRange.bound([msg.taskId], [msg.taskId, '\uffff']));
    deleteByCursor('llm_usage', 'by_task', IDBKeyRange.bound([msg.taskId], [msg.taskId, '\uffff']));

    // Delete task state (keyed by taskId directly)
    tx.objectStore('task_state').delete(msg.taskId);

    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

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

  router.on('GET_SCRIPT_VERSIONS', async (msg) => {
    const versions = await getScriptVersionsForTask(db, msg.taskId);
    return { versions };
  });

  router.on('GET_TASK_STATE', async (msg) => {
    const state = await getTaskState(db, msg.taskId);
    return { state };
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
      onTaskTabMapChange: () => persistTaskTabMap().catch(() => {}),
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
      persistTaskTabMap().catch(() => {});
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
    try {
      const response = await chrome.tabs.sendMessage(msg.tabId, {
        type: 'GET_A11Y_TREE',
      });
      return { tree: response?.tree ?? response };
    } catch {
      // Content script injection failed (chrome://, Web Store, restricted pages).
      // Fall back to CDP Accessibility.queryAXTree.
      console.log(`[Cohand] Content script unavailable for tab ${msg.tabId}, falling back to CDP a11y`);
      try {
        await cdp.attach(msg.tabId);
        try {
          const docResult = await cdp.send(msg.tabId, 'DOM.getDocument', { depth: 0 }) as {
            root: { backendNodeId: number };
          };
          const axResult = await cdp.send(msg.tabId, 'Accessibility.queryAXTree', {
            backendNodeId: docResult.root.backendNodeId,
          }) as {
            nodes?: Array<{
              role?: { value?: string };
              name?: { value?: string };
              nodeId?: string;
              properties?: unknown[];
            }>;
          };

          const cdpNodes = axResult?.nodes ?? [];
          const tree = cdpNodes.length > 0
            ? {
                role: 'document',
                name: 'CDP Fallback Tree',
                refId: '',
                children: cdpNodes
                  .filter(n => n.role?.value && n.role.value !== 'none' && n.role.value !== 'ignored')
                  .map(n => ({
                    role: n.role?.value ?? 'generic',
                    name: n.name?.value ?? '',
                    refId: n.nodeId ?? '',
                  })),
              }
            : null;
          return { tree };
        } finally {
          await cdp.detach(msg.tabId);
        }
      } catch (cdpErr) {
        console.error(`[Cohand] CDP a11y fallback failed for tab ${msg.tabId}:`, cdpErr);
        return { tree: null };
      }
    }
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

  // CDP_COMMAND — arbitrary CDP command passthrough for Remote mode
  router.on('CDP_COMMAND', async (msg) => {
    try {
      if (!cdp.isAttached(msg.tabId)) {
        return { ok: false, error: `Tab ${msg.tabId} not attached` };
      }
      const result = await cdp.send(msg.tabId, msg.method, msg.params);
      return { ok: true, result };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
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
    const sessionId = `rec-${crypto.randomUUID()}`;
    await putRecording(db, {
      id: sessionId,
      startedAt: new Date().toISOString(),
      activeTabId: msg.tabId,
      trackedTabs: [msg.tabId],
      stepCount: 0,
    });
    // Persist active recording session info so webNavigation listener can
    // associate navigation events with the current recording session
    await chrome.storage.session.set({
      activeRecording: { sessionId, tabId: msg.tabId },
    });
    return { ok: true as const, sessionId };
  });

  router.on('STOP_RECORDING', async (_msg) => {
    // Clear active recording session info from storage
    await chrome.storage.session.remove('activeRecording');
    return { ok: true as const };
  });

  router.on('DELETE_RECORDING_STEP', async (msg) => {
    await dbDeleteRecordingStep(db, msg.stepId);
    return { ok: true as const };
  });

  router.on('RECORDING_ACTION', async (msg, sender) => {
    // Validate action type to reject unexpected values
    const ALLOWED_ACTION_TYPES = ['click', 'type', 'navigate'] as const;
    type AllowedAction = (typeof ALLOWED_ACTION_TYPES)[number];
    if (!ALLOWED_ACTION_TYPES.includes(msg.action?.action as AllowedAction)) {
      console.warn('[Cohand] Invalid recording action type:', msg.action?.action);
      return { ok: true as const };
    }

    // Sanitize: extract only known fields from msg.action (never spread untrusted data)
    const raw = msg.action;
    const sanitizedAction: Omit<RecordingStep, 'id' | 'recordingId' | 'sequenceIndex' | 'status' | 'screenshot'> = {
      action: raw.action,
      ...(raw.timestamp !== undefined && { timestamp: raw.timestamp }),
      ...(raw.selector !== undefined && { selector: raw.selector }),
      ...(raw.elementTag !== undefined && { elementTag: raw.elementTag }),
      ...(raw.elementText !== undefined && { elementText: raw.elementText }),
      ...(raw.elementAttributes !== undefined && { elementAttributes: raw.elementAttributes }),
      ...(raw.elementRole !== undefined && { elementRole: raw.elementRole }),
      ...(raw.a11ySubtree !== undefined && { a11ySubtree: raw.a11ySubtree }),
      ...(raw.typedText !== undefined && { typedText: raw.typedText }),
      ...(raw.url !== undefined && { url: raw.url }),
      ...(raw.pageTitle !== undefined && { pageTitle: raw.pageTitle }),
      ...(raw.viewportDimensions !== undefined && { viewportDimensions: raw.viewportDimensions }),
      ...(raw.clickPositionHint !== undefined && { clickPositionHint: raw.clickPositionHint }),
    };

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
          ...sanitizedAction,
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

  router.on('KEYSTROKE_UPDATE', async (msg) => {
    // Only process if recording is active (port connected)
    if (!recordingPort) return { ok: true as const };

    // Only create a recording step for final keystrokes (focus left the field)
    if (!msg.isFinal) return { ok: true as const };

    const step: RecordingStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recordingId: '',
      sequenceIndex: 0,
      status: 'enriched',
      action: 'type',
      selector: msg.element.selector,
      elementTag: msg.element.tag,
      elementText: msg.element.name,
      typedText: msg.text,
    };

    // Persist and forward
    await putRecordingStep(db, step as any);
    recordingPort?.postMessage({ type: 'RECORDING_STEP', step });

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
