import { create } from 'zustand';
import type { Task, ScriptRun, TaskNotification } from '../../../types';

interface TasksState {
  tasks: Task[];
  selectedTaskId: string | null;
  runs: Map<string, ScriptRun[]>;
  notifications: TaskNotification[];
  unreadCount: number;
  loading: boolean;

  // Actions
  fetchTasks: () => Promise<void>;
  selectTask: (taskId: string | null) => void;
  fetchRunsForTask: (taskId: string) => Promise<void>;
  fetchNotifications: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  runTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  runs: new Map(),
  notifications: [],
  unreadCount: 0,
  loading: false,

  fetchTasks: async () => {
    set({ loading: true });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TASKS' });
      set({ tasks: response.tasks || [], loading: false });
    } catch {
      set({ loading: false });
    }
  },

  selectTask: (taskId) => {
    set({ selectedTaskId: taskId });
    if (taskId) get().fetchRunsForTask(taskId);
  },

  fetchRunsForTask: async (taskId) => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_RUNS', taskId, limit: 20 });
      const runs = new Map(get().runs);
      runs.set(taskId, response.runs || []);
      set({ runs });
    } catch { /* ignore */ }
  },

  fetchNotifications: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_NOTIFICATIONS', limit: 50 });
      set({ notifications: response.notifications || [] });
    } catch { /* ignore */ }
  },

  fetchUnreadCount: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
      set({ unreadCount: response.count || 0 });
    } catch { /* ignore */ }
  },

  markNotificationRead: async (notificationId) => {
    try {
      await chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId });
      // Update local state
      set(state => ({
        notifications: state.notifications.map(n =>
          n.id === notificationId ? { ...n, isRead: 1 } : n
        ),
        unreadCount: Math.max(0, state.unreadCount - 1),
      }));
    } catch { /* ignore */ }
  },

  runTask: async (taskId) => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await chrome.runtime.sendMessage({ type: 'EXECUTE_TASK', taskId, tabId: tab.id });
      }
    } catch { /* ignore */ }
  },

  deleteTask: async (taskId) => {
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_TASK', taskId });
      set(state => ({
        tasks: state.tasks.filter(t => t.id !== taskId),
        selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
      }));
    } catch { /* ignore */ }
  },
}));
