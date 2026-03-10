import { generateAccessibilityTree } from '@/lib/a11y-tree';
import { activate, deactivate } from '@/lib/recording/element-selector';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    console.log('[Cohand] Content script loaded');

    // Make tree generator available via message
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'GET_A11Y_TREE') {
        const tree = generateAccessibilityTree();
        sendResponse(tree);
        return true; // async
      }

      if (msg.type === 'ACTIVATE_RECORDING') {
        activate();
        sendResponse({ ok: true });
        return true;
      }

      if (msg.type === 'DEACTIVATE_RECORDING') {
        deactivate();
        sendResponse({ ok: true });
        return true;
      }
    });
  },
});
