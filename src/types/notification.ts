export interface TaskNotification {
  id: string;
  taskId: string;
  message: string;
  isRead: number; // 0 or 1 (IndexedDB cannot index null)
  createdAt: string; // millisecond precision
}

export interface LlmUsageRecord {
  id: string;
  taskId: string;
  purpose: 'explore' | 'generate' | 'repair' | 'security_review' | 'injection_scan';
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens?: number;
  costUsd?: number;
  createdAt: string;
}
