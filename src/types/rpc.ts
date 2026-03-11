export interface ScriptRPC {
  id: number;
  taskId: string;
  method: string; // 'click' | 'fill' | 'goto' | ...
  args: Record<string, unknown>;
  deadline: number; // timestamp
}

export interface ScriptRPCResult {
  id: number;
  ok: boolean;
  value?: unknown;
  error?: ScriptRPCError;
}

export interface ScriptRPCError {
  type: ScriptRPCErrorType;
  message: string;
}

export type ScriptRPCErrorType =
  | 'NavigationChanged'
  | 'TargetDetached'
  | 'SelectorNotFound'
  | 'DeadlineExceeded'
  | 'OwnerDisconnected'
  | 'DomainDisallowed'
  | 'SensitivePage'
  | 'ReadLimitExceeded'
  | 'Unknown';
