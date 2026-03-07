import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from './db';
import {
  recordLlmUsage,
  getUsageSummary,
  pruneOldUsage,
} from './llm-usage';
import { LLM_USAGE_RETENTION_DAYS } from '../constants';

let db: IDBDatabase;

beforeEach(async () => {
  // Reset fake-indexeddb between tests
  indexedDB = new IDBFactory();
  db = await openDB();
});

describe('recordLlmUsage', () => {
  it('stores a usage record with generated id and timestamp', async () => {
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 200,
    });

    const records = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readonly');
      const store = tx.objectStore('llm_usage');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });

    expect(records).toHaveLength(1);
    const rec = records[0] as Record<string, unknown>;
    expect(rec.id).toMatch(/^llm-/);
    expect(rec.createdAt).toBeTruthy();
    expect(rec.taskId).toBe('task-1');
    expect(rec.purpose).toBe('explore');
    expect(rec.provider).toBe('openai');
    expect(rec.model).toBe('gpt-4o');
    expect(rec.inputTokens).toBe(500);
    expect(rec.outputTokens).toBe(200);
  });
});

describe('getUsageSummary', () => {
  it('summarizes records within time window', async () => {
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
      cachedTokens: 10,
      costUsd: 0.005,
    });
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'generate',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 200,
      outputTokens: 100,
      cachedTokens: 20,
      costUsd: 0.01,
    });

    const summary = await getUsageSummary(db, 30);
    expect(summary.totalCalls).toBe(2);
    expect(summary.totalInputTokens).toBe(300);
    expect(summary.totalOutputTokens).toBe(150);
    expect(summary.totalCachedTokens).toBe(30);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.015);
  });

  it('groups by purpose and task', async () => {
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    });
    await recordLlmUsage(db, {
      taskId: 'task-2',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 150,
      outputTokens: 75,
    });
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'generate',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 200,
      outputTokens: 100,
    });

    const summary = await getUsageSummary(db, 30);

    // By purpose
    expect(summary.byPurpose['explore'].calls).toBe(2);
    expect(summary.byPurpose['explore'].tokens).toBe(100 + 50 + 150 + 75);
    expect(summary.byPurpose['generate'].calls).toBe(1);
    expect(summary.byPurpose['generate'].tokens).toBe(200 + 100);

    // By task
    expect(summary.byTask['task-1'].calls).toBe(2);
    expect(summary.byTask['task-1'].tokens).toBe(100 + 50 + 200 + 100);
    expect(summary.byTask['task-2'].calls).toBe(1);
    expect(summary.byTask['task-2'].tokens).toBe(150 + 75);
  });

  it('returns zeros when no records', async () => {
    const summary = await getUsageSummary(db, 30);
    expect(summary.totalCalls).toBe(0);
    expect(summary.totalInputTokens).toBe(0);
    expect(summary.totalOutputTokens).toBe(0);
    expect(summary.totalCachedTokens).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.byPurpose).toEqual({});
    expect(summary.byTask).toEqual({});
  });

  it('excludes records older than window', async () => {
    // Insert a record manually with an old timestamp
    const oldRecord = {
      id: 'llm-old-record',
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 250,
      createdAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(), // 60 days ago
    };

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readwrite');
      const store = tx.objectStore('llm_usage');
      const req = store.put(oldRecord);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    // Insert a recent record
    await recordLlmUsage(db, {
      taskId: 'task-2',
      purpose: 'generate',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    });

    const summary = await getUsageSummary(db, 30);
    expect(summary.totalCalls).toBe(1);
    expect(summary.totalInputTokens).toBe(100);
    expect(summary.totalOutputTokens).toBe(50);
  });
});

describe('pruneOldUsage', () => {
  it('deletes records older than retention period', async () => {
    // Insert old record
    const oldDate = new Date(
      Date.now() - (LLM_USAGE_RETENTION_DAYS + 5) * 24 * 60 * 60 * 1000,
    ).toISOString();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readwrite');
      const store = tx.objectStore('llm_usage');
      store.put({
        id: 'llm-old-1',
        taskId: 'task-1',
        purpose: 'explore',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        createdAt: oldDate,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    const deleted = await pruneOldUsage(db);
    expect(deleted).toBe(1);

    // Verify the store is empty
    const remaining = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readonly');
      const store = tx.objectStore('llm_usage');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(remaining).toHaveLength(0);
  });

  it('preserves recent records', async () => {
    // Insert a recent record
    await recordLlmUsage(db, {
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 50,
    });

    const deleted = await pruneOldUsage(db);
    expect(deleted).toBe(0);

    // Verify record still exists
    const remaining = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readonly');
      const store = tx.objectStore('llm_usage');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(remaining).toHaveLength(1);
  });

  it('returns count of deleted records', async () => {
    const oldDate = new Date(
      Date.now() - (LLM_USAGE_RETENTION_DAYS + 1) * 24 * 60 * 60 * 1000,
    ).toISOString();

    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readwrite');
      const store = tx.objectStore('llm_usage');
      store.put({
        id: 'llm-old-a',
        taskId: 'task-1',
        purpose: 'explore',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 100,
        outputTokens: 50,
        createdAt: oldDate,
      });
      store.put({
        id: 'llm-old-b',
        taskId: 'task-1',
        purpose: 'generate',
        provider: 'openai',
        model: 'gpt-4o',
        inputTokens: 200,
        outputTokens: 100,
        createdAt: oldDate,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // Also add a recent record
    await recordLlmUsage(db, {
      taskId: 'task-2',
      purpose: 'generate',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 50,
      outputTokens: 25,
    });

    const deleted = await pruneOldUsage(db);
    expect(deleted).toBe(2);

    // Verify recent record is preserved
    const remaining = await new Promise<unknown[]>((resolve, reject) => {
      const tx = db.transaction('llm_usage', 'readonly');
      const store = tx.objectStore('llm_usage');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    expect(remaining).toHaveLength(1);
  });
});
