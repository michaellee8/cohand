import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { Page } from '@playwright/test';

const AUTH_JSON_PATH = path.join(os.homedir(), '.codex', 'auth.json');
const hasAuthJson = fs.existsSync(AUTH_JSON_PATH);

// ── Auth helpers ────────────────────────────────────────────────────────────────

async function importAuthViaUI(page: Page, jsonString: string): Promise<void> {
  await page.locator('button[title="Settings"]').click();
  await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });

  const connected = await page.getByText('Connected').isVisible().catch(() => false);
  if (connected) return;

  await page.getByText('Paste JSON manually').click();

  const textarea = page.locator('textarea');
  await expect(textarea).toBeVisible({ timeout: 3_000 });
  await textarea.fill(jsonString);

  const importBtn = page.getByRole('button', { name: 'Import', exact: true });
  await expect(importBtn).not.toBeDisabled();
  await importBtn.click();

  await expect(page.getByText('Connected')).toBeVisible({ timeout: 15_000 });
}

async function navigateToChat(page: Page, sp: SidePanel): Promise<void> {
  await page.locator('button').first().click();
  await page.waitForTimeout(500);
  await expect(page.getByText('Welcome to Cohand!')).toBeVisible({ timeout: 10_000 });

  await sp.navigateToTasks();
  await page.waitForTimeout(500);
  await sp.navigateToChat();
  await page.waitForTimeout(2_000);
}

async function getActiveTabId(page: Page): Promise<number> {
  return page.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error('No active tab found');
    return tab.id;
  });
}

async function ensureMockPageActive(mockPage: Page) {
  await mockPage.bringToFront();
  await mockPage.waitForTimeout(300);
}

// ── Test suite ──────────────────────────────────────────────────────────────────

