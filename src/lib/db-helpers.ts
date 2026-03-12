import type {
  Task,
  ScriptVersion,
  ScriptRun,
  TaskState,
  StateSnapshot,
  TaskNotification,
  LlmUsageRecord,
  RecordingRecord,
  RecordingStepRecord,
  RecordingPageSnapshot,
} from '../types';
import {
  MAX_RUNS_PER_TASK,
  MAX_SCRIPT_VERSIONS,
  MAX_STATE_SNAPSHOTS_PER_TASK,
} from '../constants';

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

export function putRecord<T>(
  db: IDBDatabase,
  storeName: string,
  record: T,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function getRecord<T>(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.get(key);
    request.onsuccess = () => resolve(request.result as T | undefined);
    request.onerror = () => reject(request.error);
  });
}

export function deleteRecord(
  db: IDBDatabase,
  storeName: string,
  key: IDBValidKey,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const request = store.delete(key);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

export function getAllRecords<T>(
  db: IDBDatabase,
  storeName: string,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

export function getAllByIndex<T>(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.getAll(query);
    request.onsuccess = () => resolve(request.result as T[]);
    request.onerror = () => reject(request.error);
  });
}

export function countByIndex(
  db: IDBDatabase,
  storeName: string,
  indexName: string,
  query: IDBValidKey | IDBKeyRange,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const store = tx.objectStore(storeName);
    const index = store.index(indexName);
    const request = index.count(query);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

export const putTask = (db: IDBDatabase, task: Task) =>
  putRecord(db, 'tasks', task);

export const getTask = (db: IDBDatabase, id: string) =>
  getRecord<Task>(db, 'tasks', id);

export const getAllTasks = (db: IDBDatabase) =>
  getAllRecords<Task>(db, 'tasks');

export const deleteTask = (db: IDBDatabase, id: string) =>
  deleteRecord(db, 'tasks', id);

// ---------------------------------------------------------------------------
// Script Versions
// ---------------------------------------------------------------------------

export const putScriptVersion = (db: IDBDatabase, sv: ScriptVersion) =>
  putRecord(db, 'script_versions', sv);

export const getScriptVersion = (db: IDBDatabase, id: string) =>
  getRecord<ScriptVersion>(db, 'script_versions', id);

export const getScriptVersionsForTask = (db: IDBDatabase, taskId: string) =>
  getAllByIndex<ScriptVersion>(db, 'script_versions', 'by_task', taskId);

/** Cap script versions per task – keeps the newest MAX_SCRIPT_VERSIONS. */
export async function capScriptVersions(
  db: IDBDatabase,
  taskId: string,
): Promise<void> {
  const versions = await getScriptVersionsForTask(db, taskId);
  if (versions.length <= MAX_SCRIPT_VERSIONS) return;
  // Sort by version desc, delete oldest
  versions.sort((a, b) => b.version - a.version);
  const toDelete = versions.slice(MAX_SCRIPT_VERSIONS);
  for (const v of toDelete) {
    await deleteRecord(db, 'script_versions', v.id);
  }
}

// ---------------------------------------------------------------------------
// Script Runs
// ---------------------------------------------------------------------------

export const addScriptRun = (db: IDBDatabase, run: ScriptRun) =>
  putRecord(db, 'script_runs', run);

export async function getRunsForTask(
  db: IDBDatabase,
  taskId: string,
  limit?: number,
): Promise<ScriptRun[]> {
  const runs = await getAllByIndex<ScriptRun>(
    db,
    'script_runs',
    'by_task_time',
    IDBKeyRange.bound([taskId], [taskId, '\uffff']),
  );
  // Sort newest first
  runs.sort((a, b) => b.ranAt.localeCompare(a.ranAt));
  return limit ? runs.slice(0, limit) : runs;
}

export async function capRuns(
  db: IDBDatabase,
  taskId: string,
): Promise<void> {
  const runs = await getRunsForTask(db, taskId);
  if (runs.length <= MAX_RUNS_PER_TASK) return;
  const toDelete = runs.slice(MAX_RUNS_PER_TASK);
  for (const r of toDelete) {
    await deleteRecord(db, 'script_runs', r.id);
  }
}

// ---------------------------------------------------------------------------
// Task State
// ---------------------------------------------------------------------------

export const putTaskState = (db: IDBDatabase, state: TaskState) =>
  putRecord(db, 'task_state', state);

export const getTaskState = (db: IDBDatabase, taskId: string) =>
  getRecord<TaskState>(db, 'task_state', taskId);

// ---------------------------------------------------------------------------
// State Snapshots
// ---------------------------------------------------------------------------

export const putStateSnapshot = (db: IDBDatabase, snapshot: StateSnapshot) =>
  putRecord(db, 'state_snapshots', snapshot);

/** Cap state snapshots per task – keeps the newest MAX_STATE_SNAPSHOTS_PER_TASK. */
export async function capStateSnapshots(
  db: IDBDatabase,
  taskId: string,
): Promise<void> {
  const snapshots = await getAllByIndex<StateSnapshot>(
    db,
    'state_snapshots',
    'by_task',
    taskId,
  );
  if (snapshots.length <= MAX_STATE_SNAPSHOTS_PER_TASK) return;
  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const toDelete = snapshots.slice(MAX_STATE_SNAPSHOTS_PER_TASK);
  for (const s of toDelete) {
    await deleteRecord(db, 'state_snapshots', s.id);
  }
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export const putNotification = (db: IDBDatabase, notif: TaskNotification) =>
  putRecord(db, 'notifications', notif);

export const getNotification = (db: IDBDatabase, id: string) =>
  getRecord<TaskNotification>(db, 'notifications', id);

/** Check rate limit: MAX_NOTIFICATIONS_PER_TASK_PER_HOUR per task per hour. */
export async function isNotificationRateLimited(
  db: IDBDatabase,
  taskId: string,
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const recent = await getAllByIndex<TaskNotification>(
    db,
    'notifications',
    'by_task_time',
    IDBKeyRange.bound([taskId, oneHourAgo], [taskId, '\uffff']),
  );
  return recent.length >= 10; // MAX_NOTIFICATIONS_PER_TASK_PER_HOUR
}

// ---------------------------------------------------------------------------
// LLM Usage
// ---------------------------------------------------------------------------

export const putLlmUsage = (db: IDBDatabase, record: LlmUsageRecord) =>
  putRecord(db, 'llm_usage', record);

export const getLlmUsageForTask = (db: IDBDatabase, taskId: string) =>
  getAllByIndex<LlmUsageRecord>(
    db,
    'llm_usage',
    'by_task',
    IDBKeyRange.bound([taskId], [taskId, '\uffff']),
  );

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------

export const putRecording = (db: IDBDatabase, record: RecordingRecord) =>
  putRecord(db, 'recordings', record);

export const getRecording = (db: IDBDatabase, id: string) =>
  getRecord<RecordingRecord>(db, 'recordings', id);

// ---------------------------------------------------------------------------
// Recording Steps
// ---------------------------------------------------------------------------

export const putRecordingStep = (db: IDBDatabase, step: RecordingStepRecord) =>
  putRecord(db, 'recording_steps', step);

export async function getRecordingSteps(db: IDBDatabase, recordingId: string): Promise<RecordingStepRecord[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('recording_steps', 'readonly');
    const store = tx.objectStore('recording_steps');
    const index = store.index('by_recording');
    const request = index.getAll(recordingId);
    request.onsuccess = () => {
      const steps = request.result as RecordingStepRecord[];
      steps.sort((a, b) => a.sequenceIndex - b.sequenceIndex);
      resolve(steps);
    };
    request.onerror = () => reject(request.error);
  });
}

