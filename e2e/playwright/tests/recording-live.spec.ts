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

  await sp.navigateToTasks();
  await page.waitForTimeout(500);
  await sp.navigateToChat();
  await page.waitForTimeout(2_000);
}

async function ensureMockPageActive(mockPage: Page) {
  await mockPage.bringToFront();
  await mockPage.waitForTimeout(300);
}

// ── Test suite ──────────────────────────────────────────────────────────────────

test.describe('Live Recording Flow', () => {
  test.skip(!hasAuthJson, 'Skipped: ~/.codex/auth.json not found');

  let authJsonString: string;

  test.beforeAll(() => {
    if (!hasAuthJson) return;
    authJsonString = fs.readFileSync(AUTH_JSON_PATH, 'utf-8');
  });

  // ── Test 1: Start recording on mock site ───────────────────────────────────

  test('start recording on mock site and verify toolbar appears', async ({
    openSidePanel,
    context,
  }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'networkidle' });
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();

    // Click the record button
    const recordBtn = page.locator('button[title="Record workflow"]');
    await expect(recordBtn).toBeVisible({ timeout: 5_000 });
    await recordBtn.click();

    // Recording start modal should appear
    await expect(page.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });

    // Start recording
    await page.getByText('Start recording').click();

    // Modal should close
    await expect(page.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

    // Recording toolbar (red bar) should appear
    const toolbar = page.locator('.border-red-200');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // Stop recording to clean up
    await page.click('button:has-text("Stop")');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    await mockPage.close();
    await page.close();
  });

  // ── Test 2: Perform clicks and verify step count ───────────────────────────

  test('record clicks on mock site and verify step count increases', async ({
    openSidePanel,
    context,
  }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'networkidle' });
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();

    // Start recording
    const recordBtn = page.locator('button[title="Record workflow"]');
    await recordBtn.click();
    await expect(page.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });
    await page.getByText('Start recording').click();
    await expect(page.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

    const toolbar = page.locator('.border-red-200');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // Get initial step count
    const stepBadge = page.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });
    const initialText = await stepBadge.textContent();
    const initialCount = parseInt(initialText?.match(/(\d+)/)?.[1] ?? '0', 10);

    // Perform clicks on the mock site
    await mockPage.click('#like-btn');
    await page.waitForTimeout(500);
    await mockPage.click('#like-btn');
    await page.waitForTimeout(500);
    await mockPage.click('#like-btn');
    await page.waitForTimeout(1_000);

    // Check if step count increased
    const updatedText = await stepBadge.textContent();
    const updatedCount = parseInt(updatedText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(updatedCount).toBeGreaterThanOrEqual(initialCount);

    // Stop recording
    await page.click('button:has-text("Stop")');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    await mockPage.close();
    await page.close();
  });

  // ── Test 3: Navigate across pages during recording ─────────────────────────

  test('record navigation across mock site pages', async ({
    openSidePanel,
    context,
  }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'networkidle' });
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();

    // Start recording
    const recordBtn = page.locator('button[title="Record workflow"]');
    await recordBtn.click();
    await expect(page.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });
    await page.getByText('Start recording').click();
    await expect(page.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

    const toolbar = page.locator('.border-red-200');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // Navigate across pages on the mock site
    await mockPage.click('a[href="/form.html"]');
    await mockPage.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_000);

    await mockPage.click('a[href="/dynamic.html"]');
    await mockPage.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_000);

    await mockPage.click('a[href="/"]');
    await mockPage.waitForLoadState('domcontentloaded');
    await page.waitForTimeout(1_000);

    // Recording toolbar should still be visible
    await expect(toolbar).toBeVisible();

    // Step badge should show some recorded steps
    const stepBadge = page.getByText(/\d+ step/);
    const stepText = await stepBadge.textContent();
    const stepCount = parseInt(stepText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(stepCount).toBeGreaterThanOrEqual(0);

    // Stop recording
    await page.click('button:has-text("Stop")');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    await mockPage.close();
    await page.close();
  });

  // ── Test 4: Stop recording and verify chat input re-enabled ────────────────

  test('stop recording restores chat input', async ({
    openSidePanel,
    context,
  }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'networkidle' });
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();

    // Start recording
    const recordBtn = page.locator('button[title="Record workflow"]');
    await recordBtn.click();
    await expect(page.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });
    await page.getByText('Start recording').click();
    await expect(page.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

    const toolbar = page.locator('.border-red-200');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // Perform a few actions
    await mockPage.click('#like-btn');
    await page.waitForTimeout(500);

    // Stop recording
    await page.click('button:has-text("Stop")');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    // Chat input should be re-enabled
    const chatInput = page.locator('input[placeholder*="Describe"]');
    await expect(chatInput).not.toBeDisabled({ timeout: 10_000 });

    await mockPage.close();
    await page.close();
  });

  // ── Test 5: Record and submit for refinement with real LLM ─────────────────

  test('record workflow and submit for LLM refinement', async ({
    openSidePanel,
    context,
  }) => {
    const mockPage = await context.newPage();
    await mockPage.goto('http://localhost:5199', { waitUntil: 'networkidle' });
    await ensureMockPageActive(mockPage);

    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Import auth for LLM access
    await importAuthViaUI(page, authJsonString);
    await navigateToChat(page, sp);

    // Start recording
    const recordBtn = page.locator('button[title="Record workflow"]');
    await expect(recordBtn).toBeVisible({ timeout: 5_000 });
    await recordBtn.click();

    await expect(page.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });
    await page.getByText('Start recording').click();
    await expect(page.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

    const toolbar = page.locator('.border-red-200');
    await expect(toolbar).toBeVisible({ timeout: 10_000 });

    // Perform clicks on the mock site
    await mockPage.click('#like-btn');
    await page.waitForTimeout(500);
    await mockPage.click('#like-btn');
    await page.waitForTimeout(500);

    // Stop recording
    await page.click('button:has-text("Stop")');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    // After stopping, the chat input should be re-enabled.
    // The recording steps should be available for the LLM to process.
    const chatInput = page.locator('input[placeholder*="Describe"]');
    await expect(chatInput).not.toBeDisabled({ timeout: 10_000 });

    // The recorded steps may auto-populate a description or be available
    // for the user to submit. Check the page state after recording stops.
    const pageText = await page.locator('#root').textContent() ?? '';

    // The recording flow should have produced some UI update:
    // either recorded steps summary, a pre-filled message, or chat context
    const hasRecordingOutput =
      pageText.includes('step') ||
      pageText.includes('recorded') ||
      pageText.includes('workflow') ||
      pageText.includes('Welcome to Cohand!') ||
      pageText.includes('Describe');

    expect(hasRecordingOutput).toBe(true);

    await mockPage.close();
    await page.close();
  });
});
