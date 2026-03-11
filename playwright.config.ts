import { defineConfig } from '@playwright/test';
import path from 'node:path';

const extensionPath = path.resolve(__dirname, '.output/chrome-mv3');

export default defineConfig({
  testDir: './e2e/playwright/tests',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  retries: 1, // Chrome extension SW startup can be flaky
  workers: 1, // Chrome extension tests must run serially
  reporter: [['list'], ['html', { open: 'never' }]],

  projects: [
    {
      name: 'core',
      testMatch: /smoke|task|wizard|chat|extension/,
    },
    {
      name: 'features',
      testMatch: /recording|schedule|settings|notifications|export-import|security/,
    },
    {
      name: 'live',
      testMatch: /codex.*live/,
    },
  ],

  webServer: {
    command: 'npx vite --port 5199 --strictPort',
    cwd: path.resolve(__dirname, 'e2e/mock-site'),
    port: 5199,
    reuseExistingServer: true,
    timeout: 15_000,
  },

  use: {
    headless: false, // extensions require headed mode
    viewport: { width: 1280, height: 720 },
    actionTimeout: 10_000,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
