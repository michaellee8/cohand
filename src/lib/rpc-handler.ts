import type { ScriptRPC, ScriptRPCResult, ScriptRPCErrorType } from '../types';
import { startKeepalive, stopKeepalive } from './keepalive';

export type RPCMethodHandler = (
  rpc: ScriptRPC,
) => Promise<{ ok: true; value?: unknown } | { ok: false; error: { type: ScriptRPCErrorType; message: string } }>;

export class RPCHandler {
  private methods = new Map<string, RPCMethodHandler>();

  register(method: string, handler: RPCMethodHandler): void {
    this.methods.set(method, handler);
  }

  /** Call this from chrome.runtime.onConnect handler */
  handleConnection(port: chrome.runtime.Port): void {
    if (port.name !== 'script-rpc') return;

    // Start keepalive pinging while this execution port is alive
    startKeepalive(port);
    port.onDisconnect.addListener(() => {
      stopKeepalive();
    });

    port.onMessage.addListener(async (rpc: ScriptRPC) => {
      // Check deadline
      if (rpc.deadline && Date.now() > rpc.deadline) {
        port.postMessage({
          id: rpc.id,
          ok: false,
          error: { type: 'DeadlineExceeded', message: 'RPC deadline exceeded before processing' },
        } satisfies ScriptRPCResult);
        return;
      }

      const handler = this.methods.get(rpc.method);
      if (!handler) {
        port.postMessage({
          id: rpc.id,
          ok: false,
          error: { type: 'Unknown', message: `Unknown RPC method: ${rpc.method}` },
        } satisfies ScriptRPCResult);
        return;
      }

      try {
        const result = await handler(rpc);
        port.postMessage({ id: rpc.id, ...result } satisfies ScriptRPCResult);
      } catch (err) {
        port.postMessage({
          id: rpc.id,
          ok: false,
          error: { type: 'TargetDetached', message: String(err) },
        } satisfies ScriptRPCResult);
      }
    });
  }

  /** Wire into service worker */
  listen(): void {
    chrome.runtime.onConnect.addListener((port) => this.handleConnection(port));
  }
}
