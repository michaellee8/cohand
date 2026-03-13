import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task } from '../types';
import {
  scheduleTask,
  unscheduleTask,
  getTaskIdFromAlarm,
  syncSchedules,
  openTaskExecutionWindow,
  createAlarmHandler,
} from './scheduler';

function createMockAlarms() {
  const alarms: Map<string, chrome.alarms.Alarm> = new Map();
  return {
    create: vi.fn(async (name: string, info: { delayInMinutes?: number; periodInMinutes?: number }) => {
      alarms.set(name, {
        name,
        scheduledTime: Date.now() + (info.delayInMinutes || 0) * 60000,
        periodInMinutes: info.periodInMinutes,
      });
    }),
    clear: vi.fn(async (name: string) => {
      alarms.delete(name);
      return true;
    }),
    getAll: vi.fn(async () => Array.from(alarms.values())),
    _alarms: alarms,
  };
}

function createMockWindows() {
  return {
    create: vi.fn(async (opts: chrome.windows.CreateData) => ({
      id: 42,
      ...opts,
    })),
  };
}

function createMockRuntime() {
  return {
    getURL: vi.fn((path: string) => `chrome-extension://abc123/${path}`),
  };
}

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test Task',
    description: 'A test task',
    allowedDomains: ['example.com'],
    schedule: { type: 'interval', intervalMinutes: 30 },
    activeScriptVersion: 1,
    disabled: false,
    notifyEnabled: true,
    createdAt: '2026-03-07T00:00:00Z',
    updatedAt: '2026-03-07T00:00:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  const mockAlarms = createMockAlarms();
  const mockWindows = createMockWindows();
  const mockRuntime = createMockRuntime();
  (globalThis as unknown as { chrome: unknown }).chrome = {
    alarms: mockAlarms,
    windows: mockWindows,
    runtime: mockRuntime,
  };
});

describe('scheduleTask', () => {
  it('creates alarm for interval tasks', async () => {
    const task = makeTask({
      id: 'abc',
      schedule: { type: 'interval', intervalMinutes: 15 },
    });
    await scheduleTask(task);
    expect(chrome.alarms.create).toHaveBeenCalledWith('task:abc', {
      periodInMinutes: 15,
      delayInMinutes: 15,
    });
  });

  it('enforces minimum 1-minute interval', async () => {
    const task = makeTask({
      id: 'low-interval',
      schedule: { type: 'interval', intervalMinutes: 0 },
    });
    await scheduleTask(task);
    expect(chrome.alarms.create).toHaveBeenCalledWith('task:low-interval', {
      periodInMinutes: 1,
      delayInMinutes: 1,
    });
  });

  it('enforces minimum 1-minute interval for negative values', async () => {
    const task = makeTask({
      id: 'neg-interval',
      schedule: { type: 'interval', intervalMinutes: -5 },
    });
    await scheduleTask(task);
    expect(chrome.alarms.create).toHaveBeenCalledWith('task:neg-interval', {
      periodInMinutes: 1,
      delayInMinutes: 1,
    });
  });

  it('skips manual tasks and clears any existing alarm', async () => {
    const task = makeTask({
      id: 'manual-1',
      schedule: { type: 'manual' },
    });
    await scheduleTask(task);
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:manual-1');
  });

  it('skips disabled tasks and clears any existing alarm', async () => {
    const task = makeTask({
      id: 'disabled-1',
      disabled: true,
      schedule: { type: 'interval', intervalMinutes: 10 },
    });
    await scheduleTask(task);
    expect(chrome.alarms.create).not.toHaveBeenCalled();
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:disabled-1');
  });

  it('clears existing alarm for disabled tasks', async () => {
    // First schedule
    const task = makeTask({ id: 'flip' });
    await scheduleTask(task);
    expect(chrome.alarms.create).toHaveBeenCalledTimes(1);

    // Now disable and reschedule
    task.disabled = true;
    await scheduleTask(task);
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:flip');
  });
});

describe('unscheduleTask', () => {
  it('clears the alarm for the given task ID', async () => {
    await unscheduleTask('xyz');
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:xyz');
  });
});

describe('getTaskIdFromAlarm', () => {
  it('extracts task ID from alarm name', () => {
    expect(getTaskIdFromAlarm('task:my-task-42')).toBe('my-task-42');
  });

  it('returns null for non-task alarms', () => {
    expect(getTaskIdFromAlarm('notification:reminder')).toBeNull();
    expect(getTaskIdFromAlarm('other-alarm')).toBeNull();
    expect(getTaskIdFromAlarm('')).toBeNull();
  });
});

