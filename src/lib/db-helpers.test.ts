import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from './db';
import {
  putTask,
  getTask,
  getAllTasks,
  deleteTask,
  putScriptVersion,
  getScriptVersion,
  getScriptVersionsForTask,
  capScriptVersions,
  addScriptRun,
  getRunsForTask,
  capRuns,
  putTaskState,
  getTaskState,
  putStateSnapshot,
  capStateSnapshots,
  putNotification,
  getNotification,
  isNotificationRateLimited,
  putLlmUsage,
  getLlmUsageForTask,
  putRecording,
  getRecording,
  putRecordingStep,
  getRecordingSteps,
  deleteRecordingStep,
  putRecordingPageSnapshot,
  getRecordingPageSnapshots,
  deleteRecording,
} from './db-helpers';
import {
  getRecentNotifications,
  markAsRead,
  getUnreadCount,
} from './notifications';
import type {
  Task,
  ScriptVersion,
  ScriptRun,
  TaskState,
  StateSnapshot,
  TaskNotification,
  LlmUsageRecord,
  RecordingRecord,
  RecordingStepRecord,
  RecordingPageSnapshot,
} from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    name: 'Test Task',
    description: 'A test task',
    allowedDomains: ['example.com'],
    schedule: { type: 'manual' },
    activeScriptVersion: 1,
    disabled: false,
    notifyEnabled: true,
    createdAt: '2026-03-07T00:00:00.000Z',
    updatedAt: '2026-03-07T00:00:00.000Z',
    ...overrides,
  };
}

function makeScriptVersion(overrides: Partial<ScriptVersion> = {}): ScriptVersion {
  return {
    id: 'task-1:v1',
    taskId: 'task-1',
    version: 1,
    source: 'console.log("hello")',
    checksum: 'abc123',
    generatedBy: 'explorer',
    astValidationPassed: true,
    securityReviewPassed: true,
    reviewDetails: [],
    createdAt: '2026-03-07T00:00:00.000Z',
    ...overrides,
  };
}

function makeScriptRun(overrides: Partial<ScriptRun> = {}): ScriptRun {
  return {
    id: 'run-1',
    taskId: 'task-1',
    version: 1,
    success: true,
    durationMs: 150,
    ranAt: '2026-03-07T00:00:00.000Z',
    ...overrides,
  };
}

function makeNotification(overrides: Partial<TaskNotification> = {}): TaskNotification {
  return {
    id: 'notif-1',
    taskId: 'task-1',
    message: 'Something happened',
    isRead: 0,
    createdAt: '2026-03-07T00:00:00.000Z',
    ...overrides,
  };
}