export const deleteRecordingStep = (db: IDBDatabase, stepId: string) =>
  deleteRecord(db, 'recording_steps', stepId);

// ---------------------------------------------------------------------------
// Recording Page Snapshots
// ---------------------------------------------------------------------------

export const putRecordingPageSnapshot = (db: IDBDatabase, snapshot: RecordingPageSnapshot) =>
  putRecord(db, 'recording_page_snapshots', snapshot);

export const getRecordingPageSnapshots = (db: IDBDatabase, recordingId: string) =>
  getAllByIndex<RecordingPageSnapshot>(db, 'recording_page_snapshots', 'by_recording', recordingId);

// ---------------------------------------------------------------------------
// Recording Cascade Delete
// ---------------------------------------------------------------------------

export async function deleteRecording(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(['recordings', 'recording_steps', 'recording_page_snapshots'], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);

    // Delete the recording itself
    tx.objectStore('recordings').delete(id);

    // Delete all steps for this recording
    const stepsIndex = tx.objectStore('recording_steps').index('by_recording');
    const stepsReq = stepsIndex.openCursor(id);
    stepsReq.onsuccess = () => {
      const cursor = stepsReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };

    // Delete all snapshots for this recording
    const snapsIndex = tx.objectStore('recording_page_snapshots').index('by_recording');
    const snapsReq = snapsIndex.openCursor(id);
    snapsReq.onsuccess = () => {
      const cursor = snapsReq.result;
      if (cursor) { cursor.delete(); cursor.continue(); }
    };
  });
}
