// Bridge between sandboxed iframe and service worker
console.log('[Cohand] Offscreen document loaded');

const sandboxFrame = document.getElementById(
  'sandbox-frame',
) as HTMLIFrameElement;
sandboxFrame.src = chrome.runtime.getURL('/sandbox.html');