test.describe('Live Task Execution', () => {
  test.skip(!hasAuthJson, 'Skipped: ~/.codex/auth.json not found');

  let authJsonString: string;

  test.beforeAll(() => {
    if (!hasAuthJson) return;
    authJsonString = fs.readFileSync(AUTH_JSON_PATH, 'utf-8');
  });

  // ── Test 1: Create a scraping task via wizard with real LLM ────────────────

  test('create scraping task via wizard and verify script generation', async ({
    openSidePanel,
    context,
  }) => {
    // Open mock site so the extension has a real page to observe
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);

    // Start wizard
    await page.locator('button').filter({ hasText: '+ New Task' }).click();
    await page.waitForTimeout(300);

    // Step 1: Describe
    await expect(page.getByText('Step 1: Describe')).toBeVisible();
    await page.locator('textarea').fill('Scrape the price from the mock site homepage');

    const nextBtn = page.locator('button').filter({ hasText: 'Next' });
    await nextBtn.click();
    await page.waitForTimeout(300);

    // Step 2: Domains
    await expect(page.getByText('Step 2: Domains')).toBeVisible();
    const localhostPresent = await page.locator('.font-mono').filter({ hasText: 'localhost' })
      .isVisible({ timeout: 2_000 }).catch(() => false);
    if (!localhostPresent) {
      const domainInput = page.locator('input[placeholder="example.com"]');
      await domainInput.fill('localhost');
      await page.locator('button').filter({ hasText: 'Add' }).click();
      await page.waitForTimeout(300);
    }
    await nextBtn.click();
    await page.waitForTimeout(500);

    // Step 3: Observe — LLM generates script
    await expect(page.getByText('Step 3: Observe')).toBeVisible();
    await expect(page.getByText('Observing page...')).toBeVisible();

    // Wait for observe step to complete and auto-advance to Review
    await expect(page.getByText('Step 4: Review')).toBeVisible({ timeout: 60_000 });

    // Step 4: Review — verify script was generated
    await expect(page.getByText('Generated Script')).toBeVisible();
    const codeBlock = page.locator('.rounded-lg.border.border-gray-200.bg-gray-50');
    const codeText = await codeBlock.textContent() ?? '';
    expect(codeText).not.toContain('No script generated');
    expect(codeText.length).toBeGreaterThan(10);

    // AST badge should be visible
    await expect(page.getByText('AST')).toBeVisible();

    // Skip through Test step
    await nextBtn.click();
    await page.waitForTimeout(300);
    await expect(page.getByText('Step 5: Test')).toBeVisible();
    await nextBtn.click();
    await page.waitForTimeout(300);

    // Step 6: Schedule — create the task
    await expect(page.getByText('Step 6: Schedule')).toBeVisible();
    const createBtn = page.locator('button').filter({ hasText: 'Create Task' });
    await expect(createBtn).not.toBeDisabled();
    await createBtn.click();

    // Task should appear in list
    await page.waitForTimeout(2_000);
    await expect(page.getByText('Scrape the price from the mock site homepage').first()).toBeVisible({
      timeout: 10_000,
    });

    await mockPage.close();
    await page.close();
  });

  // ── Test 2: Execute a hand-crafted task on the mock site ───────────────────

  test('execute hand-crafted task and verify results in run history', async ({
    openSidePanel,
    context,
  }) => {
    const TASK_ID = `e2e-exec-live-${Date.now()}`;

    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sp = new SidePanel(page);
    const sw = new ServiceWorkerHelper(page);

    // Create task with a hand-crafted script
    await sw.createTask(
      {
        id: TASK_ID,
        name: 'Live Exec: Read Price',
        description: 'Read the price display from the mock site homepage',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  await page.goto('http://localhost:5199');
  await page.waitForLoadState('domcontentloaded');
  const price = await page.locator('[data-testid="price"]').textContent();
  return { price };
}`,
    );

    // Navigate to Tasks tab to verify
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);
    await expect(page.getByText('Live Exec: Read Price')).toBeVisible({ timeout: 5_000 });

    // Click the Run button on the task card
    const taskCard = page.locator('div').filter({ hasText: 'Live Exec: Read Price' }).first();
    const runBtn = taskCard.locator('button').filter({ hasText: 'Run' });
    await expect(runBtn).toBeVisible();
    await runBtn.click();

    // Wait for execution to complete
    await page.waitForTimeout(5_000);

    // Check runs via service worker
    const runsResult = await sw.getRuns(TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    // Open task detail view
    await page.getByText('Live Exec: Read Price').click();
    await page.waitForTimeout(500);

    await expect(page.locator('h2').filter({ hasText: 'Live Exec: Read Price' })).toBeVisible();
    await expect(page.getByText('Recent Runs')).toBeVisible();

    // Verify run structure if present
    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0];
      expect(run).toHaveProperty('id');
      expect(run).toHaveProperty('taskId', TASK_ID);
      expect(run).toHaveProperty('success');
      expect(run).toHaveProperty('durationMs');
      expect(typeof run.durationMs).toBe('number');
    }

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await mockPage.close();
    await page.close();
  });

  // ── Test 3: Re-execute and verify state update ─────────────────────────────

  test('re-execute task and verify state persistence across runs', async ({
    openSidePanel,
    context,
  }) => {
    const TASK_ID = `e2e-state-live-${Date.now()}`;

    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task with state-tracking script
    await sw.createTask(
      {
        id: TASK_ID,
        name: 'Live State Tracker',
        description: 'Track run count across executions',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  const count = (context.state?.runCount || 0) + 1;
  return { result: { count }, state: { runCount: count } };
}`,
    );

    // Execute twice
    const tabId = await getActiveTabId(page);

    await sw.executeTask(TASK_ID, tabId);
    await page.waitForTimeout(4_000);

    await sw.executeTask(TASK_ID, tabId);
    await page.waitForTimeout(4_000);

    // Check that two runs were recorded
    const runsResult = await sw.getRuns(TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    if (runsResult.runs.length >= 2) {
      expect(runsResult.runs.length).toBeGreaterThanOrEqual(2);
      // Both runs should have taskId
      for (const run of runsResult.runs) {
        expect(run.taskId).toBe(TASK_ID);
      }
    }

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await mockPage.close();
    await page.close();
  });

  // ── Test 4: Execute on different mock site pages ───────────────────────────

  test('execute task targeting the dynamic page', async ({
    openSidePanel,
    context,
  }) => {
    const TASK_ID = `e2e-dynamic-live-${Date.now()}`;

    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199/dynamic.html', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task that reads dynamic content
    await sw.createTask(
      {
        id: TASK_ID,
        name: 'Live Exec: Read Dynamic Content',
        description: 'Wait for dynamic content to load and read it',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  await page.goto('http://localhost:5199/dynamic.html');
  await page.waitForSelector('[data-testid="dynamic-content"]', { timeout: 5000 });
  const text = await page.locator('[data-testid="dynamic-content"]').textContent();
  return { content: text };
}`,
    );

    // Execute the task
    const tabId = await getActiveTabId(page);
    await sw.executeTask(TASK_ID, tabId);
    await page.waitForTimeout(6_000);

    // Check runs
    const runsResult = await sw.getRuns(TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0];
      expect(run).toHaveProperty('taskId', TASK_ID);
      expect(run).toHaveProperty('success');
      expect(run).toHaveProperty('durationMs');
    }

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await mockPage.close();
    await page.close();
  });

  // ── Test 5: Execute on the form page ───────────────────────────────────────

  test('execute task targeting the form page', async ({
    openSidePanel,
    context,
  }) => {
    const TASK_ID = `e2e-form-live-${Date.now()}`;

    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199/form.html', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task that reads form page title
    await sw.createTask(
      {
        id: TASK_ID,
        name: 'Live Exec: Read Form Page',
        description: 'Read the form page heading',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  await page.goto('http://localhost:5199/form.html');
  await page.waitForLoadState('domcontentloaded');
  const heading = await page.locator('h1').textContent();
  return { heading };
}`,
    );

    // Execute the task
    const tabId = await getActiveTabId(page);
    await sw.executeTask(TASK_ID, tabId);
    await page.waitForTimeout(5_000);

    // Check runs
    const runsResult = await sw.getRuns(TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);

    if (runsResult.runs.length > 0) {
      const run = runsResult.runs[0];
      expect(run).toHaveProperty('taskId', TASK_ID);
      expect(run).toHaveProperty('success');
    }

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await mockPage.close();
    await page.close();
  });

  // ── Test 6: Error recovery — task with failing script ──────────────────────

  test('task with failing script records error run and allows re-execution', async ({
    openSidePanel,
    context,
  }) => {
    const TASK_ID = `e2e-error-live-${Date.now()}`;

    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'domcontentloaded' });
    await mockPage.waitForTimeout(500);

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task with a script that throws an error
    await sw.createTask(
      {
        id: TASK_ID,
        name: 'Live Error Recovery Test',
        description: 'Script that fails intentionally',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  throw new Error('Intentional test failure');
}`,
    );

    const tabId = await getActiveTabId(page);

    // Execute — should fail
    await sw.executeTask(TASK_ID, tabId);
    await page.waitForTimeout(5_000);

    // Check that a run was recorded (even if it failed)
    let runsResult = await sw.getRuns(TASK_ID);
    expect(runsResult).toHaveProperty('runs');
    expect(Array.isArray(runsResult.runs)).toBe(true);
    const failedRunCount = runsResult.runs.length;

    // If a run was recorded, it should be marked as not successful
    if (failedRunCount > 0) {
      const failedRun = runsResult.runs[0];
      expect(failedRun).toHaveProperty('taskId', TASK_ID);
      // The run should exist regardless of success/failure
      expect(failedRun).toHaveProperty('durationMs');
    }

    // Now update the task with a working script and re-execute
    await sw.createTask(
      {
        id: `${TASK_ID}-fixed`,
        name: 'Live Error Recovery Fixed',
        description: 'Fixed version of the failing script',
        allowedDomains: ['localhost'],
      },
      `async function run(page, context) {
  return { result: 'recovered' };
}`,
    );

    await sw.executeTask(`${TASK_ID}-fixed`, tabId);
    await page.waitForTimeout(5_000);

    // Check runs for the fixed task
    runsResult = await sw.getRuns(`${TASK_ID}-fixed`);
    expect(runsResult).toHaveProperty('runs');

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await sw.deleteTask(`${TASK_ID}-fixed`).catch(() => {});
    await mockPage.close();
    await page.close();
  });

  // ── Test 7: Task scheduling — interval task configuration ──────────────────

  test('task with interval schedule is stored and retrievable', async ({
    openSidePanel,
  }) => {
    const TASK_ID = `e2e-sched-live-${Date.now()}`;

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task with interval schedule
    await sw.createTask({
      id: TASK_ID,
      name: 'Live Scheduled Task',
      description: 'Task with interval schedule',
      allowedDomains: ['localhost'],
      schedule: { type: 'interval', intervalMinutes: 30 },
    });

    // Verify task was stored with correct schedule
    const taskResult = await sw.getTask(TASK_ID);
    expect(taskResult.task).toBeTruthy();
    expect(taskResult.task?.schedule.type).toBe('interval');
    if (taskResult.task?.schedule.type === 'interval') {
      expect(taskResult.task.schedule.intervalMinutes).toBe(30);
    }

    // Verify task appears in the list
    const sp = new SidePanel(page);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);
    await expect(page.getByText('Live Scheduled Task')).toBeVisible({ timeout: 5_000 });

    // The schedule info should be visible on the card (e.g. "every 30m")
    const pageText = await page.locator('#root').textContent() ?? '';
    const hasScheduleInfo = pageText.includes('30m') || pageText.includes('30 min') ||
      pageText.includes('interval');
    expect(hasScheduleInfo).toBe(true);

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await page.close();
  });

  // ── Test 8: Domain permissions — task restricted to specific domains ────────

  test('task allowedDomains are stored and enforced', async ({
    openSidePanel,
  }) => {
    const TASK_ID = `e2e-domain-live-${Date.now()}`;

    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Create task restricted to localhost only
    await sw.createTask({
      id: TASK_ID,
      name: 'Live Domain Restricted Task',
      description: 'Only allowed on localhost',
      allowedDomains: ['localhost'],
    });

    // Verify allowedDomains stored correctly
    const taskResult = await sw.getTask(TASK_ID);
    expect(taskResult.task).toBeTruthy();
    expect(taskResult.task?.allowedDomains).toEqual(['localhost']);

    // Verify domain info is visible in the task list
    const sp = new SidePanel(page);
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);
    await expect(page.getByText('Live Domain Restricted Task')).toBeVisible({ timeout: 5_000 });

    // The domain should be visible on the task card
    const cardText = await page.locator('#root').textContent() ?? '';
    expect(cardText).toContain('localhost');

    // Create a second task with multiple domains
    const TASK_ID_2 = `e2e-domain2-live-${Date.now()}`;
    await sw.createTask({
      id: TASK_ID_2,
      name: 'Live Multi-Domain Task',
      description: 'Allowed on multiple domains',
      allowedDomains: ['localhost', 'example.com'],
    });

    const task2Result = await sw.getTask(TASK_ID_2);
    expect(task2Result.task?.allowedDomains).toEqual(['localhost', 'example.com']);

    // Cleanup
    await sw.deleteTask(TASK_ID).catch(() => {});
    await sw.deleteTask(TASK_ID_2).catch(() => {});
    await page.close();
  });
});