function makeLlmUsage(overrides: Partial<LlmUsageRecord> = {}): LlmUsageRecord {
  return {
    id: 'llm-1',
    taskId: 'task-1',
    purpose: 'explore',
    provider: 'openai',
    model: 'gpt-5.4',
    inputTokens: 100,
    outputTokens: 50,
    createdAt: '2026-03-07T00:00:00.000Z',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let db: IDBDatabase;

beforeEach(async () => {
  // Reset fake-indexeddb between tests
  indexedDB = new IDBFactory();
  db = await openDB();
});

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

describe('Tasks', () => {
  it('putTask + getTask round-trip', async () => {
    const task = makeTask();
    await putTask(db, task);
    const result = await getTask(db, 'task-1');
    expect(result).toEqual(task);
  });

  it('getAllTasks returns all stored tasks', async () => {
    await putTask(db, makeTask({ id: 'task-1' }));
    await putTask(db, makeTask({ id: 'task-2', name: 'Second' }));
    const tasks = await getAllTasks(db);
    expect(tasks).toHaveLength(2);
    const ids = tasks.map((t) => t.id).sort();
    expect(ids).toEqual(['task-1', 'task-2']);
  });

  it('deleteTask removes the task', async () => {
    await putTask(db, makeTask());
    await deleteTask(db, 'task-1');
    const result = await getTask(db, 'task-1');
    expect(result).toBeUndefined();
  });

  it('getTask returns undefined for missing key', async () => {
    const result = await getTask(db, 'does-not-exist');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Script Versions
// ---------------------------------------------------------------------------

describe('Script Versions', () => {
  it('put + get round-trip', async () => {
    const sv = makeScriptVersion();
    await putScriptVersion(db, sv);
    const result = await getScriptVersion(db, 'task-1:v1');
    expect(result).toEqual(sv);
  });

  it('getScriptVersionsForTask returns versions for the given task', async () => {
    await putScriptVersion(db, makeScriptVersion({ id: 'task-1:v1', taskId: 'task-1', version: 1 }));
    await putScriptVersion(db, makeScriptVersion({ id: 'task-1:v2', taskId: 'task-1', version: 2 }));
    await putScriptVersion(db, makeScriptVersion({ id: 'task-2:v1', taskId: 'task-2', version: 1 }));
    const versions = await getScriptVersionsForTask(db, 'task-1');
    expect(versions).toHaveLength(2);
    expect(versions.every((v) => v.taskId === 'task-1')).toBe(true);
  });

  it('capScriptVersions keeps only MAX_SCRIPT_VERSIONS (10)', async () => {
    // Add 12 versions
    for (let i = 1; i <= 12; i++) {
      await putScriptVersion(db, makeScriptVersion({
        id: `task-1:v${i}`,
        taskId: 'task-1',
        version: i,
        createdAt: `2026-03-07T00:00:${String(i).padStart(2, '0')}.000Z`,
      }));
    }
    await capScriptVersions(db, 'task-1');
    const remaining = await getScriptVersionsForTask(db, 'task-1');
    expect(remaining).toHaveLength(10);
    // Should keep versions 3-12 (newest 10)
    const versions = remaining.map((v) => v.version).sort((a, b) => a - b);
    expect(versions).toEqual([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it('capScriptVersions is a no-op when under the limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await putScriptVersion(db, makeScriptVersion({
        id: `task-1:v${i}`,
        taskId: 'task-1',
        version: i,
      }));
    }
    await capScriptVersions(db, 'task-1');
    const remaining = await getScriptVersionsForTask(db, 'task-1');
    expect(remaining).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Script Runs
// ---------------------------------------------------------------------------

describe('Script Runs', () => {
  it('addScriptRun + getRunsForTask round-trip', async () => {
    const run = makeScriptRun();
    await addScriptRun(db, run);
    const runs = await getRunsForTask(db, 'task-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual(run);
  });

  it('getRunsForTask returns newest first', async () => {
    await addScriptRun(db, makeScriptRun({ id: 'run-1', ranAt: '2026-03-07T01:00:00.000Z' }));
    await addScriptRun(db, makeScriptRun({ id: 'run-2', ranAt: '2026-03-07T03:00:00.000Z' }));
    await addScriptRun(db, makeScriptRun({ id: 'run-3', ranAt: '2026-03-07T02:00:00.000Z' }));
    const runs = await getRunsForTask(db, 'task-1');
    expect(runs.map((r) => r.id)).toEqual(['run-2', 'run-3', 'run-1']);
  });

  it('getRunsForTask respects limit', async () => {
    for (let i = 1; i <= 10; i++) {
      await addScriptRun(db, makeScriptRun({
        id: `run-${i}`,
        ranAt: `2026-03-07T00:${String(i).padStart(2, '0')}:00.000Z`,
      }));
    }
    const runs = await getRunsForTask(db, 'task-1', 3);
    expect(runs).toHaveLength(3);
    // Newest first
    expect(runs[0].id).toBe('run-10');
    expect(runs[1].id).toBe('run-9');
    expect(runs[2].id).toBe('run-8');
  });

  it('capRuns keeps only MAX_RUNS_PER_TASK (100)', async () => {
    // Add 105 runs
    for (let i = 1; i <= 105; i++) {
      const paddedMinutes = String(Math.floor(i / 60)).padStart(2, '0');
      const paddedSeconds = String(i % 60).padStart(2, '0');
      await addScriptRun(db, makeScriptRun({
        id: `run-${i}`,
        ranAt: `2026-03-07T${paddedMinutes}:${paddedSeconds}:00.000Z`,
      }));
    }
    await capRuns(db, 'task-1');
    const remaining = await getRunsForTask(db, 'task-1');
    expect(remaining).toHaveLength(100);
    // Newest 100 should remain – the 5 oldest (run-1 through run-5) deleted
    const ids = remaining.map((r) => r.id);
    expect(ids).not.toContain('run-1');
    expect(ids).not.toContain('run-5');
    expect(ids).toContain('run-6');
    expect(ids).toContain('run-105');
  });
});

// ---------------------------------------------------------------------------
// Task State
// ---------------------------------------------------------------------------

describe('Task State', () => {
  it('putTaskState + getTaskState round-trip', async () => {
    const state: TaskState = {
      taskId: 'task-1',
      state: { cursor: 42, lastPage: '/feed' },
      updatedAt: '2026-03-07T00:00:00.000Z',
    };
    await putTaskState(db, state);
    const result = await getTaskState(db, 'task-1');
    expect(result).toEqual(state);
  });

  it('getTaskState returns undefined for missing task', async () => {
    const result = await getTaskState(db, 'no-such-task');
    expect(result).toBeUndefined();
  });

  it('putTaskState overwrites existing state', async () => {
    await putTaskState(db, {
      taskId: 'task-1',
      state: { v: 1 },
      updatedAt: '2026-03-07T00:00:00.000Z',
    });
    await putTaskState(db, {
      taskId: 'task-1',
      state: { v: 2 },
      updatedAt: '2026-03-07T01:00:00.000Z',
    });
    const result = await getTaskState(db, 'task-1');
    expect(result?.state).toEqual({ v: 2 });
  });
});

// ---------------------------------------------------------------------------
// State Snapshots
// ---------------------------------------------------------------------------

describe('State Snapshots', () => {
  it('put + cap keeps only MAX_STATE_SNAPSHOTS_PER_TASK (10)', async () => {
    // Add 15 snapshots
    for (let i = 1; i <= 15; i++) {
      const snapshot: StateSnapshot = {
        id: `snap-${i}`,
        taskId: 'task-1',
        state: { iteration: i },
        createdAt: `2026-03-07T00:${String(i).padStart(2, '0')}:00.000Z`,
      };
      await putStateSnapshot(db, snapshot);
    }
    await capStateSnapshots(db, 'task-1');

    // Fetch all remaining for this task
    const { getAllByIndex } = await import('./db-helpers');
    const remaining = await getAllByIndex<StateSnapshot>(db, 'state_snapshots', 'by_task', 'task-1');
    expect(remaining).toHaveLength(10);
    // Newest 10 should remain (snap-6 through snap-15)
    const ids = remaining.map((s) => s.id).sort();
    expect(ids).not.toContain('snap-1');
    expect(ids).not.toContain('snap-5');
    expect(ids).toContain('snap-6');
    expect(ids).toContain('snap-15');
  });

  it('capStateSnapshots is a no-op when under the limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await putStateSnapshot(db, {
        id: `snap-${i}`,
        taskId: 'task-1',
        state: {},
        createdAt: `2026-03-07T00:0${i}:00.000Z`,
      });
    }
    await capStateSnapshots(db, 'task-1');
    const { getAllByIndex } = await import('./db-helpers');
    const remaining = await getAllByIndex<StateSnapshot>(db, 'state_snapshots', 'by_task', 'task-1');
    expect(remaining).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

describe('Notifications', () => {
  it('put + get round-trip', async () => {
    const notif = makeNotification();
    await putNotification(db, notif);
    const result = await getNotification(db, 'notif-1');
    expect(result).toEqual(notif);
  });

  it('getRecentNotifications returns newest first and respects limit', async () => {
    for (let i = 1; i <= 5; i++) {
      await putNotification(db, makeNotification({
        id: `notif-${i}`,
        createdAt: `2026-03-07T00:0${i}:00.000Z`,
      }));
    }
    const recent = await getRecentNotifications(db, 3);
    expect(recent).toHaveLength(3);
    expect(recent[0].id).toBe('notif-5');
    expect(recent[1].id).toBe('notif-4');
    expect(recent[2].id).toBe('notif-3');
  });

  it('getUnreadCount returns count of unread notifications', async () => {
    await putNotification(db, makeNotification({ id: 'n1', isRead: 0 }));
    await putNotification(db, makeNotification({ id: 'n2', isRead: 0 }));
    await putNotification(db, makeNotification({ id: 'n3', isRead: 1 }));
    const count = await getUnreadCount(db);
    expect(count).toBe(2);
  });

  it('markAsRead updates isRead from 0 to 1', async () => {
    await putNotification(db, makeNotification({ id: 'n1', isRead: 0 }));
    await markAsRead(db, 'n1');
    const result = await getNotification(db, 'n1');
    expect(result?.isRead).toBe(1);
  });

  it('markAsRead is a no-op for already-read notification', async () => {
    await putNotification(db, makeNotification({ id: 'n1', isRead: 1 }));
    await markAsRead(db, 'n1');
    const result = await getNotification(db, 'n1');
    expect(result?.isRead).toBe(1);
  });

  it('markAsRead is a no-op for missing notification', async () => {
    // Should not throw
    await markAsRead(db, 'does-not-exist');
  });

  it('isNotificationRateLimited returns true when 10+ recent notifications', async () => {
    const now = new Date();
    for (let i = 0; i < 10; i++) {
      const createdAt = new Date(now.getTime() - i * 1000).toISOString();
      await putNotification(db, makeNotification({
        id: `n-${i}`,
        taskId: 'task-1',
        createdAt,
      }));
    }
    const limited = await isNotificationRateLimited(db, 'task-1');
    expect(limited).toBe(true);
  });

  it('isNotificationRateLimited returns false when under 10 recent', async () => {
    const now = new Date();
    for (let i = 0; i < 5; i++) {
      const createdAt = new Date(now.getTime() - i * 1000).toISOString();
      await putNotification(db, makeNotification({
        id: `n-${i}`,
        taskId: 'task-1',
        createdAt,
      }));
    }
    const limited = await isNotificationRateLimited(db, 'task-1');
    expect(limited).toBe(false);
  });

  it('isNotificationRateLimited ignores notifications from other tasks', async () => {
    const now = new Date();
    for (let i = 0; i < 15; i++) {
      const createdAt = new Date(now.getTime() - i * 1000).toISOString();
      await putNotification(db, makeNotification({
        id: `n-${i}`,
        taskId: 'task-other',
        createdAt,
      }));
    }
    const limited = await isNotificationRateLimited(db, 'task-1');
    expect(limited).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// LLM Usage
// ---------------------------------------------------------------------------

describe('LLM Usage', () => {
  it('put + getLlmUsageForTask round-trip', async () => {
    const record = makeLlmUsage();
    await putLlmUsage(db, record);
    const results = await getLlmUsageForTask(db, 'task-1');
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(record);
  });

  it('getLlmUsageForTask returns only records for the given task', async () => {
    await putLlmUsage(db, makeLlmUsage({ id: 'llm-1', taskId: 'task-1' }));
    await putLlmUsage(db, makeLlmUsage({ id: 'llm-2', taskId: 'task-1' }));
    await putLlmUsage(db, makeLlmUsage({ id: 'llm-3', taskId: 'task-2' }));
    const results = await getLlmUsageForTask(db, 'task-1');
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.taskId === 'task-1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recording helpers
// ---------------------------------------------------------------------------

function makeRecording(overrides: Partial<RecordingRecord> = {}): RecordingRecord {
  return {
    id: 'rec-1',
    startedAt: '2026-03-10T00:00:00.000Z',
    activeTabId: 1,
    trackedTabs: [1],
    stepCount: 0,
    ...overrides,
  };
}

function makeRecordingStep(overrides: Partial<RecordingStepRecord> = {}): RecordingStepRecord {
  return {
    id: 'step-1',
    recordingId: 'rec-1',
    sequenceIndex: 0,
    timestamp: Date.now(),
    action: 'click',
    ...overrides,
  };
}

function makePageSnapshot(overrides: Partial<RecordingPageSnapshot> = {}): RecordingPageSnapshot {
  return {
    id: 'snap-page-1',
    recordingId: 'rec-1',
    snapshotKey: 'page-1',
    url: 'https://example.com',
    tree: { role: 'WebArea', name: 'Example' },
    capturedAt: '2026-03-10T00:00:00.000Z',
    ...overrides,
  };
}

describe('Recording helpers', () => {
  it('putRecording + getRecording round-trip', async () => {
    const rec = makeRecording();
    await putRecording(db, rec);
    const result = await getRecording(db, 'rec-1');
    expect(result).toEqual(rec);
  });

  it('getRecording returns undefined for missing id', async () => {
    const result = await getRecording(db, 'does-not-exist');
    expect(result).toBeUndefined();
  });

  it('putRecordingStep + getRecordingSteps retrieves in order', async () => {
    await putRecordingStep(db, makeRecordingStep({ id: 'step-3', sequenceIndex: 2 }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-1', sequenceIndex: 0 }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-2', sequenceIndex: 1 }));

    const steps = await getRecordingSteps(db, 'rec-1');
    expect(steps).toHaveLength(3);
    expect(steps.map((s) => s.id)).toEqual(['step-1', 'step-2', 'step-3']);
    expect(steps.map((s) => s.sequenceIndex)).toEqual([0, 1, 2]);
  });

  it('getRecordingSteps returns only steps for the given recording', async () => {
    await putRecordingStep(db, makeRecordingStep({ id: 'step-1', recordingId: 'rec-1', sequenceIndex: 0 }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-2', recordingId: 'rec-2', sequenceIndex: 0 }));

    const steps = await getRecordingSteps(db, 'rec-1');
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('step-1');
  });

  it('deleteRecordingStep removes a specific step', async () => {
    await putRecordingStep(db, makeRecordingStep({ id: 'step-1', sequenceIndex: 0 }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-2', sequenceIndex: 1 }));

    await deleteRecordingStep(db, 'step-1');

    const steps = await getRecordingSteps(db, 'rec-1');
    expect(steps).toHaveLength(1);
    expect(steps[0].id).toBe('step-2');
  });

  it('putRecordingPageSnapshot + getRecordingPageSnapshots round-trip', async () => {
    const snap1 = makePageSnapshot({ id: 'snap-1', snapshotKey: 'page-1' });
    const snap2 = makePageSnapshot({ id: 'snap-2', snapshotKey: 'page-2', url: 'https://example.com/page2' });
    await putRecordingPageSnapshot(db, snap1);
    await putRecordingPageSnapshot(db, snap2);

    const snapshots = await getRecordingPageSnapshots(db, 'rec-1');
    expect(snapshots).toHaveLength(2);
    const ids = snapshots.map((s) => s.id).sort();
    expect(ids).toEqual(['snap-1', 'snap-2']);
  });

  it('getRecordingPageSnapshots returns only snapshots for the given recording', async () => {
    await putRecordingPageSnapshot(db, makePageSnapshot({ id: 'snap-1', recordingId: 'rec-1' }));
    await putRecordingPageSnapshot(db, makePageSnapshot({ id: 'snap-2', recordingId: 'rec-2' }));

    const snapshots = await getRecordingPageSnapshots(db, 'rec-1');
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].id).toBe('snap-1');
  });

  it('deleteRecording cascade-deletes recording + steps + snapshots', async () => {
    // Set up a recording with steps and snapshots
    await putRecording(db, makeRecording({ id: 'rec-1' }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-1', recordingId: 'rec-1', sequenceIndex: 0 }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-2', recordingId: 'rec-1', sequenceIndex: 1 }));
    await putRecordingPageSnapshot(db, makePageSnapshot({ id: 'snap-1', recordingId: 'rec-1' }));
    await putRecordingPageSnapshot(db, makePageSnapshot({ id: 'snap-2', recordingId: 'rec-1' }));

    // Also add data for a different recording that should NOT be deleted
    await putRecording(db, makeRecording({ id: 'rec-2' }));
    await putRecordingStep(db, makeRecordingStep({ id: 'step-3', recordingId: 'rec-2', sequenceIndex: 0 }));
    await putRecordingPageSnapshot(db, makePageSnapshot({ id: 'snap-3', recordingId: 'rec-2' }));

    // Delete rec-1
    await deleteRecording(db, 'rec-1');

    // rec-1 and its children should be gone
    expect(await getRecording(db, 'rec-1')).toBeUndefined();
    expect(await getRecordingSteps(db, 'rec-1')).toEqual([]);
    expect(await getRecordingPageSnapshots(db, 'rec-1')).toEqual([]);

    // rec-2 and its children should still exist
    expect(await getRecording(db, 'rec-2')).toBeDefined();
    const remainingSteps = await getRecordingSteps(db, 'rec-2');
    expect(remainingSteps).toHaveLength(1);
    expect(remainingSteps[0].id).toBe('step-3');
    const remainingSnaps = await getRecordingPageSnapshots(db, 'rec-2');
    expect(remainingSnaps).toHaveLength(1);
    expect(remainingSnaps[0].id).toBe('snap-3');
  });
});
