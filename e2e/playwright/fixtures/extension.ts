import { test as base, chromium, type BrowserContext, type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const EXTENSION_PATH = path.resolve(__dirname, '../../../.output/chrome-mv3');

export type ExtensionFixtures = {
  context: BrowserContext;
  extensionId: string;
  page: Page;
  openSidePanel: () => Promise<Page>;
};

export const test = base.extend<ExtensionFixtures>({
  // Override context to launch with extension loaded
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
        '--disable-gpu',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  // Discover extension ID from the service worker
  extensionId: async ({ context }, use) => {
    let sw = context.serviceWorkers()[0];
    if (!sw) {
      sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
    }
    const url = new URL(sw.url());
    const extensionId = url.hostname;
    await use(extensionId);
  },

  // Default page
  page: async ({ context }, use) => {
    const pages = context.pages();
    const page = pages[0] || await context.newPage();
    await use(page);
  },

  // Helper to open the side panel page directly
  openSidePanel: async ({ context, extensionId }, use) => {
    const openFn = async (): Promise<Page> => {
      const sidePanelUrl = `chrome-extension://${extensionId}/sidepanel.html`;
      const page = await context.newPage();
      await page.goto(sidePanelUrl);
      await page.waitForSelector('#root', { timeout: 10_000 });
      return page;
    };
    await use(openFn);
  },
});

export { expect } from '@playwright/test';
