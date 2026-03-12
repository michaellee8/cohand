import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  vite: () => ({
    plugins: [tailwindcss()],
  }),
  manifest: {
    name: 'Cohand',
    description: 'Prompt once, automate forever.',
    minimum_chrome_version: '125',
    permissions: [
      'debugger', 'sidePanel', 'storage', 'activeTab', 'scripting',
      'tabs', 'tabGroups', 'alarms', 'notifications', 'offscreen',
      'unlimitedStorage', 'declarativeNetRequest', 'webNavigation',
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    sandbox: {
      pages: ['sandbox.html'],
    },
    externally_connectable: {
      ids: [], // Populate with allowed extension IDs for remote mode
    },
    web_accessible_resources: [{
      resources: ['oauth-callback.html'],
      matches: ['http://localhost/*'],
    }],
  },
});
