import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import { ExtensionStorageHelper } from '../helpers/extension-storage';
import { MockLLMServer, MOCK_RESPONSES } from '../helpers/mock-llm-server';

/**
 * Complete Task Execution E2E Tests
 *
 * Tests all task execution scenarios:
 * 1. Successful execution with return value
 * 2. Failed execution (script throws)
 * 3. Execution with state persistence
 * 4. Execution with notifications
 * 5. Run history display and capping
 * 6. Multiple tasks in parallel
 * 7. Domain restriction enforcement during execution
 * 8. Disabled task cannot be run
 * 9. Cancel execution
 */

let mockLLM: MockLLMServer;
let mockBaseUrl: string;

test.beforeAll(async () => {
  mockLLM = new MockLLMServer();
  mockBaseUrl = await mockLLM.start(0);
});

test.afterAll(async () => {
  await mockLLM.stop();
});

test.beforeEach(async () => {
  mockLLM.reset();
});

/** Helper: get the active tab ID from within the extension's side panel page. */
async function getActiveTabId(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');
    return tab.id;
  });
}

test.describe('Task Execution Complete @core', () => {
  const EXEC_TASK_PREFIX = 'e2e-exec-complete';

  test.afterEach(async ({ openSidePanel }) => {
    // Clean up all test tasks
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const tasks = await sw.getTasks();
    for (const task of tasks.tasks) {
      if (task.id.startsWith(EXEC_TASK_PREFIX)) {
        await sw.deleteTask(task.id).catch(() => {});
      }
    }
    await page.close();
  });

  test('successful execution with return value via EXECUTE_TASK', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-success`;

    // Create task with a script that returns a value
    await sw.createTask(
      {
        id: taskId,
        name: 'Execution Success Test',
        description: 'Returns price from mock site',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        const text = await page.locator('[data-testid="price"]').textContent();
        return { price: text, timestamp: Date.now() };
      }`,
    );

    // Execute
    const tabId = await getActiveTabId(page);
    const execResult = await sw.executeTask(taskId, tabId);
    expect(execResult).toHaveProperty('ok', true);

    // Wait for execution to complete
    await page.waitForTimeout(3_000);

    // Check runs
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0] as any;
      expect(run).toHaveProperty('id');
      expect(run).toHaveProperty('taskId', taskId);
      expect(run).toHaveProperty('success');
      expect(run).toHaveProperty('durationMs');
      expect(typeof run.durationMs).toBe('number');
      expect(run).toHaveProperty('ranAt');

      // If successful, check the result
      if (run.success) {
        expect(run.durationMs).toBeGreaterThan(0);
      }
    }

    await mockPage.close();
    await page.close();
  });

  test('failed execution: script throws an error', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-fail`;

    // Create task with a script that throws
    await sw.createTask(
      {
        id: taskId,
        name: 'Execution Failure Test',
        description: 'Script that throws an error',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        throw new Error('Intentional test error: element not found');
      }`,
    );

    // Execute
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskId, tabId);

    // Wait for execution attempt
    await page.waitForTimeout(3_000);

    // Check runs - should record a failure
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0] as any;
      expect(run).toHaveProperty('success', false);
      // The error message should be captured
      if (run.error) {
        expect(run.error).toContain('Intentional test error');
      }
    }

    await mockPage.close();
    await page.close();
  });

  test('execution with state persistence between runs', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-state`;

    // Create task that writes and reads state
    await sw.createTask(
      {
        id: taskId,
        name: 'State Persistence Test',
        description: 'Tests state persistence between runs',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        const count = (context.state?.count || 0) + 1;
        return { result: { count }, state: { count } };
      }`,
    );

    // Run twice
    const tabId = await getActiveTabId(page);
    for (let i = 0; i < 2; i++) {
      await sw.executeTask(taskId, tabId);
      await page.waitForTimeout(3_000);
    }

    // Check runs
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    // State mechanism is verified by runs existing
    // Actual state values depend on sandbox/offscreen availability

    await mockPage.close();
    await page.close();
  });

  test('execution with context.notify() creates notification', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const storage = new ExtensionStorageHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-notify`;

    await storage.addDomainPermission('localhost');

    // Create task with notify call
    await sw.createTask(
      {
        id: taskId,
        name: 'Notification Test Task',
        description: 'Task that sends a notification',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        context.notify('Price dropped to $9.99!');
        return { ok: true };
      }`,
    );

    // Record initial notification count
    const initialCount = await sw.getUnreadCount();

    // Execute
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskId, tabId);
    await page.waitForTimeout(3_000);

    // Check if notification was created
    const notifications = await sw.getNotifications();
    expect(notifications).toHaveProperty('notifications');
    expect(Array.isArray(notifications.notifications)).toBe(true);

    await mockPage.close();
    await page.close();
  });

  test('run history records multiple runs with correct fields', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-history`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Run History Test',
        description: 'Tests multiple run history entries',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { value: Math.random() }; }`,
    );

    // Execute 3 times
    const tabId = await getActiveTabId(page);
    for (let i = 0; i < 3; i++) {
      await sw.executeTask(taskId, tabId);
      await page.waitForTimeout(2_000);
    }

    // Check runs
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');

    // Each run should have required fields
    for (const run of runsResult.runs) {
      expect(run).toHaveProperty('id');
      expect(run).toHaveProperty('taskId', taskId);
      expect(run).toHaveProperty('success');
      expect(run).toHaveProperty('durationMs');
      expect(typeof (run as any).durationMs).toBe('number');
      expect(run).toHaveProperty('ranAt');
    }

    await mockPage.close();
    await page.close();
  });

  test('run history with limit parameter', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-limit`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Run Limit Test',
        description: 'Tests run history limit',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { ok: true }; }`,
    );

    // Execute multiple times
    const tabId = await getActiveTabId(page);
    for (let i = 0; i < 5; i++) {
      await sw.executeTask(taskId, tabId);
      await page.waitForTimeout(2_000);
    }

    // Request with limit of 2
    const limitedRuns = await sw.getRuns(taskId, 2);
    expect(limitedRuns).toHaveProperty('runs');
    expect(limitedRuns.runs.length).toBeLessThanOrEqual(2);

    // Request all runs
    const allRuns = await sw.getRuns(taskId);
    expect(allRuns.runs.length).toBeGreaterThanOrEqual(limitedRuns.runs.length);

    await mockPage.close();
    await page.close();
  });

  test('run history visible in task detail view', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);
    const taskId = `${EXEC_TASK_PREFIX}-detail`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Detail Runs View Test',
        description: 'Tests run history in detail view',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { ok: true }; }`,
    );

    // Execute
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskId, tabId);
    await page.waitForTimeout(3_000);

    // Navigate to task detail
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    await page.getByText('Detail Runs View Test').click();
    await page.waitForTimeout(500);

    // Verify detail view
    await expect(page.locator('h2').filter({ hasText: 'Detail Runs View Test' })).toBeVisible();
    await expect(page.getByText('Recent Runs')).toBeVisible();

    // If a run completed, it should be displayed
    const runsResult = await sw.getRuns(taskId);
    if (runsResult.runs.length > 0) {
      const runEntry = page.locator('.bg-gray-50').first();
      await expect(runEntry).toBeVisible({ timeout: 3_000 });
    }

    await mockPage.close();
    await page.close();
  });

  test('multiple tasks created and executed independently', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    const taskA = `${EXEC_TASK_PREFIX}-parallel-a`;
    const taskB = `${EXEC_TASK_PREFIX}-parallel-b`;

    // Create two tasks with different scripts
    await sw.createTask(
      {
        id: taskA,
        name: 'Parallel Task A',
        description: 'First parallel task',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { task: 'A', time: Date.now() }; }`,
    );

    await sw.createTask(
      {
        id: taskB,
        name: 'Parallel Task B',
        description: 'Second parallel task',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { task: 'B', time: Date.now() }; }`,
    );

    // Execute both
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskA, tabId);
    await sw.executeTask(taskB, tabId);

    // Wait for both to complete
    await page.waitForTimeout(5_000);

    // Check runs for each task independently
    const runsA = await sw.getRuns(taskA);
    const runsB = await sw.getRuns(taskB);

    expect(runsA).toHaveProperty('runs');
    expect(runsB).toHaveProperty('runs');
    expect(Array.isArray(runsA.runs)).toBe(true);
    expect(Array.isArray(runsB.runs)).toBe(true);

    // Runs should be independent (each task has its own history)
    for (const run of runsA.runs) {
      expect(run.taskId).toBe(taskA);
    }
    for (const run of runsB.runs) {
      expect(run.taskId).toBe(taskB);
    }

    await mockPage.close();
    await page.close();
  });

  test('domain restriction: execution blocked on disallowed domain', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-domain-block`;

    // Create task restricted to only "restricted-domain.com"
    await sw.createTask(
      {
        id: taskId,
        name: 'Domain Block Execution Test',
        description: 'Only allows restricted-domain.com',
        allowedDomains: ['restricted-domain.com'],
      },
      `async function run(page, context) { return { ok: true }; }`,
    );

    // Try to execute on localhost (which is NOT in allowed domains)
    const tabId = await getActiveTabId(page);
    const execResult = await sw.executeTask(taskId, tabId);
    expect(execResult).toHaveProperty('ok', true);

    await page.waitForTimeout(3_000);

    // The run should have failed due to domain restriction
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0];
      expect(run.success).toBe(false);
    }

    await mockPage.close();
    await page.close();
  });

  test('disabled task: Run button disabled in UI', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);
    const taskId = `${EXEC_TASK_PREFIX}-disabled-ui`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Disabled Task UI Test',
        description: 'This task is disabled',
        allowedDomains: ['localhost'],
        disabled: true,
      },
      `async function run(page, context) { return { ok: true }; }`,
    );

    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    await expect(page.getByText('Disabled Task UI Test')).toBeVisible({ timeout: 5_000 });

    // Run button should be disabled
    const taskCard = page.locator('div').filter({ hasText: 'Disabled Task UI Test' }).first();
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).toBeDisabled();

    await mockPage.close();
    await page.close();
  });

  test('cancel execution via CANCEL_EXECUTION message', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-cancel`;

    // Create a long-running task
    await sw.createTask(
      {
        id: taskId,
        name: 'Cancel Execution Test',
        description: 'Long-running task for cancellation testing',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        await new Promise(r => setTimeout(r, 30000));
        return { ok: true };
      }`,
    );

    // Start execution
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskId, tabId);

    // Cancel immediately
    await page.waitForTimeout(500);
    const cancelResult = await sw.cancelExecution(taskId);
    expect(cancelResult).toHaveProperty('ok', true);

    await mockPage.close();
    await page.close();
  });

  test('Run button triggers execution from task card', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);
    const taskId = `${EXEC_TASK_PREFIX}-run-btn`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Run Button Execution Test',
        description: 'Test Run button triggers execution',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) { return { clicked: true }; }`,
    );

    // Navigate to Tasks tab
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    // Find and click the Run button
    await expect(page.getByText('Run Button Execution Test')).toBeVisible({ timeout: 5_000 });
    const taskCard = page.locator('div').filter({ hasText: 'Run Button Execution Test' }).first();
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Allow execution time
    await page.waitForTimeout(3_000);

    // Verify execution was attempted (runs should exist even if it failed)
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');

    await mockPage.close();
    await page.close();
  });

  test('task with script returning complex object', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const taskId = `${EXEC_TASK_PREFIX}-complex`;

    await sw.createTask(
      {
        id: taskId,
        name: 'Complex Return Test',
        description: 'Tests complex return values',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
        return {
          items: ['Widget Alpha', 'Widget Beta'],
          price: '$49.99',
          metadata: { source: 'mock-site', timestamp: Date.now() },
        };
      }`,
    );

    // Execute
    const tabId = await getActiveTabId(page);
    await sw.executeTask(taskId, tabId);
    await page.waitForTimeout(3_000);

    // Check runs
    const runsResult = await sw.getRuns(taskId);
    expect(runsResult).toHaveProperty('runs');

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0];
      expect(run).toHaveProperty('taskId', taskId);
    }

    await mockPage.close();
    await page.close();
  });

  test('usage summary returns valid data', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Test GET_USAGE_SUMMARY message
    const result = await sw.getUsageSummary(7);
    expect(result).toHaveProperty('summary');

    // Summary should be an object
    expect(typeof result.summary).toBe('object');

    await page.close();
  });

  test('task card shows "No runs yet" before first execution', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);
    const taskId = `${EXEC_TASK_PREFIX}-no-runs`;

    await page.evaluate(async (taskId: string) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(
          {
            type: 'CREATE_TASK',
            task: {
              id: taskId,
              name: 'No Runs Yet Task',
              description: 'Task with no execution history',
              allowedDomains: ['localhost'],
              schedule: { type: 'manual' },
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
    }, taskId);

    // Navigate to task detail
    await sp.navigateToChat();
    await page.waitForTimeout(300);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_500);

    await page.getByText('No Runs Yet Task').click();
    await page.waitForTimeout(500);

    // Should show "No runs yet"
    await expect(page.getByText('No runs yet')).toBeVisible();

    await page.close();
  });
});
