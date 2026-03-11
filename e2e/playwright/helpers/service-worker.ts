import type { Page } from '@playwright/test';

/**
 * Helpers for sending messages to the extension's service worker
 * via chrome.runtime.sendMessage from a page context.
 */

type SendMessageFn = (msg: Record<string, unknown>) => Promise<unknown>;

/**
 * Create a message sender bound to a specific page.
 * The page must be within the extension context (e.g. side panel)
 * or be a regular page where the content script is loaded.
 */
function createSender(page: Page, extensionId: string): SendMessageFn {
  return async (msg: Record<string, unknown>) => {
    return page.evaluate(
      ({ extensionId, msg }) => {
        return new Promise((resolve, reject) => {
          chrome.runtime.sendMessage(extensionId, msg, (response: unknown) => {
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(response);
            }
          });
        });
      },
      { extensionId, msg },
    );
  };
}

/**
 * Create a message sender for use from within the extension's own pages
 * (side panel, popup, options). No extensionId needed.
 */
function createInternalSender(page: Page): SendMessageFn {
  return async (msg: Record<string, unknown>) => {
    return page.evaluate((msg) => {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage(msg, (response: unknown) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else {
            resolve(response);
          }
        });
      });
    }, msg);
  };
}

// ── Typed helpers ────────────────────────────────────────────────────

export interface Task {
  id: string;
  name: string;
  description: string;
  allowedDomains: string[];
  schedule: { type: 'manual' } | { type: 'interval'; intervalMinutes: number };
  activeScriptVersion: number;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface ScriptRun {
  id: string;
  taskId: string;
  success: boolean;
  durationMs: number;
  ranAt: string;
  [key: string]: unknown;
}

export class ServiceWorkerHelper {
  private send: SendMessageFn;

  /**
   * @param page - An extension page (side panel) to send messages from
   * @param extensionId - Only needed if sending from a non-extension page
   */
  constructor(page: Page, extensionId?: string) {
    this.send = extensionId
      ? createSender(page, extensionId)
      : createInternalSender(page);
  }

  async createTask(task: Partial<Task> & { name: string }, scriptSource?: string): Promise<{ ok: true }> {
    const now = new Date().toISOString();
    const fullTask: Task = {
      id: task.id ?? `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: task.name,
      description: task.description ?? '',
      allowedDomains: task.allowedDomains ?? ['localhost'],
      schedule: task.schedule ?? { type: 'manual' },
      activeScriptVersion: task.activeScriptVersion ?? 1,
      disabled: task.disabled ?? false,
      createdAt: task.createdAt ?? now,
      updatedAt: task.updatedAt ?? now,
      ...task,
    };
    const msg: Record<string, unknown> = { type: 'CREATE_TASK', task: fullTask };
    if (scriptSource) {
      msg.scriptSource = scriptSource;
    }
    return this.send(msg) as Promise<{ ok: true }>;
  }

  async updateTask(task: Partial<Task> & { id: string }): Promise<{ ok: true }> {
    return this.send({ type: 'UPDATE_TASK', task }) as Promise<{ ok: true }>;
  }

  async getTasks(): Promise<{ tasks: Task[] }> {
    return this.send({ type: 'GET_TASKS' }) as Promise<{ tasks: Task[] }>;
  }

  async getTask(taskId: string): Promise<{ task: Task | undefined }> {
    return this.send({ type: 'GET_TASK', taskId }) as Promise<{ task: Task | undefined }>;
  }

  async deleteTask(taskId: string): Promise<{ ok: true }> {
    return this.send({ type: 'DELETE_TASK', taskId }) as Promise<{ ok: true }>;
  }

  async getRuns(taskId: string, limit?: number): Promise<{ runs: ScriptRun[] }> {
    return this.send({ type: 'GET_RUNS', taskId, ...(limit != null ? { limit } : {}) }) as Promise<{ runs: ScriptRun[] }>;
  }

  async executeTask(taskId: string, tabId: number): Promise<{ ok: true }> {
    return this.send({ type: 'EXECUTE_TASK', taskId, tabId }) as Promise<{ ok: true }>;
  }

  async cancelExecution(taskId: string): Promise<{ ok: true }> {
    return this.send({ type: 'CANCEL_EXECUTION', taskId }) as Promise<{ ok: true }>;
  }

  async getNotifications(limit?: number): Promise<{ notifications: unknown[] }> {
    return this.send({ type: 'GET_NOTIFICATIONS', ...(limit != null ? { limit } : {}) }) as Promise<{ notifications: unknown[] }>;
  }

  async markNotificationRead(notificationId: string): Promise<{ ok: true }> {
    return this.send({ type: 'MARK_NOTIFICATION_READ', notificationId }) as Promise<{ ok: true }>;
  }

  async getUnreadCount(): Promise<{ count: number }> {
    return this.send({ type: 'GET_UNREAD_COUNT' }) as Promise<{ count: number }>;
  }

  async getUsageSummary(sinceDaysAgo?: number): Promise<{ summary: unknown }> {
    return this.send({ type: 'GET_USAGE_SUMMARY', ...(sinceDaysAgo != null ? { sinceDaysAgo } : {}) }) as Promise<{ summary: unknown }>;
  }

  /** Send an arbitrary message */
  async sendRaw(msg: Record<string, unknown>): Promise<unknown> {
    return this.send(msg);
  }
}
