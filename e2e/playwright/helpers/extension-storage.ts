import type { Page } from '@playwright/test';

/**
 * Helpers for pre-configuring chrome.storage.local in E2E tests.
 * Must be called from an extension page (side panel, popup, etc.).
 */
export class ExtensionStorageHelper {
  constructor(private page: Page) {}

  /**
   * Configure the LLM provider settings.
   * Call this before interacting with LLM features to point at a mock server.
   */
  async setSettings(settings: {
    llmProvider: 'chatgpt-subscription' | 'openai' | 'anthropic' | 'gemini' | 'custom';
    llmModel?: string;
    llmBaseUrl?: string;
    yoloMode?: boolean;
    language?: string;
  }): Promise<void> {
    await this.page.evaluate(async (s) => {
      await chrome.storage.local.set({
        settings: {
          llmProvider: s.llmProvider,
          llmModel: s.llmModel ?? 'gpt-5.4',
          yoloMode: s.yoloMode ?? false,
          language: s.language ?? 'en',
          ...(s.llmBaseUrl ? { llmBaseUrl: s.llmBaseUrl } : {}),
        },
      });
    }, settings);
  }

  /**
   * Store a plaintext API key (unencrypted, for testing only).
   * For production the key would be encrypted, but in E2E tests
   * we skip encryption for simplicity.
   */
  async setApiKey(apiKey: string): Promise<void> {
    await this.page.evaluate(async (key) => {
      await chrome.storage.local.set({
        encryptedTokens: { apiKey: key },
      });
    }, apiKey);
  }

  /**
   * Store Codex OAuth tokens for chatgpt-subscription provider.
   * In E2E tests we store plaintext tokens and skip encryption.
   */
  async setCodexOAuthTokens(tokens: {
    accessToken: string;
    refreshToken: string;
    accountId: string;
    expiresInMs?: number;
  }): Promise<void> {
    await this.page.evaluate(async (t) => {
      await chrome.storage.local.set({
        codexOAuthTokens: {
          access: t.accessToken,
          refresh: t.refreshToken,
          expires: Date.now() + (t.expiresInMs ?? 3600000),
          accountId: t.accountId,
        },
      });
    }, tokens);
  }

  /**
   * Configure the extension to use a mock LLM server.
   * Sets up the custom provider pointing at the mock server URL.
   */
  async configureForMockLLM(mockServerUrl: string, model = 'gpt-5.4'): Promise<void> {
    await this.setSettings({
      llmProvider: 'custom',
      llmModel: model,
      llmBaseUrl: mockServerUrl + '/v1',
    });
    await this.setApiKey('mock-api-key-for-testing');
  }

  /**
   * Read current settings from storage.
   */
  async getSettings(): Promise<Record<string, unknown> | null> {
    return this.page.evaluate(async () => {
      const result = await chrome.storage.local.get('settings');
      return result.settings ?? null;
    });
  }

  /**
   * Clear all extension storage (useful for test isolation).
   */
  async clearAll(): Promise<void> {
    await this.page.evaluate(async () => {
      await chrome.storage.local.clear();
    });
  }

  /**
   * Add a domain permission.
   */
  async addDomainPermission(domain: string): Promise<void> {
    await this.page.evaluate(async (d) => {
      const result = await chrome.storage.local.get('domainPermissions');
      const perms = result.domainPermissions ?? [];
      perms.push({
        domain: d,
        grantedAt: new Date().toISOString(),
        grantedBy: 'e2e-test',
      });
      await chrome.storage.local.set({ domainPermissions: perms });
    }, domain);
  }
}
