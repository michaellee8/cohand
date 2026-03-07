import type { LlmUsageRecord } from '../types';
import { LLM_USAGE_RETENTION_DAYS } from '../constants';

/**
 * Record an LLM API call.
 */
export async function recordLlmUsage(
  db: IDBDatabase,
  record: Omit<LlmUsageRecord, 'id' | 'createdAt'>,
): Promise<void> {
  const fullRecord: LlmUsageRecord = {
    ...record,
    id: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: new Date().toISOString(),
  };

  return new Promise((resolve, reject) => {
    const tx = db.transaction('llm_usage', 'readwrite');
    const store = tx.objectStore('llm_usage');
    const request = store.put(fullRecord);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get usage summary for display.
 */
export interface UsageSummary {
  totalCalls: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  estimatedCostUsd: number;
  byPurpose: Record<string, { calls: number; tokens: number }>;
  byTask: Record<string, { calls: number; tokens: number }>;
}

export async function getUsageSummary(
  db: IDBDatabase,
  sinceDaysAgo: number = 30,
): Promise<UsageSummary> {
  const since = new Date(Date.now() - sinceDaysAgo * 24 * 60 * 60 * 1000).toISOString();

  const records = await new Promise<LlmUsageRecord[]>((resolve, reject) => {
    const tx = db.transaction('llm_usage', 'readonly');
    const store = tx.objectStore('llm_usage');
    const index = store.index('by_created');
    const range = IDBKeyRange.lowerBound(since);
    const request = index.getAll(range);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

  const summary: UsageSummary = {
    totalCalls: records.length,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCachedTokens: 0,
    estimatedCostUsd: 0,
    byPurpose: {},
    byTask: {},
  };

  for (const record of records) {
    summary.totalInputTokens += record.inputTokens;
    summary.totalOutputTokens += record.outputTokens;
    summary.totalCachedTokens += record.cachedTokens ?? 0;
    summary.estimatedCostUsd += record.costUsd ?? 0;

    // By purpose
    if (!summary.byPurpose[record.purpose]) {
      summary.byPurpose[record.purpose] = { calls: 0, tokens: 0 };
    }
    summary.byPurpose[record.purpose].calls++;
    summary.byPurpose[record.purpose].tokens += record.inputTokens + record.outputTokens;

    // By task
    if (!summary.byTask[record.taskId]) {
      summary.byTask[record.taskId] = { calls: 0, tokens: 0 };
    }
    summary.byTask[record.taskId].calls++;
    summary.byTask[record.taskId].tokens += record.inputTokens + record.outputTokens;
  }

  return summary;
}

/**
 * Prune old usage records (older than retention period).
 */
export async function pruneOldUsage(db: IDBDatabase): Promise<number> {
  const cutoff = new Date(Date.now() - LLM_USAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('llm_usage', 'readwrite');
    const store = tx.objectStore('llm_usage');
    const index = store.index('by_created');
    const range = IDBKeyRange.upperBound(cutoff);
    const request = index.openCursor(range);
    let deleted = 0;

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        deleted++;
        cursor.continue();
      } else {
        resolve(deleted);
      }
    };
    request.onerror = () => reject(request.error);
  });
}
