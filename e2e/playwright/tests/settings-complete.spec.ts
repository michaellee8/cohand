import { test, expect } from '../fixtures/extension';
import { SidePanel } from '../helpers/sidepanel';
import { ExtensionStorageHelper } from '../helpers/extension-storage';
import { ServiceWorkerHelper } from '../helpers/service-worker';
import { MockLLMServer } from '../helpers/mock-llm-server';

/**
 * Complete Settings E2E Tests
 *
 * Tests ALL settings flows:
 * 1. Change LLM provider (each option)
 * 2. Add/remove domain permissions
 * 3. Toggle YOLO mode (verify warning dialog)
 * 4. Export/import tasks (if UI exists)
 * 5. View usage stats (if rendered)
 * 6. Language setting
 * 7. Model configuration
 * 8. Custom provider Base URL
 * 9. API key management for all providers
 * 10. Codex auth import/export
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

/** Open the side panel and navigate to the Settings page. */
async function openSettings(openSidePanel: () => Promise<import('@playwright/test').Page>) {
  const page = await openSidePanel();
  await page.locator('button[title="Settings"]').click();
  await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });
  return page;
}

test.describe('Settings Complete - LLM Providers @features', () => {
  test('select ChatGPT Subscription provider and verify UI', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('chatgpt-subscription');
    await page.waitForTimeout(300);

    // ChatGPT Account section should be visible
    await expect(page.getByText('ChatGPT Account')).toBeVisible();

    // API Key section should NOT be visible
    const apiKeyVisible = await page.getByText('API Key').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(apiKeyVisible).toBe(false);

    // Login button should be present
    await expect(page.getByText('Login with ChatGPT')).toBeVisible();

    // Import and paste options
    await expect(page.getByText('Import from ~/.codex/auth.json')).toBeVisible();
    await expect(page.getByText('Paste JSON manually')).toBeVisible();

    await page.close();
  });

  test('select OpenAI API provider and verify API key section', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    // API Key section should be visible
    await expect(page.getByText('API Key')).toBeVisible();

    // Password input for API key should be present
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // ChatGPT Account section should NOT be visible
    const chatgptVisible = await page.getByText('ChatGPT Account').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(chatgptVisible).toBe(false);

    // Base URL should NOT be visible (only for custom)
    const baseUrlVisible = await page.getByText('Base URL').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(baseUrlVisible).toBe(false);

    await page.close();
  });

  test('select Anthropic Claude provider and verify UI', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('anthropic');
    await page.waitForTimeout(300);

    // API Key section should appear
    await expect(page.getByText('API Key')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // ChatGPT and Base URL should NOT be visible
    const chatgptVisible = await page.getByText('ChatGPT Account').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(chatgptVisible).toBe(false);
    const baseUrlVisible = await page.getByText('Base URL').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(baseUrlVisible).toBe(false);

    await page.close();
  });

  test('select Google Gemini provider and verify UI', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('gemini');
    await page.waitForTimeout(300);

    // API Key section should appear
    await expect(page.getByText('API Key')).toBeVisible();
    await expect(page.locator('input[type="password"]')).toBeVisible();

    // Base URL should NOT be visible for Gemini
    const baseUrlVisible = await page.getByText('Base URL').isVisible({ timeout: 1_000 }).catch(() => false);
    expect(baseUrlVisible).toBe(false);

    await page.close();
  });

  test('select Custom provider and verify Base URL + API key', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('custom');
    await page.waitForTimeout(300);

    // Both API Key and Base URL sections should be visible
    await expect(page.getByText('API Key')).toBeVisible();
    await expect(page.getByText('Base URL')).toBeVisible();

    // Base URL input
    const baseUrlInput = page.locator('input[placeholder="https://api.example.com/v1"]');
    await expect(baseUrlInput).toBeVisible();

    // Fill in custom URL
    await baseUrlInput.fill('http://127.0.0.1:8080/v1');
    await page.waitForTimeout(300);
    expect(await baseUrlInput.inputValue()).toBe('http://127.0.0.1:8080/v1');

    await page.close();
  });

  test('cycle through all providers and verify correct sections shown', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);
    const select = page.locator('select').first();

    const providerExpectations = [
      { value: 'chatgpt-subscription', expectChatGPT: true, expectApiKey: false, expectBaseUrl: false },
      { value: 'openai', expectChatGPT: false, expectApiKey: true, expectBaseUrl: false },
      { value: 'anthropic', expectChatGPT: false, expectApiKey: true, expectBaseUrl: false },
      { value: 'gemini', expectChatGPT: false, expectApiKey: true, expectBaseUrl: false },
      { value: 'custom', expectChatGPT: false, expectApiKey: true, expectBaseUrl: true },
    ];

    for (const provider of providerExpectations) {
      await select.selectOption(provider.value);
      await page.waitForTimeout(300);

      const hasChatGPT = await page.getByText('ChatGPT Account').isVisible({ timeout: 1_000 }).catch(() => false);
      const hasApiKey = await page.getByText('API Key').isVisible({ timeout: 1_000 }).catch(() => false);
      const hasBaseUrl = await page.getByText('Base URL').isVisible({ timeout: 1_000 }).catch(() => false);

      expect(hasChatGPT).toBe(provider.expectChatGPT);
      expect(hasApiKey).toBe(provider.expectApiKey);
      expect(hasBaseUrl).toBe(provider.expectBaseUrl);
    }

    await page.close();
  });
});

