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

  await chrome.alarms.create(`${ALARM_PREFIX}${task.id}`, {
    periodInMinutes: task.schedule.intervalMinutes,
    // First fire after one interval period
    delayInMinutes: task.schedule.intervalMinutes,
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
 */
export async function syncSchedules(tasks: Task[]): Promise<void> {
  // Clear all existing task alarms
  const alarms = await chrome.alarms.getAll();
  for (const alarm of alarms) {
    if (alarm.name.startsWith(ALARM_PREFIX)) {
      await chrome.alarms.clear(alarm.name);
    }
  }

  // Re-create alarms for all enabled interval tasks
  for (const task of tasks) {
    if (!task.disabled && task.schedule.type === 'interval') {
      await scheduleTask(task);
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
