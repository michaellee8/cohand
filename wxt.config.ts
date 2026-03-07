import { defineConfig } from 'wxt';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Cohand',
    description: 'Prompt once, automate forever.',
    minimum_chrome_version: '125',
    permissions: [
      'debugger', 'sidePanel', 'storage', 'activeTab', 'scripting',
      'tabs', 'tabGroups', 'alarms', 'notifications', 'offscreen',
      'unlimitedStorage',
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    sandbox: {
      pages: ['sandbox.html'],
    },
  },
});