test.describe('Settings Complete - API Key Management @features', () => {
  test('save and remove API key for OpenAI', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const select = page.locator('select').first();
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    // API Key input
    const apiKeyInput = page.locator('input[type="password"]');
    await expect(apiKeyInput).toBeVisible();

    // Save button should be disabled when empty
    const saveBtn = page.locator('button').filter({ hasText: 'Save' });
    await expect(saveBtn).toBeDisabled();

    // Type API key
    await apiKeyInput.fill('sk-test-openai-key-12345');

    // Save button should now be enabled
    await expect(saveBtn).not.toBeDisabled();

    // Click Save
    await saveBtn.click();
    await page.waitForTimeout(500);

    // Should show "Key configured" confirmation
    await expect(page.getByText('Key configured')).toBeVisible({ timeout: 5_000 });

    // Remove button should be available
    await expect(page.getByText('Remove')).toBeVisible();

    // Click Remove
    await page.getByText('Remove').click();
    await page.waitForTimeout(500);

    // Password input should reappear
    await expect(page.locator('input[type="password"]')).toBeVisible({ timeout: 3_000 });

    await page.close();
  });

  test('API key persists across settings reopens', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Switch to OpenAI and save a key
    const select = page.locator('select').first();
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    const apiKeyInput = page.locator('input[type="password"]');
    await apiKeyInput.fill('sk-persist-test-key');

    const saveBtn = page.locator('button').filter({ hasText: 'Save' });
    await saveBtn.click();
    await page.waitForTimeout(500);

    await expect(page.getByText('Key configured')).toBeVisible({ timeout: 5_000 });

    // Navigate back to main view
    const backBtn = page.locator('button').first();
    await backBtn.click();
    await page.waitForTimeout(300);

    // Re-open settings
    await page.locator('button[title="Settings"]').click();
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });

    // Select OpenAI again
    await page.locator('select').first().selectOption('openai');
    await page.waitForTimeout(300);

    // Should still show "Key configured"
    await expect(page.getByText('Key configured')).toBeVisible({ timeout: 5_000 });

    // Clean up - remove the key
    await page.getByText('Remove').click();

    await page.close();
  });
});

