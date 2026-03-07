// Sandbox-side: handles script execution requests and sends RPCs to parent
// NOTE: Uses `new Function` as a TEMPORARY placeholder.
// The real implementation (Task 6.2) will use QuickJS WASM.
console.log('[Cohand] Sandbox loaded');

// Pending RPC callbacks
const pendingRPCs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let rpcNextId = 1;

// Create a proxy object that scripts will use as `page`
function createPageProxy(taskId: string): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const methods = [
    'goto', 'click', 'fill', 'type', 'scroll',
    'waitForSelector', 'waitForLoadState',
    'url', 'title', 'getByRole', 'getByText', 'getByLabel', 'locator',
  ];

  const proxy: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods) {
    proxy[method] = (...args: unknown[]) => {
      return sendRPC(taskId, method, { args });
    };
  }
  return proxy;
}

function sendRPC(taskId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const id = rpcNextId++;
  return new Promise((resolve, reject) => {
    pendingRPCs.set(id, { resolve, reject });
    window.parent.postMessage({ id, type: 'rpc', method, args, taskId }, '*');
  });
}

// Listen for messages from parent (offscreen doc)
window.addEventListener('message', async (event) => {
  const data = event.data;

  if (data.type === 'rpc-result') {
    const pending = pendingRPCs.get(data.id);
    if (pending) {
      pendingRPCs.delete(data.id);
      if (data.ok) pending.resolve(data.value);
      else pending.reject(new Error(data.error?.message || 'RPC failed'));
    }
    return;
  }

  if (data.type === 'execute-script') {
    const { taskId, source, state } = data;
    const page = createPageProxy(taskId);
    const context = {
      state: { ...state },
      url: '', // filled by task
      notify: (message: string) => sendRPC(taskId, 'notify', { message }),
    };

    try {
      // Create and execute the script function
      const fn = new Function('page', 'context', `
        return (async () => {
          ${source}
          return typeof run === 'function' ? await run(page, context) : undefined;
        })();
      `);
      const result = await fn(page, context);
      window.parent.postMessage({
        type: 'execute-script-result',
        ok: true,
        result,
        state: context.state,
      }, '*');
    } catch (err: any) {
      window.parent.postMessage({
        type: 'execute-script-result',
        ok: false,
        error: err.message || String(err),
      }, '*');
    }
  }
});