describe('syncSchedules', () => {
  it('clears all existing task alarms and recreates for enabled interval tasks', async () => {
    // Pre-populate some alarms (including a non-task alarm)
    const mockAlarms = chrome.alarms as unknown as ReturnType<typeof createMockAlarms>;
    mockAlarms._alarms.set('task:old-1', {
      name: 'task:old-1',
      scheduledTime: Date.now(),
      periodInMinutes: 5,
    });
    mockAlarms._alarms.set('task:old-2', {
      name: 'task:old-2',
      scheduledTime: Date.now(),
      periodInMinutes: 10,
    });
    mockAlarms._alarms.set('notification:keep', {
      name: 'notification:keep',
      scheduledTime: Date.now(),
      periodInMinutes: 60,
    });

    const tasks: Task[] = [
      makeTask({ id: 'a', schedule: { type: 'interval', intervalMinutes: 20 } }),
      makeTask({ id: 'b', schedule: { type: 'manual' } }),
      makeTask({ id: 'c', schedule: { type: 'interval', intervalMinutes: 5 }, disabled: true }),
      makeTask({ id: 'd', schedule: { type: 'interval', intervalMinutes: 60 } }),
    ];

    await syncSchedules(tasks);

    // Old task alarms should be cleared
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:old-1');
    expect(chrome.alarms.clear).toHaveBeenCalledWith('task:old-2');
    // Non-task alarm should NOT be cleared
    expect(chrome.alarms.clear).not.toHaveBeenCalledWith('notification:keep');

    // Only enabled interval tasks should be scheduled: a and d
    expect(chrome.alarms.create).toHaveBeenCalledWith('task:a', {
      periodInMinutes: 20,
      delayInMinutes: 20,
    });
    expect(chrome.alarms.create).toHaveBeenCalledWith('task:d', {
      periodInMinutes: 60,
      delayInMinutes: 60,
    });
    // b (manual) and c (disabled) should NOT create alarms
    expect(chrome.alarms.create).not.toHaveBeenCalledWith(
      'task:b',
      expect.anything(),
    );
    expect(chrome.alarms.create).not.toHaveBeenCalledWith(
      'task:c',
      expect.anything(),
    );
  });
});

describe('openTaskExecutionWindow', () => {
  it('creates popup with correct URL and dimensions', async () => {
    const windowId = await openTaskExecutionWindow('task-99');
    expect(chrome.windows.create).toHaveBeenCalledWith({
      type: 'popup',
      url: 'chrome-extension://abc123/sidepanel.html?taskId=task-99&mode=execute',
      width: 500,
      height: 768,
      focused: false,
    });
    expect(windowId).toBe(42);
  });

  it('encodes the task ID in the URL', async () => {
    await openTaskExecutionWindow('has spaces & stuff');
    expect(chrome.runtime.getURL).toHaveBeenCalledWith(
      'sidepanel.html?taskId=has%20spaces%20%26%20stuff&mode=execute',
    );
  });
});

describe('createAlarmHandler', () => {
  it('calls onTaskAlarm for task alarms', async () => {
    const onTaskAlarm = vi.fn(async () => {});
    const handler = createAlarmHandler(onTaskAlarm);
    const alarm: chrome.alarms.Alarm = {
      name: 'task:my-task',
      scheduledTime: Date.now(),
    };
    handler(alarm);
    // onTaskAlarm is called asynchronously, wait for it
    await vi.waitFor(() => {
      expect(onTaskAlarm).toHaveBeenCalledWith('my-task');
    });
  });

  it('ignores non-task alarms', async () => {
    const onTaskAlarm = vi.fn(async () => {});
    const handler = createAlarmHandler(onTaskAlarm);
    const alarm: chrome.alarms.Alarm = {
      name: 'notification:something',
      scheduledTime: Date.now(),
    };
    handler(alarm);
    // Give it a tick to ensure nothing fires
    await new Promise((r) => setTimeout(r, 10));
    expect(onTaskAlarm).not.toHaveBeenCalled();
  });

  it('logs error when onTaskAlarm rejects', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const onTaskAlarm = vi.fn(async () => {
      throw new Error('boom');
    });
    const handler = createAlarmHandler(onTaskAlarm);
    const alarm: chrome.alarms.Alarm = {
      name: 'task:fail-task',
      scheduledTime: Date.now(),
    };
    handler(alarm);
    await vi.waitFor(() => {
      expect(consoleSpy).toHaveBeenCalledWith(
        '[Cohand] Failed to handle alarm for task fail-task:',
        expect.any(Error),
      );
    });
    consoleSpy.mockRestore();
  });
});
