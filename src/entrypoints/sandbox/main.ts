console.log('[Cohand] Sandbox loaded');

// QuickJS WASM runtime will be initialized here
window.addEventListener('message', (event) => {
  // Will handle script execution requests from offscreen document
  console.log('[Cohand Sandbox] Message received:', event.data);
});
