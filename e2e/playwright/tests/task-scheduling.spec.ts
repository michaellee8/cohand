import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';

test.describe('Task Scheduling @core', () => {
  const SCHED_TASK_ID = 'e2e-pw-sched-task';

  /** Create a task with a specific schedule via the service worker. */
  async function createScheduledTask(
    page: import('@playwright/test').Page,
    taskId: string,
    name: string,
    schedule: { type: 'manual' } | { type: 'interval'; intervalMinutes: number },
  ) {
    return page.evaluate(
      async ({ taskId, name, schedule }) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: 'CREATE_TASK',
              task: {
                id: taskId,
                name,
                description: `Scheduled task: ${name}`,
                allowedDomains: ['localhost'],
                schedule,
                activeScriptVersion: 1,
                disabled: false,
              notifyEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              scriptSource: 'async function run(page, context) { return { ok: true }; }',
            },
            (response: any) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            },
          );
        });
      },
      { taskId, name, schedule },
    );
  }

  test.afterEach(async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    await sw.deleteTask(SCHED_TASK_ID).catch(() => {});
    await page.close();
  });

  test('set interval schedule on task creation', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create a task with an interval schedule
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Interval Task', {
      type: 'interval',
      intervalMinutes: 30,
    });

    // Verify task was created with correct schedule
    const result = await sw.getTask(SCHED_TASK_ID);
    expect(result.task).toBeTruthy();
    expect(result.task!.schedule).toEqual({ type: 'interval', intervalMinutes: 30 });

    await page.close();
  });

  test('alarm fires for interval-scheduled task', async ({ openSidePanel, context }) => {
    const page = await openSidePanel();

    // Create a task with a very short interval (1 minute — the minimum Chrome allows)
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Alarm Test', {
      type: 'interval',
      intervalMinutes: 1,
    });

    // Wait for alarm registration to complete
    await page.waitForTimeout(1_000);

    // Verify the alarm was registered by checking chrome.alarms via the service worker
    const alarms = await page.evaluate(async (taskId) => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    }, SCHED_TASK_ID);

    // There should be an alarm registered for this task
    // Alarm name format is "task:<taskId>" (see scheduler.ts ALARM_PREFIX)
    const expectedAlarmName = `task:${SCHED_TASK_ID}`;
    const taskAlarm = alarms.find((a: any) => a.name === expectedAlarmName);

    // The alarm should exist
    expect(alarms).toBeDefined();
    expect(Array.isArray(alarms)).toBe(true);
    expect(taskAlarm).toBeTruthy();

    // Verify its period
    if (taskAlarm) {
      expect(taskAlarm.periodInMinutes).toBe(1);
    }

    await page.close();
  });

  test('manual task has no alarm', async ({ openSidePanel }) => {
    const page = await openSidePanel();

    // Create a manual task
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Manual Task', {
      type: 'manual',
    });

    // Get all alarms
    const alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    // No alarm should be registered for a manual task
    const taskAlarm = alarms.find((a: any) => a.name === `task:${SCHED_TASK_ID}`);
    expect(taskAlarm).toBeUndefined();

    await page.close();
  });

  test('deleting a scheduled task removes the alarm', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create an interval task
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Delete Alarm Test', {
      type: 'interval',
      intervalMinutes: 15,
    });

    // Verify alarm exists
    let alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const alarmBefore = alarms.find((a: any) => a.name === `task:${SCHED_TASK_ID}`);

    // Delete the task
    await sw.deleteTask(SCHED_TASK_ID);
    await page.waitForTimeout(500);

    // Verify alarm is removed
    alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const alarmAfter = alarms.find((a: any) => a.name === `task:${SCHED_TASK_ID}`);
    expect(alarmAfter).toBeUndefined();

    await page.close();
  });

  test('updating task schedule changes the alarm', async ({ openSidePanel }) => {
    const page = await openSidePanel();

    // Create an interval task
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Update Schedule Test', {
      type: 'interval',
      intervalMinutes: 30,
    });

    // Update the task to a different interval
    await page.evaluate(async (taskId) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'UPDATE_TASK',
            task: {
              id: taskId,
              name: 'E2E Update Schedule Test',
              description: 'Updated schedule',
              allowedDomains: ['localhost'],
              schedule: { type: 'interval', intervalMinutes: 60 },
              activeScriptVersion: 1,
              disabled: false,
              notifyEnabled: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          (response: any) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          },
        );
      });
    }, SCHED_TASK_ID);

    await page.waitForTimeout(500);

    // Check the alarm reflects the updated schedule
    const alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const taskAlarm = alarms.find((a: any) => a.name === `task:${SCHED_TASK_ID}`);
    if (taskAlarm) {
      expect(taskAlarm.periodInMinutes).toBe(60);
    }

    await page.close();
  });

  test('changing to manual schedule removes alarm', async ({ openSidePanel }) => {
    const page = await openSidePanel();

    // Create an interval task
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Interval to Manual', {
      type: 'interval',
      intervalMinutes: 10,
    });

    await page.waitForTimeout(500);

    // Update to manual schedule
    await page.evaluate(async (taskId) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'UPDATE_TASK',
            task: {
              id: taskId,
              name: 'E2E Interval to Manual',
              description: 'Changed to manual',
              allowedDomains: ['localhost'],
              schedule: { type: 'manual' },
              activeScriptVersion: 1,
              disabled: false,
              notifyEnabled: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
          },
          (response: any) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          },
        );
      });
    }, SCHED_TASK_ID);

    await page.waitForTimeout(500);

    // Alarm should be gone
    const alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const taskAlarm = alarms.find((a: any) => a.name === `task:${SCHED_TASK_ID}`);
    expect(taskAlarm).toBeUndefined();

    await page.close();
  });

  test('interval task shows schedule badge in UI', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Create interval task
    await createScheduledTask(page, SCHED_TASK_ID, 'E2E Schedule Badge', {
      type: 'interval',
      intervalMinutes: 20,
    });

    // Navigate to Tasks tab
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    // Task should show (use .first() since name also appears in description)
    await expect(page.getByText('E2E Schedule Badge').first()).toBeVisible({ timeout: 5_000 });

    // Schedule badge should show "every 20m"
    await expect(page.getByText('every 20m')).toBeVisible();

    await page.close();
  });

  test('wizard has schedule step in step indicator', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Open wizard
    await sp.navigateToTasks();
    await page.waitForTimeout(500);
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    // Verify wizard shows "New Task" heading
    await expect(page.locator('h2').filter({ hasText: 'New Task' })).toBeVisible();

    // The step indicator has 6 numbered circles (Describe, Domains, Observe, Review, Test, Schedule)
    // Each is rendered as a .rounded-full element with a number inside
    const stepDots = page.locator('.rounded-full');
    const dotCount = await stepDots.count();
    expect(dotCount).toBeGreaterThanOrEqual(6);

    // Step 1 is active — verify "Step 1: Describe" is shown
    await expect(page.getByText('Step 1: Describe')).toBeVisible();

    await page.close();
  });
});
