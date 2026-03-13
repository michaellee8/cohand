import { create } from 'zustand';
import type { Task, ScriptRun, TaskNotification, ScriptVersion, TaskState } from '../../../types';
import { RUNS_DISPLAY_LIMIT } from '../../../constants';

interface TasksState {
  tasks: Task[];
  selectedTaskId: string | null;
  runs: Record<string, ScriptRun[]>;
  scriptVersions: Record<string, ScriptVersion[]>;
  taskStates: Record<string, TaskState>;
  notifications: TaskNotification[];
  unreadCount: number;
  loading: boolean;
  runningTaskId: string | null;
  error: string | null;

  // Actions
  fetchTasks: () => Promise<void>;
  selectTask: (taskId: string | null) => void;
  fetchRunsForTask: (taskId: string) => Promise<void>;
  fetchScriptVersions: (taskId: string) => Promise<void>;
  fetchTaskState: (taskId: string) => Promise<void>;
  updateTask: (task: Task) => Promise<void>;
  fetchNotifications: () => Promise<void>;
  fetchUnreadCount: () => Promise<void>;
  markNotificationRead: (notificationId: string) => Promise<void>;
  runTask: (taskId: string) => Promise<void>;
  deleteTask: (taskId: string) => Promise<void>;
}

export const useTasksStore = create<TasksState>((set, get) => ({
  tasks: [],
  selectedTaskId: null,
  runs: {},
  scriptVersions: {},
  taskStates: {},
  notifications: [],
  unreadCount: 0,
  loading: false,
  runningTaskId: null,
  error: null,

  fetchTasks: async () => {
    set({ loading: true, error: null });
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TASKS' });
      const tasks: Task[] = response.tasks || [];
      set({ tasks, loading: false });

      // Fetch the most recent run for each task (for last-run indicator on cards)
      for (const task of tasks) {
        chrome.runtime.sendMessage({ type: 'GET_RUNS', taskId: task.id, limit: 1 })
          .then(runsResp => {
            const runs = runsResp.runs || [];
            if (runs.length > 0) {
              set(state => ({
                runs: { ...state.runs, [task.id]: runs },
              }));
            }
          })
          .catch(() => {}); // Non-critical, silently ignore
      }
    } catch (e) {
      set({ loading: false, error: String(e) });
    }
  },

  selectTask: (taskId) => {
    set({ selectedTaskId: taskId });
    if (taskId) {
      get().fetchRunsForTask(taskId);
      get().fetchScriptVersions(taskId);
      get().fetchTaskState(taskId);
    }
  },

  fetchRunsForTask: async (taskId) => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_RUNS', taskId, limit: RUNS_DISPLAY_LIMIT });
      set(state => ({
        runs: { ...state.runs, [taskId]: response.runs || [] },
      }));
    } catch (e) { set({ error: String(e) }); }
  },

  fetchScriptVersions: async (taskId) => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_SCRIPT_VERSIONS', taskId });
      set(state => ({
        scriptVersions: { ...state.scriptVersions, [taskId]: response.versions || [] },
      }));
    } catch (e) { set({ error: String(e) }); }
  },

  fetchTaskState: async (taskId) => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TASK_STATE', taskId });
      if (response.state) {
        set(state => ({
          taskStates: { ...state.taskStates, [taskId]: response.state },
        }));
      }
    } catch (e) { set({ error: String(e) }); }
  },

  updateTask: async (task) => {
    try {
      await chrome.runtime.sendMessage({ type: 'UPDATE_TASK', task });
      set(state => ({
        tasks: state.tasks.map(t => t.id === task.id ? task : t),
      }));
    } catch (e) { set({ error: String(e) }); }
  },

  fetchNotifications: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_NOTIFICATIONS', limit: 50 });
      set({ notifications: response.notifications || [] });
    } catch (e) { set({ error: String(e) }); }
  },

  fetchUnreadCount: async () => {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_UNREAD_COUNT' });
      set({ unreadCount: response.count || 0 });
    } catch (e) { set({ error: String(e) }); }
  },

  markNotificationRead: async (notificationId) => {
    try {
      await chrome.runtime.sendMessage({ type: 'MARK_NOTIFICATION_READ', notificationId });
      set(state => {
        const notification = state.notifications.find(n => n.id === notificationId);
        const wasUnread = notification && !notification.isRead;
        return {
          notifications: state.notifications.map(n =>
            n.id === notificationId ? { ...n, isRead: 1 } : n
          ),
          unreadCount: wasUnread ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
        };
      });
    } catch (e) { set({ error: String(e) }); }
  },

  runTask: async (taskId) => {
    try {
      set({ runningTaskId: taskId, error: null });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        set({ runningTaskId: null, error: 'No active tab found to run task' });
        return;
      }
      await chrome.runtime.sendMessage({ type: 'EXECUTE_TASK', taskId, tabId: tab.id });
      // Refresh runs to show latest result
      await get().fetchRunsForTask(taskId);
      set({ runningTaskId: null });
    } catch (e) {
      set({ runningTaskId: null, error: String(e) });
    }
  },

  deleteTask: async (taskId) => {
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_TASK', taskId });
      set(state => ({
        tasks: state.tasks.filter(t => t.id !== taskId),
        selectedTaskId: state.selectedTaskId === taskId ? null : state.selectedTaskId,
      }));
    } catch (e) { set({ error: String(e) }); }
  },
}));
