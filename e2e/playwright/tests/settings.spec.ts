import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';

test.describe('Settings @features', () => {
  /** Open the side panel and navigate to the Settings page. */
  async function openSettings(openSidePanel: () => Promise<import('@playwright/test').Page>) {
    const page = await openSidePanel();
    // Click the Settings gear icon
    await page.locator('button[title="Settings"]').click();
    // Wait for settings page to render
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });
    return page;
  }

  test('settings page opens and shows back button', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Settings heading should be visible
    await expect(page.locator('h1').filter({ hasText: 'Settings' })).toBeVisible();

    // Back button (SVG arrow) should be present
    const backBtn = page.locator('button').first();
    await expect(backBtn).toBeVisible();

    // Click back to return to main view
    await backBtn.click();
    await page.waitForTimeout(300);

    // Should be back on the Chat tab (default)
    await expect(page.getByText('Chat').first()).toBeVisible();

    await page.close();
  });

  test('LLM provider dropdown works', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Find the LLM Provider dropdown
    const select = page.locator('select').first();
    await expect(select).toBeVisible();

    // Verify all provider options exist
    const options = await select.locator('option').allTextContents();
    expect(options).toContain('ChatGPT Subscription');
    expect(options).toContain('OpenAI API');
    expect(options).toContain('Anthropic Claude');
    expect(options).toContain('Google Gemini');
    expect(options).toContain('Custom (OpenAI-compatible)');

    // Default should be chatgpt-subscription
    const currentValue = await select.inputValue();
    expect(currentValue).toBe('chatgpt-subscription');

    // Change to OpenAI
    await select.selectOption('openai');
    expect(await select.inputValue()).toBe('openai');

    // After selecting openai, API key section should appear
    await expect(page.getByText('API Key')).toBeVisible({ timeout: 3_000 });

    // Change to anthropic
    await select.selectOption('anthropic');
    expect(await select.inputValue()).toBe('anthropic');

    // Change to custom — Base URL field should appear
    await select.selectOption('custom');
    expect(await select.inputValue()).toBe('custom');
    await expect(page.getByText('Base URL')).toBeVisible({ timeout: 3_000 });

    await page.close();
  });

  test('API key input saves and shows confirmation', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Switch to OpenAI provider to get API key input
    const select = page.locator('select').first();
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    // API Key section should be visible
    await expect(page.getByText('API Key')).toBeVisible();

    // Find the password input for API key
    const apiKeyInput = page.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();

    // Save button should be disabled when input is empty
    const saveBtn = page.locator('button').filter({ hasText: 'Save' });
    await expect(saveBtn).toBeDisabled();

    // Type a key
    await apiKeyInput.fill('sk-test-key-1234567890');

    // Save button should now be enabled
    await expect(saveBtn).not.toBeDisabled();

    // Click Save
    await saveBtn.click();
    await page.waitForTimeout(500);

    // After saving, should show "Key configured" confirmation
    await expect(page.getByText('Key configured')).toBeVisible({ timeout: 5_000 });

    // Remove button should be available
    await expect(page.getByText('Remove')).toBeVisible();

    // Click Remove to clear the key
    await page.getByText('Remove').click();
    await page.waitForTimeout(500);

    // Password input should reappear
    await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 3_000 });

    await page.close();
  });

  test('codex auth import shows UI elements when ChatGPT provider selected', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Default provider is chatgpt-subscription
    // ChatGPT Account section should be visible
    await expect(page.getByText('ChatGPT Account')).toBeVisible({ timeout: 5_000 });

    // Login with ChatGPT button should be present
    await expect(page.getByText('Login with ChatGPT')).toBeVisible();

    // Import from ~/.codex/auth.json button should be present
    await expect(page.getByText('Import from ~/.codex/auth.json')).toBeVisible();

    // Paste JSON manually link should be present
    await expect(page.getByText('Paste JSON manually')).toBeVisible();

    await page.close();
  });

  test('codex auth paste JSON flow works', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Click "Paste JSON manually"
    await page.getByText('Paste JSON manually').click();

    // Textarea should appear
    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 3_000 });

    // Import button should be disabled when textarea is empty
    const importBtn = page.getByRole('button', { name: 'Import', exact: true });
    await expect(importBtn).toBeDisabled();

    // Paste valid auth JSON
    const validAuthJson = JSON.stringify({
      tokens: {
        access_token: 'test-access-token-abc123',
        refresh_token: 'test-refresh-token-def456',
        account_id: 'test-account-789',
      },
    });
    await textarea.fill(validAuthJson);

    // Import button should now be enabled
    await expect(importBtn).not.toBeDisabled();

    // Click Import
    await importBtn.click();
    await page.waitForTimeout(1000);

    // Should show "Connected" status
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('test-account-789')).toBeVisible();

    // Logout button should be visible
    await expect(page.getByText('Logout')).toBeVisible();

    // Click Logout
    await page.getByText('Logout').click();
    await page.waitForTimeout(500);

    // Should return to not-connected state
    await expect(page.getByText('Login with ChatGPT')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('codex auth paste JSON rejects invalid JSON', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Click "Paste JSON manually"
    await page.getByText('Paste JSON manually').click();

    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // Paste invalid JSON (missing required fields)
    await textarea.fill(JSON.stringify({ tokens: { access_token: 'abc' } }));

    const importBtn = page.getByRole('button', { name: 'Import', exact: true });
    await importBtn.click();
    await page.waitForTimeout(500);

    // Should NOT show connected since the JSON is invalid (missing refresh_token and account_id)
    const connected = await page.getByText('Connected').isVisible({ timeout: 2_000 }).catch(() => false);
    expect(connected).toBe(false);

    // The paste area auto-closes after import attempt.
    // Login button should still be visible (not connected state).
    await expect(page.getByText('Login with ChatGPT')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('domain permissions CRUD', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Domain Permissions section should be visible
    await expect(page.getByText('Domain Permissions')).toBeVisible();

    // Initially should show "No domains configured"
    await expect(page.getByText('No domains configured')).toBeVisible();

    // Find the domain input
    const domainInput = page.locator('input[placeholder="example.com"]');
    await expect(domainInput).toBeVisible();

    // Add button should be disabled when input is empty
    const addBtn = page.locator('section').filter({ hasText: 'Domain Permissions' }).locator('button').filter({ hasText: 'Add' });
    await expect(addBtn).toBeDisabled();

    // Add first domain
    await domainInput.fill('example.com');
    await expect(addBtn).not.toBeDisabled();
    await addBtn.click();
    await page.waitForTimeout(300);

    // Domain should appear in the list
    await expect(page.getByText('example.com').first()).toBeVisible();
    // "No domains configured" should be gone
    await expect(page.getByText('No domains configured')).not.toBeVisible();

    // Add second domain via Enter key
    await domainInput.fill('test.org');
    await domainInput.press('Enter');
    await page.waitForTimeout(300);

    // Both domains should be visible
    await expect(page.getByText('example.com').first()).toBeVisible();
    await expect(page.getByText('test.org').first()).toBeVisible();

    // Remove first domain — each domain row is a div with the domain text and a Remove button
    // Use the specific bg-gray-50 row that contains the domain text
    const domainRows = page.locator('.bg-gray-50');
    const exampleRow = domainRows.filter({ hasText: 'example.com' });
    await exampleRow.locator('button', { hasText: 'Remove' }).click();
    await page.waitForTimeout(300);

    // example.com should be gone, test.org should remain
    const exampleVisible = await domainRows.filter({ hasText: 'example.com' }).isVisible({ timeout: 1_000 }).catch(() => false);
    expect(exampleVisible).toBe(false);
    await expect(domainRows.filter({ hasText: 'test.org' })).toBeVisible();

    // Remove remaining domain
    const testRow = domainRows.filter({ hasText: 'test.org' });
    await testRow.locator('button', { hasText: 'Remove' }).click();
    await page.waitForTimeout(300);

    // Should show empty state again
    await expect(page.getByText('No domains configured')).toBeVisible();

    await page.close();
  });

  test('YOLO mode toggle with warning', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Scroll down to Advanced section
    await page.getByText('Advanced').scrollIntoViewIfNeeded();

    // Find the YOLO mode checkbox
    const yoloCheckbox = page.locator('input[type="checkbox"]');
    await expect(yoloCheckbox).toBeVisible();

    // Should be unchecked by default
    await expect(yoloCheckbox).not.toBeChecked();

    // Click the checkbox — the component intercepts this and shows a warning
    // instead of directly toggling the state, so we use click() not check()
    await yoloCheckbox.click();
    await page.waitForTimeout(300);

    // Warning dialog should appear
    await expect(page.getByText('YOLO mode will automatically approve')).toBeVisible();
    await expect(page.getByText('Enable')).toBeVisible();

    // Click Cancel — checkbox should remain unchecked
    // Use the Cancel button inside the yellow warning box
    const warningBox = page.locator('.bg-yellow-50');
    await warningBox.locator('button').filter({ hasText: 'Cancel' }).click();
    await page.waitForTimeout(300);
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    // Click again and this time click Enable
    await yoloCheckbox.click();
    await page.waitForTimeout(300);
    await warningBox.getByText('Enable').click();
    await page.waitForTimeout(300);

    // Warning should dismiss and YOLO should be enabled
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    // Now uncheck YOLO mode — direct click should work (no warning when disabling)
    await yoloCheckbox.click();
    await page.waitForTimeout(300);
    // No warning should appear when disabling
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    await page.close();
  });

  test('language setting can be changed', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Scroll to Language section
    await page.getByText('Language').last().scrollIntoViewIfNeeded();

    // Find the language input
    const langInput = page.locator('input[placeholder="en"]');
    await expect(langInput).toBeVisible();

    // Default should be "en"
    expect(await langInput.inputValue()).toBe('en');

    // Change to Spanish
    await langInput.fill('es');
    await page.waitForTimeout(500);

    // Verify the value changed
    expect(await langInput.inputValue()).toBe('es');

    // Change back to English
    await langInput.fill('en');
    await page.waitForTimeout(500);
    expect(await langInput.inputValue()).toBe('en');

    await page.close();
  });

  test('model input can be changed', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Model section should be visible
    await expect(page.getByText('Model')).toBeVisible();

    // Find the model input
    const modelInput = page.locator('input[placeholder="e.g., gpt-5.4"]');
    await expect(modelInput).toBeVisible();

    // Change model
    await modelInput.fill('claude-opus-4');
    await page.waitForTimeout(300);
    expect(await modelInput.inputValue()).toBe('claude-opus-4');

    await page.close();
  });

  test('custom provider shows Base URL field', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('custom');
    await page.waitForTimeout(300);

    // Base URL section should appear
    await expect(page.getByText('Base URL')).toBeVisible();

    const baseUrlInput = page.locator('input[placeholder="https://api.example.com/v1"]');
    await expect(baseUrlInput).toBeVisible();

    // Fill in a custom URL
    await baseUrlInput.fill('http://127.0.0.1:8080/v1');
    await page.waitForTimeout(300);
    expect(await baseUrlInput.inputValue()).toBe('http://127.0.0.1:8080/v1');

    await page.close();
  });

  test('switching provider hides irrelevant sections', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();

    // Start with chatgpt-subscription (default)
    // ChatGPT Account section should be visible, API Key should NOT
    await expect(page.getByText('ChatGPT Account')).toBeVisible();
    const apiKeyVisible = await page.getByText('API Key').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(apiKeyVisible).toBe(false);

    // Switch to openai
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    // API Key should appear, ChatGPT Account should disappear
    await expect(page.getByText('API Key')).toBeVisible();
    const chatgptVisible = await page.getByText('ChatGPT Account').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(chatgptVisible).toBe(false);

    // Switch to gemini — should also show API Key but not Base URL
    await select.selectOption('gemini');
    await page.waitForTimeout(300);
    await expect(page.getByText('API Key')).toBeVisible();
    const baseUrlVisible = await page.getByText('Base URL').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(baseUrlVisible).toBe(false);

    // Switch to custom — should show both API Key and Base URL
    await select.selectOption('custom');
    await page.waitForTimeout(300);
    await expect(page.getByText('API Key')).toBeVisible();
    await expect(page.getByText('Base URL')).toBeVisible();

    await page.close();
  });
});
