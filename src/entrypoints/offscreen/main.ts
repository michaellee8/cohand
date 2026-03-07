import { SandboxBridge } from '../../lib/sandbox-bridge';

console.log('[Cohand] Offscreen document loaded');

const bridge = new SandboxBridge();

// Wait for iframe to load, then init bridge
const iframe = document.getElementById('sandbox-frame') as HTMLIFrameElement;
if (iframe) {
  iframe.onload = () => {
    bridge.init(iframe);
    console.log('[Cohand] Sandbox bridge initialized');
  };
  // Set sandbox src
  iframe.src = chrome.runtime.getURL('sandbox.html');
}
