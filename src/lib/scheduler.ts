import type { Task } from '../types';

const ALARM_PREFIX = 'task:';

/**
 * Schedule a task using chrome.alarms.
 * Only schedules if the task has an interval schedule and is not disabled.
 */
export async function scheduleTask(task: Task): Promise<void> {
  if (task.disabled || task.schedule.type !== 'interval') {
    await unscheduleTask(task.id);
    return;
  }

  const interval = Math.max(1, task.schedule.intervalMinutes);
  await chrome.alarms.create(`${ALARM_PREFIX}${task.id}`, {
    periodInMinutes: interval,
    // First fire after one interval period
    delayInMinutes: interval,
  });
}

/**
 * Remove a task's alarm.
 */
export async function unscheduleTask(taskId: string): Promise<void> {
  await chrome.alarms.clear(`${ALARM_PREFIX}${taskId}`);
}

/**
 * Get the task ID from an alarm name.
 * Returns null if the alarm is not a task alarm.
 */
export function getTaskIdFromAlarm(alarmName: string): string | null {
  if (alarmName.startsWith(ALARM_PREFIX)) {
    return alarmName.slice(ALARM_PREFIX.length);
  }
  return null;
}

/**
 * Sync all task schedules.
 * Call on startup to ensure alarms match current task state.
 * Uses diffing to avoid unnecessary alarm recreates.
 */
export async function syncSchedules(tasks: Task[]): Promise<void> {
  const alarms = await chrome.alarms.getAll();
  const existingAlarmNames = new Set(alarms.filter(a => a.name.startsWith(ALARM_PREFIX)).map(a => a.name));

  // Determine desired alarms
  const desiredAlarms = new Map<string, number>();
  for (const task of tasks) {
    if (!task.disabled && task.schedule.type === 'interval') {
      desiredAlarms.set(`${ALARM_PREFIX}${task.id}`, Math.max(1, task.schedule.intervalMinutes));
    }
  }

  // Remove alarms that shouldn't exist
  for (const name of existingAlarmNames) {
    if (!desiredAlarms.has(name)) {
      await chrome.alarms.clear(name);
    }
  }

  // Create alarms that don't exist yet
  for (const [name, interval] of desiredAlarms) {
    if (!existingAlarmNames.has(name)) {
      await chrome.alarms.create(name, {
        periodInMinutes: interval,
        delayInMinutes: interval,
      });
    }
  }
}

/**
 * Open a popup window to execute a scheduled task.
 * The popup loads sidepanel.html which has full LLM capability.
 */
export async function openTaskExecutionWindow(taskId: string): Promise<number | undefined> {
  const win = await chrome.windows.create({
    type: 'popup',
    url: chrome.runtime.getURL(`sidepanel.html?taskId=${encodeURIComponent(taskId)}&mode=execute`),
    width: 500,
    height: 768,
    focused: false,
  });
  return win?.id;
}

/**
 * Register the alarm listener in the service worker.
 * Returns the handler function for testing.
 */
export function createAlarmHandler(
  onTaskAlarm: (taskId: string) => Promise<void>,
): (alarm: chrome.alarms.Alarm) => void {
  return (alarm) => {
    const taskId = getTaskIdFromAlarm(alarm.name);
    if (taskId) {
      onTaskAlarm(taskId).catch(err => {
        console.error(`[Cohand] Failed to handle alarm for task ${taskId}:`, err);
      });
    }
  };
}