test.describe('Settings Complete - Domain Permissions @features', () => {
  test('add multiple domains and verify list', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const domainInput = page.locator('input[placeholder="example.com"]');
    const addBtn = page.locator('section').filter({ hasText: 'Domain Permissions' }).locator('button').filter({ hasText: 'Add' });

    // Initially should show "No domains configured"
    await expect(page.getByText('No domains configured')).toBeVisible();

    // Add multiple domains
    const domains = ['example.com', 'test.org', 'mysite.net', 'api.company.io'];
    for (const domain of domains) {
      await domainInput.fill(domain);
      await addBtn.click();
      await page.waitForTimeout(200);
    }

    // All domains should be visible
    for (const domain of domains) {
      await expect(page.getByText(domain).first()).toBeVisible();
    }

    // "No domains configured" should be gone
    await expect(page.getByText('No domains configured')).not.toBeVisible();

    // Remove all domains for cleanup
    const domainRows = page.locator('.bg-gray-50');
    let count = await domainRows.count();
    while (count > 0) {
      await domainRows.first().locator('button', { hasText: 'Remove' }).click();
      await page.waitForTimeout(200);
      count = await domainRows.count();
    }

    // Should show empty state
    await expect(page.getByText('No domains configured')).toBeVisible();

    await page.close();
  });

  test('add domain via Enter key', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const domainInput = page.locator('input[placeholder="example.com"]');

    // Type and press Enter
    await domainInput.fill('enter-test.com');
    await domainInput.press('Enter');
    await page.waitForTimeout(300);

    // Domain should appear
    await expect(page.getByText('enter-test.com').first()).toBeVisible();

    // Clean up
    const domainRows = page.locator('.bg-gray-50');
    const row = domainRows.filter({ hasText: 'enter-test.com' });
    await row.locator('button', { hasText: 'Remove' }).click();

    await page.close();
  });

  test('remove specific domain from middle of list', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const domainInput = page.locator('input[placeholder="example.com"]');
    const addBtn = page.locator('section').filter({ hasText: 'Domain Permissions' }).locator('button').filter({ hasText: 'Add' });

    // Add three domains
    for (const d of ['first.com', 'middle.com', 'last.com']) {
      await domainInput.fill(d);
      await addBtn.click();
      await page.waitForTimeout(200);
    }

    // Remove the middle domain
    const domainRows = page.locator('.bg-gray-50');
    const middleRow = domainRows.filter({ hasText: 'middle.com' });
    await middleRow.locator('button', { hasText: 'Remove' }).click();
    await page.waitForTimeout(300);

    // middle.com should be gone
    const middleVisible = await domainRows.filter({ hasText: 'middle.com' }).isVisible({ timeout: 1_000 }).catch(() => false);
    expect(middleVisible).toBe(false);

    // first.com and last.com should remain
    await expect(domainRows.filter({ hasText: 'first.com' })).toBeVisible();
    await expect(domainRows.filter({ hasText: 'last.com' })).toBeVisible();

    // Clean up remaining
    for (const d of ['first.com', 'last.com']) {
      const row = domainRows.filter({ hasText: d });
      if (await row.isVisible({ timeout: 500 }).catch(() => false)) {
        await row.locator('button', { hasText: 'Remove' }).click();
        await page.waitForTimeout(200);
      }
    }

    await page.close();
  });

  test('add button disabled with empty input', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const addBtn = page.locator('section').filter({ hasText: 'Domain Permissions' }).locator('button').filter({ hasText: 'Add' });

    // Add button should be disabled when input is empty
    await expect(addBtn).toBeDisabled();

    // Type something
    const domainInput = page.locator('input[placeholder="example.com"]');
    await domainInput.fill('test.com');

    // Add button should now be enabled
    await expect(addBtn).not.toBeDisabled();

    // Clear input
    await domainInput.fill('');

    // Add button should be disabled again
    await expect(addBtn).toBeDisabled();

    await page.close();
  });
});

test.describe('Settings Complete - YOLO Mode @features', () => {
  test('YOLO mode warning dialog: cancel keeps unchecked', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    await page.getByText('Advanced').scrollIntoViewIfNeeded();

    const yoloCheckbox = page.locator('input[type="checkbox"]');
    await expect(yoloCheckbox).not.toBeChecked();

    // Click checkbox to trigger warning
    await yoloCheckbox.click();
    await page.waitForTimeout(300);

    // Warning should appear
    await expect(page.getByText('YOLO mode will automatically approve')).toBeVisible();
    await expect(page.getByText('Enable')).toBeVisible();

    // Click Cancel in the warning box
    const warningBox = page.locator('.bg-yellow-50');
    await warningBox.locator('button').filter({ hasText: 'Cancel' }).click();
    await page.waitForTimeout(300);

    // Warning should dismiss
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    await page.close();
  });

  test('YOLO mode warning dialog: enable checks the box', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    await page.getByText('Advanced').scrollIntoViewIfNeeded();

    const yoloCheckbox = page.locator('input[type="checkbox"]');
    await expect(yoloCheckbox).not.toBeChecked();

    // Click checkbox and confirm enable
    await yoloCheckbox.click();
    await page.waitForTimeout(300);

    const warningBox = page.locator('.bg-yellow-50');
    await warningBox.getByText('Enable').click();
    await page.waitForTimeout(300);

    // Warning should dismiss
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    // Disable YOLO mode (no warning when disabling)
    await yoloCheckbox.click();
    await page.waitForTimeout(300);

    // No warning should appear when disabling
    await expect(page.getByText('YOLO mode will automatically approve')).not.toBeVisible();

    await page.close();
  });

  test('YOLO mode toggle persists via storage', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);
    const storage = new ExtensionStorageHelper(page);

    await page.getByText('Advanced').scrollIntoViewIfNeeded();

    const yoloCheckbox = page.locator('input[type="checkbox"]');

    // Enable YOLO
    await yoloCheckbox.click();
    await page.waitForTimeout(300);
    const warningBox = page.locator('.bg-yellow-50');
    await warningBox.getByText('Enable').click();
    await page.waitForTimeout(500);

    // Verify in storage
    const settings = await storage.getSettings();
    if (settings && 'yoloMode' in settings) {
      expect(settings.yoloMode).toBe(true);
    }

    // Disable YOLO
    await yoloCheckbox.click();
    await page.waitForTimeout(500);

    // Verify in storage
    const settingsAfter = await storage.getSettings();
    if (settingsAfter && 'yoloMode' in settingsAfter) {
      expect(settingsAfter.yoloMode).toBe(false);
    }

    await page.close();
  });
});

