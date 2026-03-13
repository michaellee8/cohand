import type { ScriptRPC, ScriptRPCResult, ScriptRPCError, ScriptRPCErrorType } from '../types';
import { RPC_TIMEOUT_MS } from '../constants';

// Design spec: vary timeout within 30-60s range based on method type
const RPC_TIMEOUT_MIN_MS = 30_000;
const RPC_TIMEOUT_MAX_MS = 60_000;

// Methods that involve humanized interaction tend to take longer
const LONG_METHODS = new Set([
  'type', 'fill', 'scroll', 'goto', 'waitForSelector', 'waitForLoadState',
]);

/**
 * Compute per-method timeout within the 30-60s range.
 * Long methods (type, fill, scroll, goto, waitFor*) get the full 60s.
 * Short methods (click, url, title, etc.) get 30s.
 */
export function getMethodTimeout(method: string): number {
  return LONG_METHODS.has(method) ? RPC_TIMEOUT_MAX_MS : RPC_TIMEOUT_MIN_MS;
}

export class RPCError extends Error {
  type: ScriptRPCErrorType;
  constructor(error: ScriptRPCError) {
    super(error.message);
    this.name = 'RPCError';
    this.type = error.type;
  }
}

interface PendingRPC {
  resolve: (value: unknown) => void;
  reject: (error: RPCError) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class RPCClient {
  private port: chrome.runtime.Port | null = null;
  private pending = new Map<number, PendingRPC>();
  private nextId = 1;
  private disconnected = false;

  connect(): void {
    this.port = chrome.runtime.connect({ name: 'script-rpc' });
    this.disconnected = false;

    this.port.onMessage.addListener((msg: ScriptRPCResult) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.ok) {
        entry.resolve(msg.value);
      } else {
        entry.reject(new RPCError(msg.error!));
      }
    });

    this.port.onDisconnect.addListener(() => {
      this.disconnected = true;
      for (const [, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new RPCError({
          type: 'OwnerDisconnected',
          message: 'Port disconnected',
        }));
      }
      this.pending.clear();
    });
  }

  async call(
    method: string,
    args: Record<string, unknown>,
    taskId: string,
    deadlineMs?: number,
  ): Promise<unknown> {
    if (!this.port || this.disconnected) {
      throw new RPCError({ type: 'OwnerDisconnected', message: 'Not connected' });
    }

    const id = this.nextId++;
    const timeout = deadlineMs ?? getMethodTimeout(method);
    const deadline = Date.now() + timeout;

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RPCError({ type: 'DeadlineExceeded', message: 'RPC timeout' }));
      }, timeout);

      this.pending.set(id, { resolve, reject, timer });

      const rpc: ScriptRPC = { id, taskId, method, args, deadline };
      this.port!.postMessage(rpc);
    });
  }

  disconnect(): void {
    // Reject all pending RPCs before disconnecting
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new RPCError({ type: 'OwnerDisconnected', message: 'Client disconnected' }));
    }
    this.pending.clear();

    if (this.port) {
      this.port.disconnect();
      this.port = null;
    }
  }

  get isConnected(): boolean {
    return this.port !== null && !this.disconnected;
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
