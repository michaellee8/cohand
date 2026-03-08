import { SandboxBridge } from '../../lib/sandbox-bridge';
import type { ExecuteScriptResult } from '../../lib/sandbox-bridge';

console.log('[Cohand] Offscreen document loaded');

const bridge = new SandboxBridge();
let bridgeReady = false;
let pendingResolvers: (() => void)[] = [];

function waitForBridge(): Promise<void> {
  if (bridgeReady) return Promise.resolve();
  return new Promise<void>((resolve) => {
    pendingResolvers.push(resolve);
  });
}

// Wait for iframe to load, then init bridge
const iframe = document.getElementById('sandbox-frame') as HTMLIFrameElement;
if (iframe) {
  iframe.onload = () => {
    bridge.init(iframe);
    bridgeReady = true;
    console.log('[Cohand] Sandbox bridge initialized');
    // Resolve any pending waiters
    for (const resolve of pendingResolvers) resolve();
    pendingResolvers = [];
  };
  // Set sandbox src
  iframe.src = chrome.runtime.getURL('sandbox.html');
}

// ---------------------------------------------------------------------------
// Listen for execution requests from the service worker
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type !== 'SANDBOX_EXECUTE') return false;

  const { taskId, source, state, tabId } = message;

  // Handle async
  (async () => {
    try {
      await waitForBridge();

      // Set up result listener before sending execution request
      const result = await new Promise<ExecuteScriptResult>((resolve) => {
        bridge.onExecutionResult((res) => {
          resolve(res);
        });

        bridge.executeScript({
          type: 'execute-script',
          taskId,
          source,
          state: state ?? {},
          tabId,
        });
      });

      sendResponse({
        ok: result.ok,
        result: result.result,
        state: result.state,
        error: result.error,
      });
    } catch (err: unknown) {
      sendResponse({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  })();

  return true; // Async response
});
