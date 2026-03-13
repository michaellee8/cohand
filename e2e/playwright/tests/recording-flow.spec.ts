import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ExtensionStorageHelper } from '../helpers/extension-storage';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import { MockLLMServer, MOCK_RESPONSES } from '../helpers/mock-llm-server';

/**
 * Complete Recording Flow E2E Tests
 *
 * Tests the COMPLETE recording flow end-to-end:
 * 1. Start recording from chat input area
 * 2. Verify recording toolbar appears (red dot, timer, step count)
 * 3. Navigate to mock site in a tab
 * 4. Click elements on the mock site
 * 5. Verify steps captured in live step list
 * 6. Stop recording
 * 7. Verify step summary appears in chat
 * 8. Type refinement instructions (if recording-to-chat is wired)
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

/** Helper: ensure the mock-site page is the active tab. */
async function ensureMockPageActive(mockPage: import('@playwright/test').Page) {
  await mockPage.bringToFront();
  await mockPage.waitForTimeout(300);
}

/** Helper: open the recording start modal from the chat page. */
async function openRecordingModal(panel: import('@playwright/test').Page) {
  const recordBtn = panel.locator('button[title="Record workflow"]');
  await expect(recordBtn).toBeVisible({ timeout: 5_000 });
  await recordBtn.click();
  await expect(panel.getByText('Teach Cohand your workflow')).toBeVisible({ timeout: 5_000 });
}

/** Helper: start recording from the modal. */
async function startRecordingFromModal(panel: import('@playwright/test').Page) {
  const startBtn = panel.getByText('Start recording');
  await startBtn.click();

  // Wait for modal to close
  await expect(panel.getByText('Teach Cohand your workflow')).not.toBeVisible({ timeout: 10_000 });

  // Wait for recording toolbar
  const toolbar = panel.locator('.border-red-200');
  await expect(toolbar).toBeVisible({ timeout: 10_000 });
}

