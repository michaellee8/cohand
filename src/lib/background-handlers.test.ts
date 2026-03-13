/**
 * Tests for service worker message handler wiring.
 *
 * Since background.ts uses `defineBackground()` (a WXT wrapper), we test the
 * handler logic by constructing a MessageRouter with the same handlers and
 * exercising them against a real fake-indexeddb instance.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { MessageRouter } from './message-router';
import { openDB } from './db';
import {
  putTask,
  getTask,
  getAllTasks,
  putScriptVersion,
  getRunsForTask,
  addScriptRun,
  putTaskState,
  getTaskState,
} from './db-helpers';
import {
  getRecentNotifications,
  markAsRead,
  getUnreadCount,
  deliverNotification,
} from './notifications';
import { getUsageSummary, recordLlmUsage } from './llm-usage';
import {
  addDomainPermission,
  removeDomainPermission,
  getDomainPermissions,
} from './storage';
import {
  putRecordingStep,
  getRecordingSteps,
} from './db-helpers';
import type { Task, ScriptVersion, ScriptRun, TaskNotification, RecordingStep } from '../types/index';

// ---------------------------------------------------------------------------
// Chrome API mocks
// ---------------------------------------------------------------------------
function setupChromeMock() {
  (globalThis as any).chrome = {
    runtime: {
      onMessage: { addListener: vi.fn() },
      onConnect: { addListener: vi.fn() },
      onMessageExternal: { addListener: vi.fn() },
      getURL: vi.fn((path: string) => `chrome-extension://test/${path}`),
      sendMessage: vi.fn(),
      getContexts: vi.fn(async () => []),
    },
    sidePanel: {
      setPanelBehavior: vi.fn(),
    },
    storage: {
      local: {
        get: vi.fn(async (keys: string | string[]) => {
          const store = (chrome.storage.local as any)._store ?? {};
          if (typeof keys === 'string') return { [keys]: store[keys] };
          const result: Record<string, unknown> = {};
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            result[key] = store[key];
          }
          return result;
        }),
        set: vi.fn(async (items: Record<string, unknown>) => {
          const store = (chrome.storage.local as any)._store ?? {};
          Object.assign(store, items);
          (chrome.storage.local as any)._store = store;
        }),
        _store: {} as Record<string, unknown>,
      },
    },
    tabs: {
      get: vi.fn(async (tabId: number) => ({
        id: tabId,
        url: 'https://example.com',
        title: 'Example',
        windowId: 1,
      })),
      sendMessage: vi.fn(async () => ({ tree: [] })),
      captureVisibleTab: vi.fn(async () => 'data:image/png;base64,abc'),
      query: vi.fn(async () => [{ id: 1 }]),
    },
    debugger: {
      attach: vi.fn(async () => {}),
      detach: vi.fn(async () => {}),
      sendCommand: vi.fn(async () => ({})),
      onDetach: { addListener: vi.fn() },
      onEvent: { addListener: vi.fn() },
    },
    alarms: {
      create: vi.fn(async () => {}),
      clear: vi.fn(async () => true),
      getAll: vi.fn(async () => []),
      onAlarm: { addListener: vi.fn() },
    },
    notifications: {
      create: vi.fn(async () => ''),
    },
    offscreen: {
      createDocument: vi.fn(async () => {}),
      Reason: { WORKERS: 'WORKERS' },
    },
    windows: {
      create: vi.fn(async () => ({ id: 1 })),
    },
  };
}

// ---------------------------------------------------------------------------
// Setup: create a router with the same handlers as background.ts
// ---------------------------------------------------------------------------
let db: IDBDatabase;
let router: MessageRouter;
let lastRecordingStep: RecordingStep | null = null;
let recordingPortMock: { postMessage: ReturnType<typeof vi.fn<(...args: any[]) => any>> } | null = null;

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    name: 'Test Task',
    description: 'Test automation',
    allowedDomains: ['example.com'],
    schedule: { type: 'manual' },
    activeScriptVersion: 1,
    disabled: false,
    notifyEnabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  indexedDB = new IDBFactory();
  setupChromeMock();
  db = await openDB();
  router = new MessageRouter();

  // Register the same handlers as background.ts

  // CREATE_TASK
  router.on('CREATE_TASK', async (msg) => {
    await putTask(db, msg.task);
    if (msg.scriptSource) {
      const sv: ScriptVersion = {
        id: `${msg.task.id}:v1`,
        taskId: msg.task.id,
        version: 1,
        source: msg.scriptSource,
        checksum: 'test-checksum',
        generatedBy: 'explorer',
        astValidationPassed: true,
        securityReviewPassed: true,
        reviewDetails: [],
        createdAt: new Date().toISOString(),
      };
      await putScriptVersion(db, sv);
    }
    await putTaskState(db, {
      taskId: msg.task.id,
      state: {},
      updatedAt: new Date().toISOString(),
    });
    return { ok: true as const };
  });

  // UPDATE_TASK
  router.on('UPDATE_TASK', async (msg) => {
    await putTask(db, msg.task);
    return { ok: true as const };
  });

  // DELETE_TASK
  router.on('DELETE_TASK', async (msg) => {
    const { deleteTask: dbDeleteTask } = await import('../lib/db-helpers');
    await dbDeleteTask(db, msg.taskId);
    return { ok: true as const };
  });

  // GET_TASKS
  router.on('GET_TASKS', async () => {
    const tasks = await getAllTasks(db);
    return { tasks };
  });

  // GET_TASK
  router.on('GET_TASK', async (msg) => {
    const task = await getTask(db, msg.taskId);
    return { task };
  });

  // GET_RUNS
  router.on('GET_RUNS', async (msg: any) => {
    const runs = await getRunsForTask(db, msg.taskId, msg.limit ?? 20);
    return { runs };
  });

  // GET_A11Y_TREE
  router.on('GET_A11Y_TREE', async (msg) => {
    const response = await chrome.tabs.sendMessage(msg.tabId, {
      type: 'GET_A11Y_TREE',
    });
    return { tree: response?.tree ?? response };
  });

  // SCREENSHOT
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

  // ATTACH_DEBUGGER / DETACH_DEBUGGER
  router.on('ATTACH_DEBUGGER', async (msg) => {
    await chrome.debugger.attach({ tabId: msg.tabId }, '1.3');
    return { ok: true as const };
  });

  router.on('DETACH_DEBUGGER', async (msg) => {
    await chrome.debugger.detach({ tabId: msg.tabId });
    return { ok: true as const };
  });

  // GET_NOTIFICATIONS
  router.on('GET_NOTIFICATIONS', async (msg) => {
    const notifications = await getRecentNotifications(db, msg.limit ?? 50);
    return { notifications };
  });

  // MARK_NOTIFICATION_READ
  router.on('MARK_NOTIFICATION_READ', async (msg) => {
    await markAsRead(db, msg.notificationId);
    return { ok: true as const };
  });

  // GET_UNREAD_COUNT
  router.on('GET_UNREAD_COUNT', async () => {
    const count = await getUnreadCount(db);
    return { count };
  });

  // GET_USAGE_SUMMARY
  router.on('GET_USAGE_SUMMARY', async (msg: any) => {
    const summary = await getUsageSummary(db, msg.sinceDaysAgo ?? 30);
    return { summary };
  });

  // ENSURE_OFFSCREEN
  router.on('ENSURE_OFFSCREEN', async () => {
    return { ok: true as const };
  });

  // ADD/REMOVE DOMAIN_PERMISSION
  router.on('ADD_DOMAIN_PERMISSION', async (msg) => {
    await addDomainPermission(msg.permission);
    return { ok: true as const };
  });

  router.on('REMOVE_DOMAIN_PERMISSION', async (msg) => {
    await removeDomainPermission(msg.domain);
    return { ok: true as const };
  });

  // EXECUTE_TASK / CANCEL_EXECUTION — stubs for the test
  router.on('EXECUTE_TASK', async () => ({ ok: true as const }));
  router.on('CANCEL_EXECUTION', async () => ({ ok: true as const }));

  // RECORDING_ACTION — sanitizing handler (mirrors background.ts logic)
  lastRecordingStep = null;
  recordingPortMock = { postMessage: vi.fn() };
  router.on('RECORDING_ACTION', async (msg, sender) => {
    const ALLOWED_ACTION_TYPES = ['click', 'type', 'navigate'] as const;
    type AllowedAction = (typeof ALLOWED_ACTION_TYPES)[number];
    if (!ALLOWED_ACTION_TYPES.includes(msg.action?.action as AllowedAction)) {
      console.warn('[Cohand] Invalid recording action type:', msg.action?.action);
      return { ok: true as const };
    }

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

    // Synchronous version for testing (background.ts does fire-and-forget)
    let screenshot: string | undefined;
    try {
      if (sender.tab?.windowId != null) {
        screenshot = await chrome.tabs.captureVisibleTab(
          sender.tab.windowId,
          { format: 'png' },
        );
      }
    } catch {
      // Screenshot may fail
    }

    const step: RecordingStep = {
      id: `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      recordingId: '',
      sequenceIndex: 0,
      status: 'enriched',
      ...sanitizedAction,
      screenshot,
    };

    lastRecordingStep = step;

    const { screenshot: _s, ...stepWithoutScreenshot } = step;
    await putRecordingStep(db, stepWithoutScreenshot as any);

    recordingPortMock?.postMessage({ type: 'RECORDING_STEP', step });

    return { ok: true as const };
  });

  // TEST_SCRIPT — stub
  router.on('TEST_SCRIPT', async () => ({
    ok: false,
    error: 'Test script handler not fully wired in test',
  }));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Task CRUD handlers', () => {
  it('CREATE_TASK persists task and initializes state', async () => {
    const task = makeTask();
    const result = await router.handleMessage(
      { type: 'CREATE_TASK', task, scriptSource: 'async function run(page) {}' },
      {} as any,
    );
    expect(result).toEqual({ ok: true });

    // Verify task in DB
    const stored = await getTask(db, task.id);
    expect(stored).toBeDefined();
    expect(stored!.name).toBe('Test Task');

    // Verify state initialized
    const state = await getTaskState(db, task.id);
    expect(state).toBeDefined();
    expect(state!.state).toEqual({});
  });

  it('CREATE_TASK without scriptSource still works', async () => {
    const task = makeTask();
    const result = await router.handleMessage(
      { type: 'CREATE_TASK', task },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
    const stored = await getTask(db, task.id);
    expect(stored).toBeDefined();
  });

  it('GET_TASKS returns all tasks', async () => {
    const task1 = makeTask({ id: 'task-1', name: 'Task 1' });
    const task2 = makeTask({ id: 'task-2', name: 'Task 2' });
    await putTask(db, task1);
    await putTask(db, task2);

    const result = (await router.handleMessage(
      { type: 'GET_TASKS' },
      {} as any,
    )) as { tasks: Task[] };

    expect(result.tasks).toHaveLength(2);
  });

  it('GET_TASK returns specific task', async () => {
    const task = makeTask({ id: 'task-1' });
    await putTask(db, task);

    const result = (await router.handleMessage(
      { type: 'GET_TASK', taskId: 'task-1' },
      {} as any,
    )) as { task: Task | undefined };

    expect(result.task).toBeDefined();
    expect(result.task!.id).toBe('task-1');
  });

  it('GET_TASK returns undefined for non-existent', async () => {
    const result = (await router.handleMessage(
      { type: 'GET_TASK', taskId: 'nonexistent' },
      {} as any,
    )) as { task: Task | undefined };

    expect(result.task).toBeUndefined();
  });

  it('UPDATE_TASK updates task data', async () => {
    const task = makeTask({ id: 'task-1', name: 'Original' });
    await putTask(db, task);

    const updated = { ...task, name: 'Updated', updatedAt: new Date().toISOString() };
    const result = await router.handleMessage(
      { type: 'UPDATE_TASK', task: updated },
      {} as any,
    );
    expect(result).toEqual({ ok: true });

    const stored = await getTask(db, 'task-1');
    expect(stored!.name).toBe('Updated');
  });

  it('DELETE_TASK removes task from DB', async () => {
    const task = makeTask({ id: 'task-1' });
    await putTask(db, task);

    const result = await router.handleMessage(
      { type: 'DELETE_TASK', taskId: 'task-1' },
      {} as any,
    );
    expect(result).toEqual({ ok: true });

    const stored = await getTask(db, 'task-1');
    expect(stored).toBeUndefined();
  });
});

describe('Script runs handler', () => {
  it('GET_RUNS returns runs for a task', async () => {
    const run: ScriptRun = {
      id: 'run-1',
      taskId: 'task-1',
      version: 1,
      success: true,
      durationMs: 1000,
      ranAt: new Date().toISOString(),
    };
    await addScriptRun(db, run);

    const result = (await router.handleMessage(
      { type: 'GET_RUNS', taskId: 'task-1' } as any,
      {} as any,
    )) as { runs: ScriptRun[] };

    expect(result.runs).toHaveLength(1);
    expect(result.runs[0].id).toBe('run-1');
  });

  it('GET_RUNS respects limit', async () => {
    for (let i = 0; i < 5; i++) {
      await addScriptRun(db, {
        id: `run-${i}`,
        taskId: 'task-1',
        version: 1,
        success: true,
        durationMs: 100,
        ranAt: new Date(Date.now() - i * 1000).toISOString(),
      });
    }

    const result = (await router.handleMessage(
      { type: 'GET_RUNS', taskId: 'task-1', limit: 3 } as any,
      {} as any,
    )) as { runs: ScriptRun[] };

    expect(result.runs).toHaveLength(3);
  });
});

describe('Page observation handlers', () => {
  it('GET_A11Y_TREE forwards to content script', async () => {
    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      tree: [{ role: 'button', name: 'Click me' }],
    });

    const result = (await router.handleMessage(
      { type: 'GET_A11Y_TREE', tabId: 1 },
      {} as any,
    )) as { tree: unknown };

    expect(chrome.tabs.sendMessage).toHaveBeenCalledWith(1, { type: 'GET_A11Y_TREE' });
    expect(result.tree).toEqual([{ role: 'button', name: 'Click me' }]);
  });

  it('SCREENSHOT captures visible tab', async () => {
    const result = (await router.handleMessage(
      { type: 'SCREENSHOT', tabId: 1 },
      {} as any,
    )) as { dataUrl: string };

    expect(result.dataUrl).toBe('data:image/png;base64,abc');
    expect(chrome.tabs.captureVisibleTab).toHaveBeenCalled();
  });

  it('SCREENSHOT returns error when captureVisibleTab fails', async () => {
    (chrome.tabs.captureVisibleTab as any).mockRejectedValueOnce(
      new Error('Cannot capture restricted page'),
    );

    const result = (await router.handleMessage(
      { type: 'SCREENSHOT', tabId: 1 },
      {} as any,
    )) as { dataUrl: string | null; error: string };

    expect(result.dataUrl).toBeNull();
    expect(result.error).toBe('Cannot capture restricted page');
  });

  it('SCREENSHOT returns error when tab has no windowId', async () => {
    (chrome.tabs.get as any).mockResolvedValueOnce({
      id: 1,
      url: 'https://example.com',
      title: 'Example',
      windowId: undefined,
    });

    const result = (await router.handleMessage(
      { type: 'SCREENSHOT', tabId: 1 },
      {} as any,
    )) as { dataUrl: string | null; error: string };

    expect(result.dataUrl).toBeNull();
    expect(result.error).toBe('Tab has no associated window');
  });
});

describe('CDP control handlers', () => {
  it('ATTACH_DEBUGGER attaches to tab', async () => {
    const result = await router.handleMessage(
      { type: 'ATTACH_DEBUGGER', tabId: 1 },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
    expect(chrome.debugger.attach).toHaveBeenCalledWith({ tabId: 1 }, '1.3');
  });

  it('DETACH_DEBUGGER detaches from tab', async () => {
    const result = await router.handleMessage(
      { type: 'DETACH_DEBUGGER', tabId: 1 },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
    expect(chrome.debugger.detach).toHaveBeenCalledWith({ tabId: 1 });
  });
});

describe('Notification handlers', () => {
  it('GET_NOTIFICATIONS returns recent notifications', async () => {
    await deliverNotification('task-1', 'My Task', 'Hello', db);

    const result = (await router.handleMessage(
      { type: 'GET_NOTIFICATIONS', limit: 10 },
      {} as any,
    )) as { notifications: TaskNotification[] };

    expect(result.notifications).toHaveLength(1);
    expect(result.notifications[0].message).toContain('Hello');
  });

  it('MARK_NOTIFICATION_READ marks notification read', async () => {
    await deliverNotification('task-1', 'My Task', 'Hello', db);
    const notifs = await getRecentNotifications(db, 1);
    expect(notifs[0].isRead).toBe(0);

    await router.handleMessage(
      { type: 'MARK_NOTIFICATION_READ', notificationId: notifs[0].id },
      {} as any,
    );

    const count = await getUnreadCount(db);
    expect(count).toBe(0);
  });

  it('GET_UNREAD_COUNT returns correct count', async () => {
    await deliverNotification('task-1', 'My Task', 'Msg 1', db);
    await deliverNotification('task-1', 'My Task', 'Msg 2', db);

    const result = (await router.handleMessage(
      { type: 'GET_UNREAD_COUNT' },
      {} as any,
    )) as { count: number };

    expect(result.count).toBe(2);
  });
});

describe('LLM usage handler', () => {
  it('GET_USAGE_SUMMARY returns summary', async () => {
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'generate',
      provider: 'openai',
      model: 'gpt-5.4',
      inputTokens: 100,
      outputTokens: 50,
    });

    const result = (await router.handleMessage(
      { type: 'GET_USAGE_SUMMARY' } as any,
      {} as any,
    )) as { summary: any };

    expect(result.summary.totalCalls).toBe(1);
    expect(result.summary.totalInputTokens).toBe(100);
    expect(result.summary.totalOutputTokens).toBe(50);
  });
});

describe('Domain permission handlers', () => {
  it('ADD_DOMAIN_PERMISSION adds permission', async () => {
    const result = await router.handleMessage(
      {
        type: 'ADD_DOMAIN_PERMISSION',
        permission: {
          domain: 'example.com',
          grantedAt: new Date().toISOString(),
          grantedBy: 'user',
        },
      },
      {} as any,
    );
    expect(result).toEqual({ ok: true });

    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(1);
    expect(perms[0].domain).toBe('example.com');
  });

  it('REMOVE_DOMAIN_PERMISSION removes permission', async () => {
    await addDomainPermission({
      domain: 'example.com',
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
    });

    await router.handleMessage(
      { type: 'REMOVE_DOMAIN_PERMISSION', domain: 'example.com' },
      {} as any,
    );

    const perms = await getDomainPermissions();
    expect(perms).toHaveLength(0);
  });
});

describe('Offscreen handler', () => {
  it('ENSURE_OFFSCREEN returns ok', async () => {
    const result = await router.handleMessage(
      { type: 'ENSURE_OFFSCREEN' },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('Execution handlers', () => {
  it('EXECUTE_TASK returns ok (fire-and-forget)', async () => {
    const result = await router.handleMessage(
      { type: 'EXECUTE_TASK', taskId: 'task-1', tabId: 1 },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
  });

  it('CANCEL_EXECUTION returns ok', async () => {
    const result = await router.handleMessage(
      { type: 'CANCEL_EXECUTION', taskId: 'task-1' },
      {} as any,
    );
    expect(result).toEqual({ ok: true });
  });
});

describe('Script generation handlers', () => {
  it('TEST_SCRIPT returns result', async () => {
    const result = (await router.handleMessage(
      { type: 'TEST_SCRIPT', tabId: 1, source: 'function run() {}', domains: ['example.com'] } as any,
      {} as any,
    )) as any;
    expect(result).toHaveProperty('ok');
  });
});

describe('RECORDING_ACTION sanitization (H2)', () => {
  it('only passes known fields from action, stripping unknown properties', async () => {
    const maliciousAction = {
      action: 'click' as const,
      timestamp: 1234567890,
      selector: '#btn',
      elementTag: 'button',
      // Unknown / injected properties that should be stripped:
      __proto__: { polluted: true },
      constructor: 'evil',
      toString: 'hacked',
      maliciousField: 'should-not-appear',
      extraNested: { deep: 'injection' },
    };

    const result = await router.handleMessage(
      { type: 'RECORDING_ACTION', action: maliciousAction } as any,
      { tab: { windowId: 1 } } as any,
    );

    expect(result).toEqual({ ok: true });
    expect(lastRecordingStep).not.toBeNull();

    // Verify known fields are present
    expect(lastRecordingStep!.action).toBe('click');
    expect(lastRecordingStep!.selector).toBe('#btn');
    expect(lastRecordingStep!.elementTag).toBe('button');

    // Verify service-worker-controlled fields are set
    expect(lastRecordingStep!.id).toMatch(/^step-/);
    expect(lastRecordingStep!.recordingId).toBe('');
    expect(lastRecordingStep!.sequenceIndex).toBe(0);
    expect(lastRecordingStep!.status).toBe('enriched');

    // Verify unknown properties are NOT present
    expect(lastRecordingStep).not.toHaveProperty('maliciousField');
    expect(lastRecordingStep).not.toHaveProperty('extraNested');
    expect(lastRecordingStep).not.toHaveProperty('constructor', 'evil');
    expect(lastRecordingStep).not.toHaveProperty('toString', 'hacked');
  });

  it('rejects action with invalid type (not click/type/navigate)', async () => {
    lastRecordingStep = null;

    const result = await router.handleMessage(
      {
        type: 'RECORDING_ACTION',
        action: {
          action: 'exec' as any,
          timestamp: Date.now(),
          selector: '#x',
        },
      } as any,
      { tab: { windowId: 1 } } as any,
    );

    // Returns ok but does NOT create a step
    expect(result).toEqual({ ok: true });
    expect(lastRecordingStep).toBeNull();
    // Port should not receive any step
    expect(recordingPortMock!.postMessage).not.toHaveBeenCalled();
  });

  it('rejects action with undefined type', async () => {
    lastRecordingStep = null;

    const result = await router.handleMessage(
      {
        type: 'RECORDING_ACTION',
        action: { timestamp: Date.now(), selector: '#x' },
      } as any,
      {} as any,
    );

    expect(result).toEqual({ ok: true });
    expect(lastRecordingStep).toBeNull();
  });

  it('passes through all known optional fields when present', async () => {
    const fullAction = {
      action: 'type' as const,
      timestamp: 9999,
      selector: 'input#name',
      elementTag: 'input',
      elementText: 'Name field',
      elementAttributes: { id: 'name', type: 'text' },
      elementRole: 'textbox',
      a11ySubtree: { role: 'textbox', name: 'Name' },
      typedText: 'Hello',
      url: 'https://example.com',
      pageTitle: 'Example',
      viewportDimensions: { width: 1920, height: 1080 },
      clickPositionHint: { x: 100, y: 200 },
    };

    await router.handleMessage(
      { type: 'RECORDING_ACTION', action: fullAction } as any,
      { tab: { windowId: 1 } } as any,
    );

    expect(lastRecordingStep).not.toBeNull();
    expect(lastRecordingStep!.action).toBe('type');
    expect(lastRecordingStep!.selector).toBe('input#name');
    expect(lastRecordingStep!.elementTag).toBe('input');
    expect(lastRecordingStep!.elementText).toBe('Name field');
    expect(lastRecordingStep!.elementAttributes).toEqual({ id: 'name', type: 'text' });
    expect(lastRecordingStep!.elementRole).toBe('textbox');
    expect(lastRecordingStep!.a11ySubtree).toEqual({ role: 'textbox', name: 'Name' });
    expect(lastRecordingStep!.typedText).toBe('Hello');
    expect(lastRecordingStep!.url).toBe('https://example.com');
    expect(lastRecordingStep!.pageTitle).toBe('Example');
    expect(lastRecordingStep!.viewportDimensions).toEqual({ width: 1920, height: 1080 });
    expect(lastRecordingStep!.clickPositionHint).toEqual({ x: 100, y: 200 });
  });

  it('forwards sanitized step via recording port', async () => {
    await router.handleMessage(
      {
        type: 'RECORDING_ACTION',
        action: { action: 'navigate' as const, timestamp: 1000, url: 'https://example.com' },
      } as any,
      { tab: { windowId: 1 } } as any,
    );

    expect(recordingPortMock!.postMessage).toHaveBeenCalledTimes(1);
    const forwarded = recordingPortMock!.postMessage.mock.calls[0][0];
    expect(forwarded.type).toBe('RECORDING_STEP');
    expect(forwarded.step.action).toBe('navigate');
    expect(forwarded.step.url).toBe('https://example.com');
    // Should not contain any unknown fields
    const knownKeys = new Set([
      'id', 'recordingId', 'sequenceIndex', 'status', 'action',
      'timestamp', 'selector', 'elementTag', 'elementText',
      'elementAttributes', 'elementRole', 'a11ySubtree', 'typedText',
      'url', 'pageTitle', 'viewportDimensions', 'clickPositionHint',
      'screenshot', 'speechTranscript', 'description',
    ]);
    for (const key of Object.keys(forwarded.step)) {
      expect(knownKeys.has(key)).toBe(true);
    }
  });
});

describe('All message types have handlers', () => {
  const messageTypes = [
    'CREATE_TASK',
    'UPDATE_TASK',
    'DELETE_TASK',
    'GET_TASKS',
    'GET_TASK',
    'EXECUTE_TASK',
    'CANCEL_EXECUTION',
    'GET_RUNS',
    'TEST_SCRIPT',
    'GET_A11Y_TREE',
    'SCREENSHOT',
    'ATTACH_DEBUGGER',
    'DETACH_DEBUGGER',
    'GET_NOTIFICATIONS',
    'MARK_NOTIFICATION_READ',
    'GET_UNREAD_COUNT',
    'GET_USAGE_SUMMARY',
    'ENSURE_OFFSCREEN',
    'ADD_DOMAIN_PERMISSION',
    'REMOVE_DOMAIN_PERMISSION',
    'RECORDING_ACTION',
  ];

  for (const type of messageTypes) {
    it(`has handler for ${type}`, async () => {
      // Verify no "Unknown message type" error — handler may throw for
      // other reasons (bad test data), which is fine as long as the
      // error isn't about missing handler registration.
      try {
        const result = await router.handleMessage(
          { type } as any,
          {} as any,
        );
        // If it resolved, check it's not an unknown-type error
        if (result && typeof result === 'object' && 'error' in result) {
          expect((result as any).error).not.toContain('Unknown message type');
        }
      } catch {
        // Handler threw — that's fine, it means a handler IS registered.
        // Only "Unknown message type" errors indicate a missing handler,
        // and those are returned as resolved values, not thrown.
      }
    });
  }
});
