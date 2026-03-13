import type { TaskNotification } from '../types';
import { scanNotification } from './security/injection-scanner';
import { MAX_NOTIFICATIONS_PER_TASK_PER_HOUR } from '../constants';

/**
 * Create and deliver a notification from a task.
 *
 * 1. Scan for injection
 * 2. Check rate limit
 * 3. Create IndexedDB record
 * 4. Show chrome.notifications
 */
export async function deliverNotification(
  taskId: string,
  taskName: string,
  message: string,
  db: IDBDatabase,
  options?: { notifyEnabled?: boolean },
): Promise<{ delivered: boolean; reason?: string }> {
  // 0. Check per-task notification toggle (defaults to true if not specified)
  if (options?.notifyEnabled === false) {
    return { delivered: false, reason: 'Notifications disabled for this task' };
  }

  // 1. Scan message
  const scanResult = scanNotification(message);
  if (!scanResult.safe) {
    return { delivered: false, reason: 'Content blocked by injection scanner' };
  }

  // 2. Check rate limit
  const isLimited = await checkRateLimit(db, taskId);
  if (isLimited) {
    return { delivered: false, reason: 'Rate limit exceeded (10/hour)' };
  }

  // 3. Prefix message
  const prefixedMessage = `[Cohand: ${taskName}] ${message}`;

  // 4. Create IndexedDB record
  const notification: TaskNotification = {
    id: `notif-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    taskId,
    message: prefixedMessage,
    isRead: 0,
    createdAt: new Date().toISOString(),
  };

  await putNotificationRecord(db, notification);

  // 5. Show chrome.notification
  try {
    await chrome.notifications.create(notification.id, {
      type: 'basic',
      iconUrl: chrome.runtime.getURL('icon/128.png'),
      title: `Cohand: ${taskName}`,
      message,
    });
  } catch {
    // Chrome notification may fail (e.g., permission denied), but IndexedDB record still saved
  }

  return { delivered: true };
}

async function checkRateLimit(
  db: IDBDatabase,
  taskId: string,
): Promise<boolean> {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();

  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readonly');
    const store = tx.objectStore('notifications');
    const index = store.index('by_task_time');
    const range = IDBKeyRange.bound([taskId, oneHourAgo], [taskId, '\uffff']);
    const request = index.count(range);
    request.onsuccess = () =>
      resolve(request.result >= MAX_NOTIFICATIONS_PER_TASK_PER_HOUR);
    request.onerror = () => reject(request.error);
  });
}

function putNotificationRecord(
  db: IDBDatabase,
  notif: TaskNotification,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    const request = store.put(notif);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * Get recent notifications for display in the dashboard.
 */
export async function getRecentNotifications(
  db: IDBDatabase,
  limit: number = 50,
): Promise<TaskNotification[]> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readonly');
    const store = tx.objectStore('notifications');
    const index = store.index('by_created');
    const request = index.openCursor(null, 'prev'); // newest first
    const results: TaskNotification[] = [];

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results);
      }
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * Mark a notification as read.
 */
export async function markAsRead(
  db: IDBDatabase,
  notificationId: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readwrite');
    const store = tx.objectStore('notifications');
    const getReq = store.get(notificationId);
    getReq.onsuccess = () => {
      const notif = getReq.result;
      if (notif && notif.isRead === 0) {
        notif.isRead = 1;
        const putReq = store.put(notif);
        putReq.onsuccess = () => resolve();
        putReq.onerror = () => reject(putReq.error);
      } else {
        resolve();
      }
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/**
 * Get unread notification count.
 */
export async function getUnreadCount(db: IDBDatabase): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction('notifications', 'readonly');
    const store = tx.objectStore('notifications');
    const index = store.index('by_read_status');
    const request = index.count(0); // isRead = 0
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