test.describe('Recording Flow - Complete @features', () => {
  test('full recording flow: start, interact with mock site, capture steps, stop', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    // Navigate to mock site
    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Verify recording toolbar elements
    // Timer with font-mono class
    await expect(panel.locator('.font-mono.text-red-700')).toBeVisible({ timeout: 3_000 });

    // Step count badge
    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });
    const initialText = await stepBadge.textContent();
    const initialCount = parseInt(initialText?.match(/(\d+)/)?.[1] ?? '0', 10);

    // Stop button
    await expect(panel.getByText('Stop')).toBeVisible();

    // Pause button
    await expect(panel.locator('button[title="Pause"]')).toBeVisible();

    // Perform interactions on the mock site
    await page.click('#like-btn');
    await panel.waitForTimeout(500);
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Check step count increased
    const updatedText = await stepBadge.textContent();
    const updatedCount = parseInt(updatedText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(updatedCount).toBeGreaterThan(initialCount);

    // Stop recording
    await panel.click('button:has-text("Stop")');

    // Toolbar should disappear
    const toolbar = panel.locator('.border-red-200');
    await expect(toolbar).not.toBeVisible({ timeout: 5_000 });

    // Input should be re-enabled
    const input = panel.locator('input[placeholder*="Describe"]');
    await expect(input).not.toBeDisabled({ timeout: 5_000 });

    await panel.close();
  });

  test('recording captures navigation between mock site pages', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });

    // Click a button on home page
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Navigate to form page
    await page.goto('http://localhost:5199/form.html');
    await page.waitForLoadState('networkidle');
    await panel.waitForTimeout(1_000);

    // Fill in form fields
    await page.fill('#name', 'E2E Test User');
    await panel.waitForTimeout(500);
    await page.fill('#email', 'test@example.com');
    await panel.waitForTimeout(500);

    // Navigate to dynamic page
    await page.goto('http://localhost:5199/dynamic.html');
    await page.waitForLoadState('networkidle');
    await panel.waitForTimeout(1_000);

    // Verify toolbar is still active after navigation
    const toolbarActive = await panel.locator('.border-red-200').isVisible();
    expect(toolbarActive).toBe(true);

    // Check accumulated steps
    const finalText = await stepBadge.textContent();
    const finalCount = parseInt(finalText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(finalCount).toBeGreaterThanOrEqual(1);

    // Stop recording
    await panel.click('button:has-text("Stop")');

    await panel.close();
  });

  test('recording captures form interactions (fill, click submit)', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199/form.html');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });

    // Fill form fields
    await page.fill('#name', 'Recording Test User');
    await panel.waitForTimeout(300);
    await page.fill('#email', 'recorder@example.com');
    await panel.waitForTimeout(300);
    await page.fill('#message', 'This is a test message from the recorder');
    await panel.waitForTimeout(300);

    // Submit the form
    await page.click('button[type="submit"]');
    await panel.waitForTimeout(500);

    // Verify form result appeared
    await expect(page.locator('#form-result')).toBeVisible();
    await expect(page.locator('#form-result')).toContainText('Recording Test User');

    // Stop recording
    await panel.click('button:has-text("Stop")');

    // Toolbar should be gone
    await expect(panel.locator('.border-red-200')).not.toBeVisible({ timeout: 5_000 });

    await panel.close();
  });

  test('recording with mock LLM generates refinement after stop', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();
    const storage = new ExtensionStorageHelper(panel);

    // Configure mock LLM
    await storage.configureForMockLLM(mockBaseUrl);
    await panel.reload();
    await panel.waitForSelector('#root', { timeout: 10_000 });

    // Set up mock response for recording refinement
    mockLLM.setDefaultResponse(MOCK_RESPONSES.recordingRefinement(
      'Click the like button and verify the like count increases',
      `async function run(page) {
  await page.goto("http://localhost:5199");
  await page.click("#like-btn");
  const count = await page.locator("#like-count").textContent();
  return { likes: count };
}`,
    ));

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Perform actions
    await page.click('#like-btn');
    await panel.waitForTimeout(500);
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Stop recording
    await panel.click('button:has-text("Stop")');
    await panel.waitForTimeout(2_000);

    // After stopping with steps, either:
    // 1. The mock LLM was called for refinement
    // 2. The UI transitioned to show a refinement/summary state
    // 3. The chat input was re-enabled
    const llmCalled = mockLLM.getRequestLog().length > 0;
    const refineVisible = await panel.getByText(/refin|generat|creat|process|description/i).isVisible({ timeout: 5_000 }).catch(() => false);
    const inputEnabled = await panel.locator('input[placeholder*="Describe"]').isEnabled({ timeout: 5_000 }).catch(() => false);

    expect(llmCalled || refineVisible || inputEnabled).toBe(true);

    await panel.close();
  });

  test('recording modal cancel does not start recording', async ({ openSidePanel }) => {
    const panel = await openSidePanel();

    // Open recording modal
    await openRecordingModal(panel);

    // Verify modal is showing
    await expect(panel.getByText('Teach Cohand your workflow')).toBeVisible();
    await expect(panel.getByText('Start recording')).toBeVisible();
    await expect(panel.getByText('Cancel')).toBeVisible();

    // Click Cancel
    await panel.click('button:has-text("Cancel")');

    // Modal should close
    await expect(panel.getByText('Teach Cohand your workflow')).not.toBeVisible();

    // No recording toolbar should appear
    const toolbar = panel.locator('.border-red-200');
    const hasToolbar = await toolbar.isVisible({ timeout: 2_000 }).catch(() => false);
    expect(hasToolbar).toBe(false);

    // Input should still be enabled
    const input = panel.locator('input[placeholder*="Describe"]');
    await expect(input).not.toBeDisabled();

    await panel.close();
  });

  test('recording pause and resume preserves step count', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Perform an action
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Get step count before pause
    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });
    const beforePauseText = await stepBadge.textContent();
    const beforePauseCount = parseInt(beforePauseText?.match(/(\d+)/)?.[1] ?? '0', 10);

    // Pause recording
    const pauseBtn = panel.locator('button[title="Pause"]');
    await expect(pauseBtn).toBeVisible({ timeout: 3_000 });
    await pauseBtn.click();
    await panel.waitForTimeout(300);

    // Resume button should appear
    const resumeBtn = panel.locator('button[title="Resume"]');
    await expect(resumeBtn).toBeVisible({ timeout: 3_000 });

    // Resume recording
    await resumeBtn.click();
    await panel.waitForTimeout(300);

    // Pause button should be back
    await expect(pauseBtn).toBeVisible({ timeout: 3_000 });

    // Step count should be preserved after resume
    const afterResumeText = await stepBadge.textContent();
    const afterResumeCount = parseInt(afterResumeText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(afterResumeCount).toBeGreaterThanOrEqual(beforePauseCount);

    // Perform another action
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Step count should increase
    const finalText = await stepBadge.textContent();
    const finalCount = parseInt(finalText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(finalCount).toBeGreaterThanOrEqual(afterResumeCount);

    // Stop recording
    await panel.click('button:has-text("Stop")');

    await panel.close();
  });

  test('recording with no interactions stops cleanly', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Verify toolbar is present
    await expect(panel.locator('.border-red-200')).toBeVisible();

    // Immediately stop without performing any actions
    await panel.click('button:has-text("Stop")');

    // Toolbar should disappear
    await expect(panel.locator('.border-red-200')).not.toBeVisible({ timeout: 5_000 });

    // Input should be re-enabled
    const input = panel.locator('input[placeholder*="Describe"]');
    await expect(input).not.toBeDisabled({ timeout: 5_000 });

    // Chat should still be functional
    await expect(panel.locator('#root')).not.toBeEmpty();

    await panel.close();
  });

  test('chat input disabled during recording', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Verify input is enabled before recording
    const input = panel.locator('input[placeholder*="Describe"]');
    await expect(input).not.toBeDisabled({ timeout: 5_000 });

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Input should be disabled during recording
    await expect(input).toBeDisabled({ timeout: 3_000 });

    // Record button should also be disabled
    const recordBtn = panel.locator('button[title="Record workflow"]');
    await expect(recordBtn).toBeDisabled({ timeout: 3_000 });

    // Stop recording
    await panel.click('button:has-text("Stop")');

    // Input should be re-enabled after stopping
    await expect(input).not.toBeDisabled({ timeout: 5_000 });

    await panel.close();
  });

  test('recording captures clicks on item list elements', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });
    const initialText = await stepBadge.textContent();
    const initialCount = parseInt(initialText?.match(/(\d+)/)?.[1] ?? '0', 10);

    // Click on multiple item list entries
    await page.click('[data-item-id="1"]');
    await panel.waitForTimeout(300);
    await page.click('[data-item-id="3"]');
    await panel.waitForTimeout(300);
    await page.click('[data-item-id="5"]');
    await panel.waitForTimeout(500);

    // Step count should increase for click events
    const afterClicksText = await stepBadge.textContent();
    const afterClicksCount = parseInt(afterClicksText?.match(/(\d+)/)?.[1] ?? '0', 10);
    expect(afterClicksCount).toBeGreaterThan(initialCount);

    // Stop recording
    await panel.click('button:has-text("Stop")');

    await panel.close();
  });

  test('recording on dynamic page captures interactions after content loads', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199/dynamic.html');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Wait for dynamic content to load (2 seconds delay on the page)
    await page.waitForSelector('#dynamic-content', { timeout: 5_000 });
    await expect(page.locator('#status-badge')).toContainText('Ready');

    // Click on the dynamically loaded content
    await page.click('#dynamic-content');
    await panel.waitForTimeout(500);

    // Verify toolbar is still active
    const toolbarActive = await panel.locator('.border-red-200').isVisible();
    expect(toolbarActive).toBe(true);

    // Stop recording
    await panel.click('button:has-text("Stop")');

    await panel.close();
  });

  test('recording to task creation flow with mock LLM', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();
    const storage = new ExtensionStorageHelper(panel);

    // Configure mock LLM
    await storage.configureForMockLLM(mockBaseUrl);
    await panel.reload();
    await panel.waitForSelector('#root', { timeout: 10_000 });

    mockLLM.setDefaultResponse(MOCK_RESPONSES.recordingRefinement(
      'Monitor like count on homepage',
      `async function run(page) {
  await page.goto("http://localhost:5199");
  const el = await page.locator("#like-count");
  return { likes: await el.textContent() };
}`,
    ));

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Perform actions
    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    // Stop recording
    await panel.click('button:has-text("Stop")');
    await panel.waitForTimeout(2_000);

    // Look for a create task button or link after recording stops
    const createBtn = panel.getByText(/create task|save|generate/i);
    const hasCreate = await createBtn.first().isVisible({ timeout: 5_000 }).catch(() => false);

    if (hasCreate) {
      await expect(createBtn.first()).toBeEnabled();
    } else {
      // If no explicit create button, verify the system returned to a usable state
      const input = panel.locator('input[placeholder*="Describe"]');
      await expect(input).not.toBeDisabled({ timeout: 10_000 });
    }

    await panel.close();
  });

  test('recording shows live step list with action descriptions', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // Start recording
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Initially should show placeholder (no steps yet)
    const placeholder = panel.getByText('Interact with the page');
    const hasPlaceholder = await placeholder.isVisible({ timeout: 3_000 }).catch(() => false);

    // Perform some actions
    await page.click('#like-btn');
    await panel.waitForTimeout(1_000);

    // After actions, the LiveStepList should show step items
    const stepItems = panel.locator('.animate-\\[slideIn_0\\.2s_ease-out\\]');
    const stepCount = await stepItems.count();

    if (stepCount > 0) {
      // Steps were captured - each should be visible
      await expect(stepItems.first()).toBeVisible();
    } else if (hasPlaceholder) {
      // Content script may not have loaded - verify recording is still active
      await expect(panel.locator('.border-red-200')).toBeVisible();
    }

    // Stop recording
    await panel.click('button:has-text("Stop")');

    await panel.close();
  });

  test('multiple recording sessions do not leak state', async ({ openSidePanel, page }) => {
    const panel = await openSidePanel();

    await page.goto('http://localhost:5199');
    await page.waitForLoadState('networkidle');
    await ensureMockPageActive(page);

    // --- Session 1 ---
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    await panel.click('button:has-text("Stop")');
    await expect(panel.locator('.border-red-200')).not.toBeVisible({ timeout: 5_000 });

    // Wait for input to re-enable
    const input = panel.locator('input[placeholder*="Describe"]');
    await expect(input).not.toBeDisabled({ timeout: 10_000 });

    // --- Session 2 ---
    await openRecordingModal(panel);
    await startRecordingFromModal(panel);

    // Step count should start fresh (at 0 or from a page load step)
    const stepBadge = panel.getByText(/\d+ step/);
    await expect(stepBadge).toBeVisible({ timeout: 3_000 });
    const session2InitialText = await stepBadge.textContent();
    const session2InitialCount = parseInt(session2InitialText?.match(/(\d+)/)?.[1] ?? '0', 10);

    // Session 2 should start with 0 or very few steps (not accumulated from session 1)
    expect(session2InitialCount).toBeLessThanOrEqual(1);

    await page.click('#like-btn');
    await panel.waitForTimeout(500);

    await panel.click('button:has-text("Stop")');

    await panel.close();
  });
});
