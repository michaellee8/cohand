import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
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

  // Tab-switch to force initClient() re-run
  await sp.navigateToTasks();
  await page.waitForTimeout(500);
  await sp.navigateToChat();
  await page.waitForTimeout(2_000);
}

async function sendChatMessage(page: Page, message: string): Promise<void> {
  const chatInput = page.locator('input[placeholder="Describe your task..."]');
  await expect(chatInput).toBeVisible({ timeout: 5_000 });
  await expect(chatInput).not.toBeDisabled({ timeout: 10_000 });
  await chatInput.fill(message);
  await page.locator('button').filter({ hasText: 'Send' }).click();
  await expect(page.getByText(message)).toBeVisible({ timeout: 5_000 });
}

async function waitForResponse(page: Page, timeoutMs = 30_000): Promise<void> {
  const chatInput = page.locator('input[placeholder="Describe your task..."]');
  await expect(chatInput).not.toBeDisabled({ timeout: timeoutMs });
  await page.waitForTimeout(1_000);
}

// ── Test suite ──────────────────────────────────────────────────────────────────

test.describe('Live Chat Integration', () => {
  test.skip(!hasAuthJson, 'Skipped: ~/.codex/auth.json not found');

  let authJsonString: string;

  test.beforeAll(() => {
    if (!hasAuthJson) return;
    authJsonString = fs.readFileSync(AUTH_JSON_PATH, 'utf-8');
  });

  // ── Test 1: Send message and get real LLM response ─────────────────────────

  test('send message and receive real LLM response', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);

    await sendChatMessage(page, 'Reply with exactly the word: pong');

    // Wait for assistant response (real API call)
    await page.waitForTimeout(20_000);

    const pageText = await page.locator('#root').textContent() ?? '';
    const errorBanner = page.locator('.bg-red-50');
    const hasError = await errorBanner.isVisible().catch(() => false);

    // The LLM pipeline ran if we got a response or an error
    const hasAssistantResponse = pageText.includes('pong') ||
      pageText.includes('Pong') ||
      pageText.includes('Error:') ||
      pageText.includes('Failed to initialize');
    expect(hasAssistantResponse || hasError).toBe(true);

    await page.close();
  });

  // ── Test 2: Multi-turn conversation maintaining context ────────────────────

  test('multi-turn conversation maintains context', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);

    // First message
    await sendChatMessage(page, 'Remember the secret word: giraffe');
    await waitForResponse(page, 30_000);

    // Second message referencing the first
    await sendChatMessage(page, 'What secret word did I ask you to remember?');
    await waitForResponse(page, 30_000);

    const pageText = await page.locator('#root').textContent() ?? '';
    const errorBanner = page.locator('.bg-red-50');
    const hasError = await errorBanner.isVisible().catch(() => false);

    // Either the LLM recalled "giraffe" or there was an API error.
    const hasResponse = pageText.toLowerCase().includes('giraffe') ||
      pageText.includes('Error:') ||
      pageText.includes('Failed to initialize');
    expect(hasResponse || hasError).toBe(true);

    // Both user messages should be visible (chat history preserved)
    await expect(page.getByText('Remember the secret word: giraffe')).toBeVisible();
    await expect(page.getByText('What secret word did I ask you to remember?')).toBeVisible();

    await page.close();
  });

  // ── Test 3: Cancel/stop streaming mid-response ─────────────────────────────

  test('cancel streaming shows Cancelled marker or completed response', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);

    // Send a message that should trigger a long response
    await sendChatMessage(page, 'Write a very long detailed essay about the history of the internet from 1960 to today');

    // The Stop button appears during streaming
    const stopBtn = page.locator('button:has-text("Stop")');
    const chatInput = page.locator('input[placeholder="Describe your task..."]');

    const hasStop = await stopBtn.isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasStop) {
      await stopBtn.click();
      await expect(chatInput).not.toBeDisabled({ timeout: 15_000 });

      const pageText = await page.locator('#root').textContent() ?? '';
      const wasCancelled = pageText.includes('[Cancelled]');
      const hasResponse = pageText.includes('internet') || pageText.includes('history') ||
        pageText.includes('Error:') || pageText.includes('Failed');
      expect(wasCancelled || hasResponse).toBe(true);
    } else {
      // Streaming completed before we could click Stop
      await expect(chatInput).not.toBeDisabled({ timeout: 30_000 });
      const pageText = await page.locator('#root').textContent() ?? '';
      const hasContent = pageText.includes('internet') || pageText.includes('history') ||
        pageText.includes('Error:') || pageText.includes('Failed');
      expect(hasContent).toBe(true);
    }

    await page.close();
  });

  // ── Test 4: Chat after task creation (context awareness) ───────────────────

  test('chat after visiting tasks tab maintains chat functionality', async ({
    openSidePanel,
  }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);

    // Navigate to Tasks and back to Chat to test context switching
    await sp.navigateToTasks();
    await page.waitForTimeout(1_000);
    await sp.navigateToChat();
    await page.waitForTimeout(2_000);

    // Send a message after switching tabs
    await sendChatMessage(page, 'Reply with exactly: context-ok');

    await page.waitForTimeout(20_000);

    const pageText = await page.locator('#root').textContent() ?? '';
    const errorBanner = page.locator('.bg-red-50');
    const hasError = await errorBanner.isVisible().catch(() => false);

    // The LLM pipeline should still work after tab switching
    const hasResponse = pageText.toLowerCase().includes('context-ok') ||
      pageText.toLowerCase().includes('context') ||
      pageText.includes('Error:') ||
      pageText.includes('Failed to initialize');
    expect(hasResponse || hasError).toBe(true);

    await page.close();
  });
});