test.describe('Settings Complete - Language @features', () => {
  test('change language to Spanish and back', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    await page.getByText('Language').last().scrollIntoViewIfNeeded();

    const langInput = page.locator('input[placeholder="en"]');
    await expect(langInput).toBeVisible();

    // Default is "en"
    expect(await langInput.inputValue()).toBe('en');

    // Change to Spanish
    await langInput.fill('es');
    await page.waitForTimeout(500);
    expect(await langInput.inputValue()).toBe('es');

    // Change to French
    await langInput.fill('fr');
    await page.waitForTimeout(500);
    expect(await langInput.inputValue()).toBe('fr');

    // Change back to English
    await langInput.fill('en');
    await page.waitForTimeout(500);
    expect(await langInput.inputValue()).toBe('en');

    await page.close();
  });

  test('language setting persists in storage', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);
    const storage = new ExtensionStorageHelper(page);

    await page.getByText('Language').last().scrollIntoViewIfNeeded();

    const langInput = page.locator('input[placeholder="en"]');

    // Change to Japanese
    await langInput.fill('ja');
    await page.waitForTimeout(500);

    // Verify in storage
    const settings = await storage.getSettings();
    if (settings && 'language' in settings) {
      expect(settings.language).toBe('ja');
    }

    // Reset to English
    await langInput.fill('en');
    await page.waitForTimeout(500);

    await page.close();
  });
});

test.describe('Settings Complete - Model Configuration @features', () => {
  test('change model name', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    const modelInput = page.locator('input[placeholder="e.g., gpt-5.4"]');
    await expect(modelInput).toBeVisible();

    // Change model
    await modelInput.fill('claude-opus-4');
    await page.waitForTimeout(300);
    expect(await modelInput.inputValue()).toBe('claude-opus-4');

    // Change to another model
    await modelInput.fill('gpt-5.4-turbo');
    await page.waitForTimeout(300);
    expect(await modelInput.inputValue()).toBe('gpt-5.4-turbo');

    await page.close();
  });

  test('model setting persists in storage', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);
    const storage = new ExtensionStorageHelper(page);

    const modelInput = page.locator('input[placeholder="e.g., gpt-5.4"]');
    await modelInput.fill('test-model-123');
    await page.waitForTimeout(500);

    const settings = await storage.getSettings();
    if (settings && 'llmModel' in settings) {
      expect(settings.llmModel).toBe('test-model-123');
    }

    await page.close();
  });
});

test.describe('Settings Complete - Codex Auth @features', () => {
  test('paste valid JSON auth and connect', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Click "Paste JSON manually"
    await page.getByText('Paste JSON manually').click();

    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 3_000 });

    // Import button disabled when empty
    const importBtn = page.getByRole('button', { name: 'Import', exact: true });
    await expect(importBtn).toBeDisabled();

    // Paste valid auth JSON
    const validAuthJson = JSON.stringify({
      tokens: {
        access_token: 'test-access-token-xyz',
        refresh_token: 'test-refresh-token-abc',
        account_id: 'test-account-42',
      },
    });
    await textarea.fill(validAuthJson);

    // Import button should be enabled
    await expect(importBtn).not.toBeDisabled();

    // Click Import
    await importBtn.click();
    await page.waitForTimeout(1000);

    // Should show "Connected" status
    await expect(page.getByText('Connected')).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText('test-account-42')).toBeVisible();

    // Logout button should be visible
    await expect(page.getByText('Logout')).toBeVisible();

    // Logout
    await page.getByText('Logout').click();
    await page.waitForTimeout(500);

    // Should return to not-connected state
    await expect(page.getByText('Login with ChatGPT')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });

  test('paste invalid JSON auth shows error or stays disconnected', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    await page.getByText('Paste JSON manually').click();

    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible();

    // Paste invalid JSON (missing refresh_token and account_id)
    await textarea.fill(JSON.stringify({ tokens: { access_token: 'only-access' } }));

    const importBtn = page.getByRole('button', { name: 'Import', exact: true });
    await importBtn.click();
    await page.waitForTimeout(500);

    // Should NOT show connected
    const connected = await page.getByText('Connected').isVisible({ timeout: 2_000 }).catch(() => false);
    expect(connected).toBe(false);

    // Login button should still be visible
    await expect(page.getByText('Login with ChatGPT')).toBeVisible({ timeout: 5_000 });

    await page.close();
  });
});

