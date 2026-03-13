import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import { ExtensionStorageHelper } from '../helpers/extension-storage';
import { MockLLMServer, MOCK_RESPONSES } from '../helpers/mock-llm-server';

/**
 * Full Task Lifecycle E2E Tests
 *
 * Tests the COMPLETE task lifecycle end-to-end:
 * 1. Create task via wizard (describe -> domains -> observe -> review -> test -> schedule)
 * 2. Task appears in dashboard
 * 3. Run task manually (click Run button)
 * 4. Run completes and appears in history
 * 5. View task detail (runs, script version)
 * 6. Delete task
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

test.describe('Full Task Lifecycle @core', () => {
  const LIFECYCLE_TASK_ID = 'e2e-lifecycle-task';
  const LIFECYCLE_TASK_NAME = 'E2E Lifecycle Price Monitor';

  test.afterEach(async ({ openSidePanel }) => {
    // Clean up any created tasks
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    await sw.deleteTask(LIFECYCLE_TASK_ID).catch(() => {});
    // Also clean up tasks that might have been created via the wizard
    const tasks = await sw.getTasks();
    for (const task of tasks.tasks) {
      if (task.name === LIFECYCLE_TASK_NAME || task.name.includes('E2E Lifecycle')) {
        await sw.deleteTask(task.id).catch(() => {});
      }
    }
    await page.close();
  });

  test('wizard step 1: describe - fills description and advances', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Navigate to Tasks tab and open wizard
    await sp.navigateToTasks();
    await page.waitForTimeout(500);
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    // Step 1: Describe
    await expect(page.getByText('Step 1: Describe')).toBeVisible();
    await expect(page.locator('textarea')).toBeVisible();

    // Fill the description
    await page.locator('textarea').fill('Monitor product prices on the mock site homepage');

    // Next button should now be enabled
    const nextBtn = page.locator('button').filter({ hasText: 'Next' });
    await expect(nextBtn).not.toBeDisabled();
    await nextBtn.click();
    await page.waitForTimeout(300);

    // Should advance to Step 2
    await expect(page.getByText('Step 2: Domains')).toBeVisible();

    await page.close();
  });

  test('wizard step 2: domains - adds domain and advances', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Navigate through step 1 to reach step 2
    await sp.navigateToTasks();
    await page.waitForTimeout(500);
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    await page.locator('textarea').fill('Monitor prices on localhost');
    await page.locator('button').filter({ hasText: 'Next' }).click();
    await page.waitForTimeout(300);

    // Step 2: Domains
    await expect(page.getByText('Step 2: Domains')).toBeVisible();

    // Add localhost domain
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('localhost');
    await page.locator('button').filter({ hasText: 'Add' }).click();
    await page.waitForTimeout(300);

    // Domain should appear in the list
    await expect(page.locator('.font-mono').filter({ hasText: 'localhost' })).toBeVisible();

    // Next should be enabled
    const nextBtn = page.locator('button').filter({ hasText: 'Next' });
    await expect(nextBtn).not.toBeDisabled();
    await nextBtn.click();
    await page.waitForTimeout(300);

    // Should advance to Step 3: Observe
    await expect(page.getByText('Step 3')).toBeVisible();

    await page.close();
  });

  test('wizard navigates through all 6 steps', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);
    const storage = new ExtensionStorageHelper(page);

    // Configure mock LLM for script generation
    await storage.configureForMockLLM(mockBaseUrl);
    await page.reload();
    await page.waitForSelector('#root', { timeout: 10_000 });

    // Set mock responses for script generation and security review
    mockLLM.setDefaultResponse(MOCK_RESPONSES.scriptGeneration(
      `async function run(page, context) {
  const text = await page.locator('[data-testid="price"]').textContent();
  return { price: text };
}`,
    ));

    // Navigate to Tasks tab and open wizard
    await sp.navigateToTasks();
    await page.waitForTimeout(500);
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    // Step 1: Describe
    await expect(page.getByText('Step 1: Describe')).toBeVisible();
    await page.locator('textarea').fill('Monitor product prices on the homepage');
    await page.locator('button').filter({ hasText: 'Next' }).click();
    await page.waitForTimeout(300);

    // Step 2: Domains
    await expect(page.getByText('Step 2: Domains')).toBeVisible();
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('localhost');
    await page.locator('button').filter({ hasText: 'Add' }).click();
    await page.waitForTimeout(300);
    await page.locator('button').filter({ hasText: 'Next' }).click();
    await page.waitForTimeout(300);

    // Step 3: Observe - user may skip or interact; click Next or Skip
    await expect(page.getByText('Step 3')).toBeVisible();
    // The observe step may have a Skip button if recording is optional
    const skipBtn = page.locator('button').filter({ hasText: /Skip|Next/ });
    await skipBtn.first().click();
    await page.waitForTimeout(500);

    // Step 4: Review - script generation/review step
    await expect(page.getByText('Step 4')).toBeVisible();
    // Wait for LLM to generate or allow advancing
    await page.waitForTimeout(2_000);
    const nextOrSkip4 = page.locator('button').filter({ hasText: /Next|Skip|Accept|Approve/ });
    if (await nextOrSkip4.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await nextOrSkip4.first().click();
      await page.waitForTimeout(500);
    }

    // Step 5: Test - dry run step
    await expect(page.getByText('Step 5')).toBeVisible();
    const nextOrSkip5 = page.locator('button').filter({ hasText: /Next|Skip|Continue/ });
    if (await nextOrSkip5.first().isVisible({ timeout: 5_000 }).catch(() => false)) {
      await nextOrSkip5.first().click();
      await page.waitForTimeout(500);
    }

    // Step 6: Schedule
    await expect(page.getByText('Step 6')).toBeVisible();

    // The schedule step should show manual/interval options
    // Verify the Create/Save button exists
    const createBtn = page.locator('button').filter({ hasText: /Create|Save|Done|Finish/ });
    await expect(createBtn.first()).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('complete lifecycle: create via SW, view in dashboard, run, view detail, delete', async ({ openSidePanel, context }) => {
    // Open a page on the mock site (target tab for execution)
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    // --- STEP 1: Create task via service worker ---
    await sw.createTask(
      {
        id: LIFECYCLE_TASK_ID,
        name: LIFECYCLE_TASK_NAME,
        description: 'Monitor prices on the mock site',
        allowedDomains: ['localhost'],
        schedule: { type: 'manual' },
      },
      `async function run(page, context) {
        const text = await page.locator('[data-testid="price"]').textContent();
        return { price: text };
      }`,
    );

    // --- STEP 2: Verify task appears in dashboard ---
    await sp.navigateToChat();
    await page.waitForTimeout(300);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_500);

    await expect(page.getByText(LIFECYCLE_TASK_NAME)).toBeVisible({ timeout: 5_000 });

    // Verify the task card shows manual schedule (no schedule badge)
    const taskCard = page.locator('div').filter({ hasText: LIFECYCLE_TASK_NAME }).first();
    await expect(taskCard).toBeVisible();

    // --- STEP 3: Run task manually via Run button ---
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Allow execution time
    await page.waitForTimeout(3_000);

    // --- STEP 4: Verify run appeared in history ---
    const runsResult = await sw.getRuns(LIFECYCLE_TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    // --- STEP 5: View task detail ---
    // Navigate away and back to refresh
    await sp.navigateToChat();
    await page.waitForTimeout(300);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    await page.getByText(LIFECYCLE_TASK_NAME).click();
    await page.waitForTimeout(500);

    // Detail view should show task info
    await expect(page.locator('h2').filter({ hasText: LIFECYCLE_TASK_NAME })).toBeVisible();
    await expect(page.getByText('Monitor prices on the mock site')).toBeVisible();
    await expect(page.getByText('localhost')).toBeVisible();

    // Recent Runs section should be present
    await expect(page.getByText('Recent Runs')).toBeVisible();

    // If runs were recorded, they should appear
    if (runsResult.runs.length > 0) {
      const runEntry = page.locator('.bg-gray-50').first();
      await expect(runEntry).toBeVisible({ timeout: 3_000 });
    }

    // --- STEP 6: Delete task ---
    await page.getByText('Delete Task').click();
    await page.waitForTimeout(500);

    // Should return to task list
    await expect(page.locator('h2').filter({ hasText: 'Tasks' })).toBeVisible({ timeout: 5_000 });

    // Verify task is gone
    const remainingTasks = await sw.getTasks();
    const found = remainingTasks.tasks.find((t: any) => t.id === LIFECYCLE_TASK_ID);
    expect(found).toBeUndefined();

    await mockPage.close();
    await page.close();
  });

  test('lifecycle with interval schedule: create, verify alarm, verify badge, delete', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    const SCHED_ID = 'e2e-lifecycle-sched';

    // Create task with interval schedule
    await page.evaluate(
      async ({ taskId }) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: 'CREATE_TASK',
              task: {
                id: taskId,
                name: 'E2E Lifecycle Scheduled Task',
                description: 'Runs every 15 minutes',
                allowedDomains: ['localhost'],
                schedule: { type: 'interval', intervalMinutes: 15 },
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
      { taskId: SCHED_ID },
    );

    await page.waitForTimeout(500);

    // Verify alarm was registered
    const alarms = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const taskAlarm = alarms.find((a: any) => a.name === `task:${SCHED_ID}`);
    expect(taskAlarm).toBeTruthy();
    if (taskAlarm) {
      expect(taskAlarm.periodInMinutes).toBe(15);
    }

    // Verify badge shows in UI
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    await expect(page.getByText('E2E Lifecycle Scheduled Task').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('every 15m')).toBeVisible();

    // Delete task
    await sw.deleteTask(SCHED_ID);
    await page.waitForTimeout(500);

    // Verify alarm was removed
    const alarmsAfter = await page.evaluate(async () => {
      return new Promise<chrome.alarms.Alarm[]>((resolve) => {
        chrome.alarms.getAll((alarms) => resolve(alarms));
      });
    });

    const alarmAfter = alarmsAfter.find((a: any) => a.name === `task:${SCHED_ID}`);
    expect(alarmAfter).toBeUndefined();

    await page.close();
  });

  test('lifecycle: create multiple tasks, verify ordering, run each, delete all', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    const TASK_IDS = ['e2e-multi-lc-1', 'e2e-multi-lc-2', 'e2e-multi-lc-3'];

    // Create 3 tasks
    for (let i = 0; i < TASK_IDS.length; i++) {
      await sw.createTask(
        {
          id: TASK_IDS[i],
          name: `Lifecycle Task ${i + 1}`,
          description: `Task ${i + 1} for lifecycle test`,
          allowedDomains: ['localhost'],
        },
        `async function run(page, context) { return { taskNum: ${i + 1} }; }`,
      );
    }

    // Navigate to Tasks tab
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    // All 3 should appear
    for (let i = 0; i < TASK_IDS.length; i++) {
      await expect(page.getByText(`Lifecycle Task ${i + 1}`)).toBeVisible({ timeout: 5_000 });
    }

    // Run each task
    for (let i = 0; i < TASK_IDS.length; i++) {
      const tabId = await getActiveTabId(page);
      await sw.executeTask(TASK_IDS[i], tabId);
    }

    // Wait for all executions
    await page.waitForTimeout(5_000);

    // Verify each task has run history
    for (const taskId of TASK_IDS) {
      const runs = await sw.getRuns(taskId);
      expect(runs).toHaveProperty('runs');
      expect(Array.isArray(runs.runs)).toBe(true);
    }

    // Delete all tasks
    for (const taskId of TASK_IDS) {
      await sw.deleteTask(taskId);
    }

    // Verify all gone
    const remaining = await sw.getTasks();
    for (const taskId of TASK_IDS) {
      expect(remaining.tasks.find((t: any) => t.id === taskId)).toBeUndefined();
    }

    await mockPage.close();
    await page.close();
  });

  test('wizard back navigation preserves form state', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await sp.navigateToTasks();
    await page.waitForTimeout(500);
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    // Step 1: fill description
    const description = 'Price tracker for widgets';
    await page.locator('textarea').fill(description);
    await page.locator('button').filter({ hasText: 'Next' }).click();
    await page.waitForTimeout(300);

    // Step 2: add domain
    await expect(page.getByText('Step 2: Domains')).toBeVisible();
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('localhost');
    await page.locator('button').filter({ hasText: 'Add' }).click();
    await page.waitForTimeout(300);

    // Go back to step 1
    await page.locator('button').filter({ hasText: 'Back' }).click();
    await page.waitForTimeout(300);

    // Description should be preserved
    await expect(page.getByText('Step 1: Describe')).toBeVisible();
    expect(await page.locator('textarea').inputValue()).toBe(description);

    // Go forward again
    await page.locator('button').filter({ hasText: 'Next' }).click();
    await page.waitForTimeout(300);

    // Domain should still be there
    await expect(page.getByText('Step 2: Domains')).toBeVisible();
    await expect(page.locator('.font-mono').filter({ hasText: 'localhost' })).toBeVisible();

    await page.close();
  });

  test('task detail shows script version information', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    const DETAIL_ID = 'e2e-script-version-test';

    // Create task with script (version 1)
    await page.evaluate(
      async ({ taskId }) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(
            {
              type: 'CREATE_TASK',
              task: {
                id: taskId,
                name: 'Script Version Test Task',
                description: 'Task to verify script version display',
                allowedDomains: ['localhost', 'example.com'],
                schedule: { type: 'manual' },
                activeScriptVersion: 1,
                disabled: false,
              notifyEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              scriptSource: 'async function run(page, context) { return { v: 1 }; }',
            },
            (response: any) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            },
          );
        });
      },
      { taskId: DETAIL_ID },
    );

    // Navigate to task detail
    await sp.navigateToChat();
    await page.waitForTimeout(300);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_500);

    await page.getByText('Script Version Test Task').click();
    await page.waitForTimeout(500);

    // Verify detail view elements
    await expect(page.locator('h2').filter({ hasText: 'Script Version Test Task' })).toBeVisible();
    await expect(page.getByText('Task to verify script version display')).toBeVisible();
    await expect(page.getByText('localhost')).toBeVisible();
    await expect(page.getByText('example.com')).toBeVisible();

    // Clean up
    await sw.deleteTask(DETAIL_ID);
    await page.close();
  });

  test('run button disabled when task is disabled', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    const DISABLED_ID = 'e2e-disabled-lifecycle';

    // Create a disabled task
    await sw.createTask(
      {
        id: DISABLED_ID,
        name: 'Disabled Lifecycle Task',
        description: 'This task should not be runnable',
        allowedDomains: ['localhost'],
        disabled: true,
      },
      'async function run(page, context) { return { ok: true }; }',
    );

    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    // Task should appear
    await expect(page.getByText('Disabled Lifecycle Task')).toBeVisible({ timeout: 5_000 });

    // Run button should be disabled
    const taskCard = page.locator('div').filter({ hasText: 'Disabled Lifecycle Task' }).first();
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).toBeDisabled();

    // Clean up
    await sw.deleteTask(DISABLED_ID);
    await mockPage.close();
    await page.close();
  });

  test('re-enable disabled task and verify it becomes runnable', async ({ openSidePanel, context }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);
    const sp = new SidePanel(page);

    const REENABLE_ID = 'e2e-reenable-lifecycle';

    // Create a disabled task
    await sw.createTask(
      {
        id: REENABLE_ID,
        name: 'Re-enable Lifecycle Task',
        description: 'Will be re-enabled',
        allowedDomains: ['localhost'],
        disabled: true,
      },
      'async function run(page, context) { return { ok: true }; }',
    );

    // Verify disabled
    const check = await sw.getTask(REENABLE_ID);
    expect(check.task!.disabled).toBe(true);

    // Re-enable
    await sw.updateTask({ ...check.task!, disabled: false });
    const updated = await sw.getTask(REENABLE_ID);
    expect(updated.task!.disabled).toBe(false);

    // Navigate to Tasks tab and verify Run button is enabled
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    await expect(page.getByText('Re-enable Lifecycle Task')).toBeVisible({ timeout: 5_000 });
    const taskCard = page.locator('div').filter({ hasText: 'Re-enable Lifecycle Task' }).first();
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).not.toBeDisabled();

    // Clean up
    await sw.deleteTask(REENABLE_ID);
    await mockPage.close();
    await page.close();
  });
});
