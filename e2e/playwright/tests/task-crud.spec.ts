import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';

test.describe('Task CRUD @core', () => {
  test.describe('Wizard UI Flow', () => {
    test('opens wizard from Tasks tab via + New Task button', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      // Navigate to Tasks tab
      await sp.navigateToTasks();
      await page.waitForTimeout(500);

      // Should show "No tasks yet" initially (or task list)
      const emptyState = await page.getByText('No tasks yet').isVisible({ timeout: 3_000 }).catch(() => false);

      // Click "+ New Task" button
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Wizard should appear with "New Task" heading
      await expect(page.locator('h2').filter({ hasText: 'New Task' })).toBeVisible();

      // Should show Step 1: Describe
      await expect(page.getByText('Step 1: Describe')).toBeVisible();

      // Textarea for description should be present
      await expect(page.locator('textarea')).toBeVisible();

      await page.close();
    });

    test('describe step validates input — Next disabled when empty', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      await sp.navigateToTasks();
      await page.waitForTimeout(500);
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Next button should be disabled with empty description
      const nextBtn = page.locator('button').filter({ hasText: 'Next' });
      await expect(nextBtn).toBeDisabled();

      // Type a description
      await page.locator('textarea').fill('Scrape product prices from the homepage');
      await page.waitForTimeout(200);

      // Next button should now be enabled
      await expect(nextBtn).not.toBeDisabled();

      await page.close();
    });

    test('describe step navigates to domains step', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      await sp.navigateToTasks();
      await page.waitForTimeout(500);
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Fill description and click Next
      await page.locator('textarea').fill('Check product availability');
      await page.locator('button').filter({ hasText: 'Next' }).click();
      await page.waitForTimeout(300);

      // Should be on Step 2: Domains
      await expect(page.getByText('Step 2: Domains')).toBeVisible();
      await expect(page.getByText('Allowed domains')).toBeVisible();

      await page.close();
    });

    test('domains step allows adding and removing domains', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      await sp.navigateToTasks();
      await page.waitForTimeout(500);
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Fill description and go to domains
      await page.locator('textarea').fill('Domain test task');
      await page.locator('button').filter({ hasText: 'Next' }).click();
      await page.waitForTimeout(300);

      // Add a domain
      const domainInput = page.locator('input[placeholder="example.com"]');
      await domainInput.fill('localhost');

      const addBtn = page.locator('button').filter({ hasText: 'Add' });
      await addBtn.click();
      await page.waitForTimeout(300);

      // Domain should appear in the list
      await expect(page.locator('.font-mono').filter({ hasText: 'localhost' })).toBeVisible();

      // Next button should now be enabled (domains.length > 0)
      await expect(page.locator('button').filter({ hasText: 'Next' })).not.toBeDisabled();

      // Remove all domains — detectCurrentTab may have auto-added the current tab's domain
      const removeBtns = page.locator('button[aria-label^="Remove"]');
      const removeCount = await removeBtns.count();
      for (let i = removeCount - 1; i >= 0; i--) {
        await removeBtns.nth(i).click();
        await page.waitForTimeout(200);
      }

      // All domains should be gone and Next should be disabled
      const domainsLeft = await page.locator('.font-mono.text-blue-700').count();
      expect(domainsLeft).toBe(0);
      await expect(page.locator('button').filter({ hasText: 'Next' })).toBeDisabled();

      await page.close();
    });

    test('cancel button returns to task list', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      await sp.navigateToTasks();
      await page.waitForTimeout(500);
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Verify we're in wizard
      await expect(page.locator('h2').filter({ hasText: 'New Task' })).toBeVisible();

      // Click Cancel
      await page.locator('button').filter({ hasText: 'Cancel' }).first().click();
      await page.waitForTimeout(300);

      // Should return to Tasks list
      await expect(page.locator('h2').filter({ hasText: 'Tasks' })).toBeVisible();

      await page.close();
    });

    test('back button navigates to previous step', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      await sp.navigateToTasks();
      await page.waitForTimeout(500);
      await page.locator('button').filter({ hasText: '+ New Task' }).click();
      await page.waitForTimeout(300);

      // Fill description and go to domains
      await page.locator('textarea').fill('Back button test');
      await page.locator('button').filter({ hasText: 'Next' }).click();
      await page.waitForTimeout(300);

      // Should be on domains step
      await expect(page.getByText('Step 2: Domains')).toBeVisible();

      // Click Back
      await page.locator('button').filter({ hasText: 'Back' }).click();
      await page.waitForTimeout(300);

      // Should be back on describe step with text preserved
      await expect(page.getByText('Step 1: Describe')).toBeVisible();
      expect(await page.locator('textarea').inputValue()).toBe('Back button test');

      await page.close();
    });
  });

  test.describe('Task CRUD via Service Worker', () => {
    const TEST_TASK_ID = 'e2e-pw-crud-task';

    test.afterEach(async ({ openSidePanel }) => {
      // Clean up: try to delete the test task
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      await sw.deleteTask(TEST_TASK_ID).catch(() => {});
      await page.close();
    });

    test('creates a task via service worker', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      const result = await sw.createTask({
        id: TEST_TASK_ID,
        name: 'E2E Playwright Price Scraper',
        description: 'Scrape prices from the mock site',
        allowedDomains: ['localhost'],
      });
      expect(result).toHaveProperty('ok', true);

      await page.close();
    });

    test('task appears in GET_TASKS response', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create first
      await sw.createTask({
        id: TEST_TASK_ID,
        name: 'E2E Playwright Price Scraper',
        description: 'Scrape prices from the mock site',
        allowedDomains: ['localhost'],
      });

      // Fetch
      const result = await sw.getTasks();
      expect(result.tasks).toBeDefined();
      expect(Array.isArray(result.tasks)).toBe(true);

      const task = result.tasks.find((t: any) => t.id === TEST_TASK_ID);
      expect(task).toBeTruthy();
      expect(task.name).toContain('E2E Playwright Price Scraper');

      await page.close();
    });

    test('task appears in the side panel UI', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      const sp = new SidePanel(page);

      // Create task
      await sw.createTask({
        id: TEST_TASK_ID,
        name: 'E2E Playwright Price Scraper',
        description: 'Scrape prices from the mock site',
        allowedDomains: ['localhost'],
      });

      // Navigate to Tasks tab — switch away and back to ensure fresh fetch
      await sp.navigateToChat();
      await page.waitForTimeout(300);
      await sp.navigateToTasks();
      await page.waitForTimeout(1_500);

      // Task should appear in the UI
      await expect(page.getByText('E2E Playwright Price Scraper')).toBeVisible({ timeout: 5_000 });

      await page.close();
    });

    test('task detail view shows correct info', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      const sp = new SidePanel(page);

      // Create task with specific properties
      await page.evaluate(async (taskId) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage({
            type: 'CREATE_TASK',
            task: {
              id: taskId,
              name: 'E2E Detail View Task',
              description: 'Task for testing detail view',
              allowedDomains: ['localhost', 'example.com'],
              schedule: { type: 'interval', intervalMinutes: 45 },
              activeScriptVersion: 1,
              disabled: false,
              notifyEnabled: true,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            scriptSource: 'async function run() { return { ok: true }; }',
          }, (response: any) => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(response);
          });
        });
      }, TEST_TASK_ID);

      // Navigate to Tasks tab — switch away and back to ensure fresh fetch
      await sp.navigateToChat();
      await page.waitForTimeout(300);
      await sp.navigateToTasks();
      await page.waitForTimeout(1_500);

      // Click on the task card
      await page.getByText('E2E Detail View Task').click();
      await page.waitForTimeout(500);

      // Detail view should show task info
      await expect(page.locator('h2').filter({ hasText: 'E2E Detail View Task' })).toBeVisible();
      await expect(page.getByText('Task for testing detail view')).toBeVisible();
      await expect(page.getByText('localhost')).toBeVisible();
      await expect(page.getByText('example.com')).toBeVisible();
      await expect(page.getByText(/45 minutes|every 45m/i)).toBeVisible();
      await expect(page.getByText('No runs yet')).toBeVisible();

      await page.close();
    });

    test('delete button removes the task', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      const sp = new SidePanel(page);

      // Create task via service worker helper
      await sw.createTask({
        id: TEST_TASK_ID,
        name: 'E2E Delete Me Task',
        description: 'This task will be deleted',
        allowedDomains: ['localhost'],
      });

      // Verify task was created
      const check = await sw.getTask(TEST_TASK_ID);
      expect(check.task).toBeTruthy();

      // Navigate to Tasks — switch away and back to ensure fresh fetch
      await sp.navigateToChat();
      await page.waitForTimeout(300);
      await sp.navigateToTasks();
      await page.waitForTimeout(1_500);

      await page.getByText('E2E Delete Me Task').click();
      await page.waitForTimeout(500);

      // Click Delete Task
      await page.getByText('Delete Task').click();
      await page.waitForTimeout(500);

      // Should return to task list
      await expect(page.locator('h2').filter({ hasText: 'Tasks' })).toBeVisible({ timeout: 5_000 });

      // Verify task is gone via API
      const tasks = await sw.getTasks();
      const found = tasks.tasks.find((t: any) => t.id === TEST_TASK_ID);
      expect(found).toBeUndefined();

      await page.close();
    });

    test('deletes a task via service worker', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create then delete
      await sw.createTask({
        id: TEST_TASK_ID,
        name: 'E2E Delete Via SW',
        description: 'Will be deleted',
        allowedDomains: ['localhost'],
      });

      const deleteResult = await sw.deleteTask(TEST_TASK_ID);
      expect(deleteResult).toHaveProperty('ok', true);

      // Verify deletion
      const tasks = await sw.getTasks();
      const found = tasks.tasks.find((t: any) => t.id === TEST_TASK_ID);
      expect(found).toBeUndefined();

      await page.close();
    });
  });

  test.describe('Edit Task Settings', () => {
    const EDIT_TASK_ID = 'e2e-pw-edit-task';

    test.afterEach(async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      await sw.deleteTask(EDIT_TASK_ID).catch(() => {});
      await page.close();
    });

    test('updates task name and description via service worker', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create task
      const createResult = await sw.createTask({
        id: EDIT_TASK_ID,
        name: 'Original Name',
        description: 'Original description',
        allowedDomains: ['localhost'],
      });
      expect(createResult).toHaveProperty('ok', true);

      // Small wait for IndexedDB write to complete
      await page.waitForTimeout(500);

      // Read the task, then update name and description with full object
      const existing = await sw.getTask(EDIT_TASK_ID);
      expect(existing.task).toBeTruthy();
      await sw.updateTask({
        ...existing.task!,
        name: 'Updated Name',
        description: 'Updated description',
      });

      // Verify changes persisted
      const result = await sw.getTask(EDIT_TASK_ID);
      expect(result.task).toBeTruthy();
      expect(result.task!.name).toBe('Updated Name');
      expect(result.task!.description).toBe('Updated description');

      await page.close();
    });

    test('updates task schedule via service worker', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create manual task
      await sw.createTask({
        id: EDIT_TASK_ID,
        name: 'Schedule Edit Test',
        description: 'Test schedule editing',
        allowedDomains: ['localhost'],
        schedule: { type: 'manual' },
      });

      // Read existing task, then change to interval schedule
      const existing = await sw.getTask(EDIT_TASK_ID);
      expect(existing.task).toBeTruthy();
      await sw.updateTask({
        ...existing.task!,
        schedule: { type: 'interval', intervalMinutes: 60 },
      });

      // Verify
      const result = await sw.getTask(EDIT_TASK_ID);
      expect(result.task).toBeTruthy();
      expect(result.task!.schedule.type).toBe('interval');
      if (result.task!.schedule.type === 'interval') {
        expect(result.task!.schedule.intervalMinutes).toBe(60);
      }

      await page.close();
    });

    test('updates task allowed domains via service worker', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create task with one domain
      await sw.createTask({
        id: EDIT_TASK_ID,
        name: 'Domain Edit Test',
        description: 'Test domain editing',
        allowedDomains: ['localhost'],
      });

      // Read existing task, then update domains
      const existing = await sw.getTask(EDIT_TASK_ID);
      expect(existing.task).toBeTruthy();
      await sw.updateTask({
        ...existing.task!,
        allowedDomains: ['localhost', 'example.com', 'test.org'],
      });

      // Verify
      const result = await sw.getTask(EDIT_TASK_ID);
      expect(result.task).toBeTruthy();
      expect(result.task!.allowedDomains).toEqual(['localhost', 'example.com', 'test.org']);

      await page.close();
    });

    test('disables and re-enables a task', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);

      // Create enabled task
      await sw.createTask({
        id: EDIT_TASK_ID,
        name: 'Disable Test',
        description: 'Test disable toggle',
        allowedDomains: ['localhost'],
      });

      // Read existing task, then disable
      const existing = await sw.getTask(EDIT_TASK_ID);
      expect(existing.task).toBeTruthy();
      await sw.updateTask({ ...existing.task!, disabled: true });

      let result = await sw.getTask(EDIT_TASK_ID);
      expect(result.task!.disabled).toBe(true);

      // Re-enable (read again to get updated state)
      const current = await sw.getTask(EDIT_TASK_ID);
      await sw.updateTask({ ...current.task!, disabled: false });

      result = await sw.getTask(EDIT_TASK_ID);
      expect(result.task!.disabled).toBe(false);

      await page.close();
    });
  });

  test.describe('Multiple Tasks Management', () => {
    const TASK_IDS = ['e2e-pw-multi-1', 'e2e-pw-multi-2', 'e2e-pw-multi-3'];

    test.afterEach(async ({ openSidePanel }) => {
      // Clean up all tasks
      const page = await openSidePanel();
      const sw = new ServiceWorkerHelper(page);
      for (const id of TASK_IDS) {
        await sw.deleteTask(id).catch(() => {});
      }
      await page.close();
    });

    test('multiple tasks appear in the UI', async ({ openSidePanel }) => {
      const page = await openSidePanel();
      const sp = new SidePanel(page);

      // Create multiple tasks
      for (let i = 0; i < TASK_IDS.length; i++) {
        await page.evaluate(async ({ taskId, idx }) => {
          return new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
              type: 'CREATE_TASK',
              task: {
                id: taskId,
                name: `Multi Task PW ${idx + 1}`,
                description: `Test task ${idx + 1}`,
                allowedDomains: ['localhost'],
                schedule: idx === 2 ? { type: 'interval', intervalMinutes: 15 } : { type: 'manual' },
                activeScriptVersion: 1,
                disabled: false,
              notifyEnabled: true,
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
              },
              scriptSource: `async function run() { return { n: ${idx + 1} }; }`,
            }, (response: any) => {
              if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
              else resolve(response);
            });
          });
        }, { taskId: TASK_IDS[i], idx: i });
      }

      // Navigate to Tasks tab
      await sp.navigateToTasks();
      await page.waitForTimeout(1_000);

      // All tasks should appear
      for (let i = 0; i < TASK_IDS.length; i++) {
        await expect(page.getByText(`Multi Task PW ${i + 1}`)).toBeVisible({ timeout: 5_000 });
      }

      // The interval task should show schedule indicator
      await expect(page.getByText('every 15m')).toBeVisible();

      // Each task should have a Run button
      const runButtons = page.locator('button').filter({ hasText: 'Run' });
      expect(await runButtons.count()).toBeGreaterThanOrEqual(3);

      // Clean up
      const sw = new ServiceWorkerHelper(page);
      for (const id of TASK_IDS) {
        await sw.deleteTask(id).catch(() => {});
      }

      await page.close();
    });
  });
});
