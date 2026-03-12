// Bridges between sandboxed iframe (postMessage) and service worker (RPC port)
import { RPCClient } from './rpc-client';

export interface SandboxRequest {
  id: number;
  type: 'rpc';
  method: string;
  args: Record<string, unknown>;
  taskId: string;
}

export interface SandboxResponse {
  id: number;
  type: 'rpc-result';
  ok: boolean;
  value?: unknown;
  error?: { type: string; message: string };
}

export interface ExecuteScriptRequest {
  type: 'execute-script';
  executionId: string;
  taskId: string;
  source: string;
  state: Record<string, unknown>;
  tabId: number;
}

export interface ExecuteScriptResult {
  type: 'execute-script-result';
  executionId: string;
  ok: boolean;
  result?: unknown;
  state?: Record<string, unknown>;
  error?: string;
}

export class SandboxBridge {
  private iframe: HTMLIFrameElement | null = null;
  private rpcClient: RPCClient;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(rpcClient?: RPCClient) {
    this.rpcClient = rpcClient ?? new RPCClient();
  }

  init(iframe: HTMLIFrameElement): void {
    this.iframe = iframe;
    this.rpcClient.connect();

    // Listen for messages from sandbox iframe
    this.messageHandler = async (event: MessageEvent) => {
      // Only accept messages from our sandbox iframe
      if (event.source !== this.iframe?.contentWindow) return;

      const data = event.data;

      if (data.type === 'rpc') {
        // Forward RPC to service worker
        const request = data as SandboxRequest;
        try {
          const value = await this.rpcClient.call(
            request.method,
            request.args,
            request.taskId,
          );
          this.sendToSandbox({
            id: request.id,
            type: 'rpc-result',
            ok: true,
            value,
          });
        } catch (err: any) {
          this.sendToSandbox({
            id: request.id,
            type: 'rpc-result',
            ok: false,
            error: { type: err.type || 'Unknown', message: err.message },
          });
        }
      }
    };

    window.addEventListener('message', this.messageHandler);
  }

  // Send execution request to sandbox
  executeScript(request: ExecuteScriptRequest): void {
    this.sendToSandbox(request);
  }

  // Listen for execution results from sandbox. Returns cleanup function.
  // If executionId is provided, only results matching that ID will be delivered.
  onExecutionResult(callback: (result: ExecuteScriptResult) => void, executionId?: string): () => void {
    const handler = (event: MessageEvent) => {
      if (event.source !== this.iframe?.contentWindow) return;
      if (event.data.type === 'execute-script-result') {
        if (executionId && event.data.executionId !== executionId) return;
        callback(event.data as ExecuteScriptResult);
      }
    };
    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
  }

  private getTargetOrigin(): string {
    try {
      return new URL(chrome.runtime.getURL('')).origin;
    } catch {
      return '*'; // fallback for test environment
    }
  }

  private sendToSandbox(data: unknown): void {
    this.iframe?.contentWindow?.postMessage(data, this.getTargetOrigin());
  }

  destroy(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
    this.rpcClient.disconnect();
    this.iframe = null;
  }
}
