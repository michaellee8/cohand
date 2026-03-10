import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDB } from './db';

describe('openDB', () => {
  beforeEach(() => {
    // Reset fake-indexeddb between tests
    indexedDB = new IDBFactory();
  });

  it('creates all v1 stores', async () => {
    const db = await openDB();
    const stores = Array.from(db.objectStoreNames);
    expect(stores).toContain('tasks');
    expect(stores).toContain('script_versions');
    expect(stores).toContain('script_runs');
    expect(stores).toContain('task_state');
    expect(stores).toContain('state_snapshots');
    expect(stores).toContain('notifications');
    expect(stores).toContain('llm_usage');
    expect(stores.length).toBe(10);
    db.close();
  });

  it('creates correct indexes on tasks', async () => {
    const db = await openDB();
    const tx = db.transaction('tasks', 'readonly');
    const store = tx.objectStore('tasks');
    expect(store.indexNames.contains('by_updated')).toBe(true);
    db.close();
  });

  it('creates correct indexes on script_versions', async () => {
    const db = await openDB();
    const tx = db.transaction('script_versions', 'readonly');
    const store = tx.objectStore('script_versions');
    expect(store.indexNames.contains('by_task_version')).toBe(true);
    expect(store.indexNames.contains('by_task')).toBe(true);
    db.close();
  });

  it('creates correct indexes on script_runs', async () => {
    const db = await openDB();
    const tx = db.transaction('script_runs', 'readonly');
    const store = tx.objectStore('script_runs');
    expect(store.indexNames.contains('by_task_time')).toBe(true);
    expect(store.indexNames.contains('by_task_success_time')).toBe(true);
    db.close();
  });

  it('creates correct indexes on notifications', async () => {
    const db = await openDB();
    const tx = db.transaction('notifications', 'readonly');
    const store = tx.objectStore('notifications');
    expect(store.indexNames.contains('by_task_time')).toBe(true);
    expect(store.indexNames.contains('by_created')).toBe(true);
    expect(store.indexNames.contains('by_read_status')).toBe(true);
    db.close();
  });

  it('creates correct indexes on llm_usage', async () => {
    const db = await openDB();
    const tx = db.transaction('llm_usage', 'readonly');
    const store = tx.objectStore('llm_usage');
    expect(store.indexNames.contains('by_created')).toBe(true);
    expect(store.indexNames.contains('by_task')).toBe(true);
    db.close();
  });

  it('creates recording stores in v2', async () => {
    const db = await openDB();
    expect(db.objectStoreNames.contains('recordings')).toBe(true);
    expect(db.objectStoreNames.contains('recording_steps')).toBe(true);
    expect(db.objectStoreNames.contains('recording_page_snapshots')).toBe(true);
    db.close();
  });

  it('creates state_snapshots with by_task index', async () => {
    const db = await openDB();
    const tx = db.transaction('state_snapshots', 'readonly');
    const store = tx.objectStore('state_snapshots');
    expect(store.indexNames.contains('by_task')).toBe(true);
    db.close();
  });
});