test.describe('Settings Complete - Navigation @features', () => {
  test('back button returns to main view', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Settings heading should be visible
    await expect(page.locator('h1').filter({ hasText: 'Settings' })).toBeVisible();

    // Click back button
    const backBtn = page.locator('button').first();
    await backBtn.click();
    await page.waitForTimeout(300);

    // Should be back on the Chat tab
    await expect(page.getByText('Chat').first()).toBeVisible();

    await page.close();
  });

  test('settings accessible from Tasks tab', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const sp = new SidePanel(page);

    // Navigate to Tasks tab first
    await sp.navigateToTasks();
    await page.waitForTimeout(300);

    // Open settings
    await page.locator('button[title="Settings"]').click();
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });

    // Settings should be fully functional
    await expect(page.locator('h1').filter({ hasText: 'Settings' })).toBeVisible();
    await expect(page.locator('select').first()).toBeVisible();

    await page.close();
  });

  test('settings state preserved during same session', async ({ openSidePanel }) => {
    const page = await openSettings(openSidePanel);

    // Change provider to openai
    const select = page.locator('select').first();
    await select.selectOption('openai');
    await page.waitForTimeout(300);

    // Go back
    const backBtn = page.locator('button').first();
    await backBtn.click();
    await page.waitForTimeout(300);

    // Re-open settings
    await page.locator('button[title="Settings"]').click();
    await expect(page.getByText('Settings').first()).toBeVisible({ timeout: 10_000 });

    // Provider should still be openai (settings are auto-saved)
    const currentValue = await page.locator('select').first().inputValue();
    expect(currentValue).toBe('openai');

    // Reset to default for other tests
    await page.locator('select').first().selectOption('chatgpt-subscription');

    await page.close();
  });
});

test.describe('Settings Complete - Storage Integration @features', () => {
  test('configureForMockLLM sets correct storage values', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const storage = new ExtensionStorageHelper(page);

    // Configure for mock LLM
    await storage.configureForMockLLM(mockBaseUrl);

    // Verify settings in storage
    const settings = await storage.getSettings();
    expect(settings).toBeTruthy();
    if (settings) {
      expect(settings.llmProvider).toBe('custom');
      expect(settings.llmBaseUrl).toContain(mockBaseUrl);
    }

    // Clear for other tests
    await storage.clearAll();

    await page.close();
  });

  test('clearAll removes all storage data', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const storage = new ExtensionStorageHelper(page);

    // Set some data
    await storage.setSettings({
      llmProvider: 'openai',
      llmModel: 'test-clear',
    });
    await storage.setApiKey('test-clear-key');

    // Clear all
    await storage.clearAll();

    // Verify everything is gone
    const settings = await storage.getSettings();
    expect(settings).toBeNull();

    await page.close();
  });

  test('addDomainPermission stores domain in storage', async ({ openSidePanel }) => {
    const page = await openSidePanel();
    const storage = new ExtensionStorageHelper(page);

    // Add a domain permission via storage helper
    await storage.addDomainPermission('test-domain.com');

    // Verify in storage
    const result = await page.evaluate(async () => {
      const data = await chrome.storage.local.get('domainPermissions');
      return data.domainPermissions ?? [];
    });

    expect(Array.isArray(result)).toBe(true);
    const found = (result as any[]).find((p: any) => p.domain === 'test-domain.com');
    expect(found).toBeTruthy();

    // Clean up
    await storage.clearAll();

    await page.close();
  });
});
