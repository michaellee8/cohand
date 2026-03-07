export interface TaskState {
  taskId: string;
  state: Record<string, unknown>; // max 1MB
  updatedAt: string;
}

export interface StateSnapshot {
  id: string; // runId
  taskId: string;
  state: Record<string, unknown>;
  createdAt: string;
}
