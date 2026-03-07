import { DB_NAME, DB_VERSION } from '../constants';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const old = event.oldVersion;
      if (old < 1) {
        const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
        tasks.createIndex('by_updated', 'updatedAt');

        const sv = db.createObjectStore('script_versions', { keyPath: 'id' });
        sv.createIndex('by_task_version', ['taskId', 'version'], {
          unique: true,
        });
        sv.createIndex('by_task', 'taskId');

        const sr = db.createObjectStore('script_runs', { keyPath: 'id' });
        sr.createIndex('by_task_time', ['taskId', 'ranAt']);
        sr.createIndex('by_task_success_time', [
          'taskId',
          'success',
          'ranAt',
        ]);

        db.createObjectStore('task_state', { keyPath: 'taskId' });

        const ss = db.createObjectStore('state_snapshots', { keyPath: 'id' });
        ss.createIndex('by_task', 'taskId');

        const notif = db.createObjectStore('notifications', { keyPath: 'id' });
        notif.createIndex('by_task_time', ['taskId', 'createdAt']);
        notif.createIndex('by_created', 'createdAt');
        notif.createIndex('by_read_status', 'isRead');

        const llm = db.createObjectStore('llm_usage', { keyPath: 'id' });
        llm.createIndex('by_created', 'createdAt');
        llm.createIndex('by_task', ['taskId', 'createdAt']);
      }
    };
  });
}
