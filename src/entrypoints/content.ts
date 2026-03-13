import {
  generateAccessibilityTree,
  isTopFrame,
  sendSubtreeToParent,
  receiveFrameSubtree,
  mergeFrameSubtrees,
  type FrameSubtreeMessage,
} from '@/lib/a11y-tree';
import { activate, deactivate } from '@/lib/recording/element-selector';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    console.log('[Cohand] Content script loaded');

    const isTop = isTopFrame();

    // ---------------------------------------------------------------------------
    // Cross-frame a11y tree merging
    // ---------------------------------------------------------------------------

    if (isTop) {
      // Top-level: listen for subtrees from iframe content script instances
      window.addEventListener('message', (event) => {
        const data = event.data;
        if (
          data &&
          typeof data === 'object' &&
          data.type === 'COHAND_FRAME_SUBTREE' &&
          data.frameId &&
          data.subtree
        ) {
          receiveFrameSubtree(data.frameId, data.subtree);
        }
      });
    }

    // Make tree generator available via message
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (msg.type === 'GET_A11Y_TREE') {
        const localTree = generateAccessibilityTree();

        if (!isTop) {
          // Iframe: send subtree to parent frame and return local tree
          if (localTree) {
            sendSubtreeToParent(localTree);
          }
          sendResponse(localTree);
          return true;
        }

        // Top-level: merge iframe subtrees into the main tree
        if (localTree) {
          const merged = mergeFrameSubtrees(localTree);
          sendResponse(merged);
        } else {
          sendResponse(localTree);
        }
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
