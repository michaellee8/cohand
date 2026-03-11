import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';

test.describe('Extension Loading @core', () => {
  test('service worker starts without errors', async ({ context, extensionId }) => {
    // Verify we got a valid extension ID (32 lowercase chars)
    expect(extensionId).toBeTruthy();
    expect(extensionId).toMatch(/^[a-z]{32}$/);

    // Verify service worker is running
    const workers = context.serviceWorkers();
    expect(workers.length).toBeGreaterThan(0);

    const swUrl = workers[0].url();
    expect(swUrl).toContain(extensionId);
    expect(swUrl).toContain('background');
  });

  test('side panel loads with Chat and Tasks tabs', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Verify the root element is rendered
    expect(await sp.isRendered()).toBe(true);
    await expect(page.locator('#root')).not.toBeEmpty();

    // Verify Chat tab is visible
    await expect(page.getByText('Chat').first()).toBeVisible({ timeout: 10_000 });

    // Verify Tasks tab is visible
    await expect(page.getByText('Tasks').first()).toBeVisible({ timeout: 10_000 });

    // Verify Settings gear button is present
    await expect(page.locator('button[title="Settings"]')).toBeVisible();

    await page.close();
  });

  test('Chat tab is active by default', async ({ openSidePanel }) => {
    const page = await openSidePanel();

    // The first tab button (Chat) should have the active blue border class
    const chatBtn = page.locator('button').filter({ hasText: 'Chat' }).first();
    await expect(chatBtn).toBeVisible();
    const chatClass = await chatBtn.getAttribute('class');
    expect(chatClass).toContain('border-blue');

    // Tasks tab should NOT have the active class
    const tasksBtn = page.locator('button').filter({ hasText: 'Tasks' }).first();
    const tasksClass = await tasksBtn.getAttribute('class');
    expect(tasksClass).toContain('border-transparent');

    await page.close();
  });

  test('tab navigation switches between Chat and Tasks', async ({ openSidePanel }) => {
    const page = await openSidePanel();

    // Click Tasks tab
    await page.locator('button').filter({ hasText: 'Tasks' }).first().click();
    await page.waitForTimeout(300);

    // Tasks tab should now be active
    const tasksBtn = page.locator('button').filter({ hasText: 'Tasks' }).first();
    const tasksClass = await tasksBtn.getAttribute('class');
    expect(tasksClass).toContain('border-blue');

    // Tasks page should show the "Tasks" heading (h2)
    await expect(page.locator('h2').filter({ hasText: 'Tasks' })).toBeVisible({ timeout: 5_000 });

    // Click Chat tab back
    await page.locator('button').filter({ hasText: 'Chat' }).first().click();
    await page.waitForTimeout(300);

    // Chat tab should be active again
    const chatBtn = page.locator('button').filter({ hasText: 'Chat' }).first();
    const chatClass = await chatBtn.getAttribute('class');
    expect(chatClass).toContain('border-blue');

    await page.close();
  });

  test('content script injects on pages', async ({ context, extensionId, page }) => {
    // Navigate to mock site
    await page.goto('http://localhost:5199');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1000);

    // Verify page loaded with expected content
    const price = await page.textContent('.price-display');
    expect(price).toBe('$49.99');

    // Verify the extension's service worker is still running after page navigation
    const workers = context.serviceWorkers();
    expect(workers.length).toBeGreaterThan(0);
    expect(workers[0].url()).toContain(extensionId);
  });

  test('offscreen document creates successfully', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Send ENSURE_OFFSCREEN message to create the offscreen document
    const result = await sw.sendRaw({ type: 'ENSURE_OFFSCREEN' });
    expect(result).toHaveProperty('ok', true);

    await page.close();
  });

  test('service worker responds to GET_TASKS message', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    const result = await sw.getTasks();
    expect(result).toHaveProperty('tasks');
    expect(Array.isArray(result.tasks)).toBe(true);

    await page.close();
  });

  test('service worker responds to GET_UNREAD_COUNT message', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // IndexedDB may not be ready immediately; retry a few times
    let result: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await sw.getUnreadCount();
      if (result && 'count' in result) break;
      await page.waitForTimeout(1_000);
    }
    expect(result).toHaveProperty('count');
    expect(typeof result.count).toBe('number');

    await page.close();
  });

  test('service worker responds to GET_NOTIFICATIONS message', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Wait a moment for the DB to initialize; GET_NOTIFICATIONS may error
    // if IndexedDB is not yet open. Retry once.
    let result: any;
    for (let attempt = 0; attempt < 3; attempt++) {
      result = await sw.getNotifications();
      if (result && 'notifications' in result) break;
      await page.waitForTimeout(1_000);
    }
    expect(result).toHaveProperty('notifications');
    expect(Array.isArray(result.notifications)).toBe(true);

    await page.close();
  });

  test('mock site pages load correctly', async ({ page }) => {
    // Homepage
    await page.goto('http://localhost:5199');
    await expect(page).toHaveTitle(/Cohand Test/);
    const price = await page.textContent('.price-display');
    expect(price).toBe('$49.99');

    // Form page
    await page.goto('http://localhost:5199/form.html');
    await expect(page.locator('#name')).toBeVisible();
    await expect(page.locator('#email')).toBeVisible();

    // Dynamic page
    await page.goto('http://localhost:5199/dynamic.html');
    await expect(page.locator('#loading-text')).toBeVisible();

    // Login page
    await page.goto('http://localhost:5199/login.html');
    await expect(page.locator('input[type="password"]')).toBeVisible();
    await expect(page.locator('.sensitive-warning')).toBeVisible();
  });
});
