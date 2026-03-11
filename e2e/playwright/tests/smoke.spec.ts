import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import { MockLLMServer } from '../helpers/mock-llm-server';

test.describe('Smoke Tests', () => {
  test('extension loads and service worker is active', async ({ context, extensionId }) => {
    // Verify we got a valid extension ID
    expect(extensionId).toBeTruthy();
    expect(extensionId).toMatch(/^[a-z]{32}$/);

    // Verify service worker is running
    const workers = context.serviceWorkers();
    expect(workers.length).toBeGreaterThan(0);

    const swUrl = workers[0].url();
    expect(swUrl).toContain(extensionId);
    expect(swUrl).toContain('background');
  });

  test('side panel renders correctly', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sidePanel = new SidePanel(page);

    // Verify the root element is rendered
    expect(await sidePanel.isRendered()).toBe(true);

    // Verify the app content loads (check for tab bar)
    await expect(page.locator('#root')).not.toBeEmpty();

    // Look for tab navigation elements (Chat, Tasks)
    await expect(page.getByText('Chat').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByText('Tasks').first()).toBeVisible({ timeout: 10_000 });

    await page.close();
  });

  test('service worker responds to messages', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sw = new ServiceWorkerHelper(page);

    // Test GET_TASKS — should return an array (empty initially)
    const result = await sw.getTasks();
    expect(result).toHaveProperty('tasks');
    expect(Array.isArray(result.tasks)).toBe(true);

    // Test GET_UNREAD_COUNT
    const unreadResult = await sw.getUnreadCount();
    expect(unreadResult).toHaveProperty('count');
    expect(typeof unreadResult.count).toBe('number');

    await page.close();
  });

  test('mock LLM server works', async () => {
    const server = new MockLLMServer();
    const baseUrl = await server.start();

    try {
      // Test health endpoint
      const healthRes = await fetch(`${baseUrl}/health`);
      expect(healthRes.ok).toBe(true);
      const healthJson = await healthRes.json();
      expect(healthJson.status).toBe('ok');

      // Test chat completions (non-streaming)
      server.setDefaultResponse({ content: 'Hello from mock!' });
      const chatRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'test' }],
        }),
      });
      expect(chatRes.ok).toBe(true);
      const chatJson = await chatRes.json();
      expect(chatJson.choices[0].message.content).toBe('Hello from mock!');

      // Test streaming response
      server.setResponses([{ content: 'Streamed response' }]);
      const streamRes = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-5.4',
          messages: [{ role: 'user', content: 'test' }],
          stream: true,
        }),
      });
      expect(streamRes.ok).toBe(true);
      const streamText = await streamRes.text();
      expect(streamText).toContain('data:');
      expect(streamText).toContain('[DONE]');
      expect(streamText).toContain('Streamed');

      // Test request logging
      const log = server.getRequestLog();
      expect(log.length).toBe(3); // health + 2 completions
    } finally {
      await server.stop();
    }
  });

  test('mock site is accessible', async ({ page }) => {
    await page.goto('http://localhost:5199');
    await expect(page).toHaveTitle(/.*/);
    // Verify the page loaded with some content
    const body = await page.textContent('body');
    expect(body).toBeTruthy();
  });
});
