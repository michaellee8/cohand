// Sandbox-side: executes scripts in QuickJS WASM isolation.
// Scripts have NO access to browser globals — only the page proxy and context.
import { createQuickJSExecutor } from '../../lib/quickjs-runner';

console.log('[Cohand] Sandbox loaded (QuickJS WASM)');

// Extension origin for targeted postMessage
const PARENT_ORIGIN = (() => {
  try { return new URL(chrome.runtime.getURL('')).origin; } catch { return '*'; }
})();

// Pending RPC callbacks — used by quickjs-runner's rpcCallback to send RPCs to parent
const pendingRPCs = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
let rpcNextId = 1;

function sendRPC(taskId: string, method: string, args: Record<string, unknown>): Promise<unknown> {
  const id = rpcNextId++;
  return new Promise((resolve, reject) => {
    pendingRPCs.set(id, { resolve, reject });
    window.parent.postMessage({ id, type: 'rpc', method, args, taskId }, PARENT_ORIGIN);
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
    const { executionId, taskId, source, state } = data;

    try {
      const result = await createQuickJSExecutor(
        source,
        taskId,
        state || {},
        // RPC callback: forward to parent via postMessage
        (tid, method, args) => sendRPC(tid, method, args),
      );

      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,
        ok: result.ok,
        result: result.result,
        state: result.state,
        error: result.error,
      }, PARENT_ORIGIN);
    } catch (err: any) {
      window.parent.postMessage({
        type: 'execute-script-result',
        executionId,
        ok: false,
        error: err.message || String(err),
      }, PARENT_ORIGIN);
    }
  }
});
