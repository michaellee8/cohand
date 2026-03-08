import type { Task, ScriptRun, TaskNotification, DomainPermission } from '../types';
import type { UsageSummary } from './llm-usage';

// All messages that can be sent to the service worker
export type Message =
  // Task management
  | { type: 'CREATE_TASK'; task: Task; scriptSource?: string }
  | { type: 'UPDATE_TASK'; task: Task }
  | { type: 'DELETE_TASK'; taskId: string }
  | { type: 'GET_TASKS' }
  | { type: 'GET_TASK'; taskId: string }
  // Script execution
  | { type: 'EXECUTE_TASK'; taskId: string; tabId: number }
  | { type: 'CANCEL_EXECUTION'; taskId: string }
  // Script runs
  | { type: 'GET_RUNS'; taskId: string; limit?: number }
  // Script generation (wizard)
  | { type: 'GENERATE_SCRIPT'; tabId: number; description: string; domains: string[] }
  | { type: 'TEST_SCRIPT'; tabId: number; source: string; domains: string[] }
  // Page observation
  | { type: 'GET_A11Y_TREE'; tabId: number }
  | { type: 'SCREENSHOT'; tabId: number }
  // CDP control
  | { type: 'ATTACH_DEBUGGER'; tabId: number }
  | { type: 'DETACH_DEBUGGER'; tabId: number }
  // Notifications
  | { type: 'GET_NOTIFICATIONS'; limit?: number }
  | { type: 'MARK_NOTIFICATION_READ'; notificationId: string }
  | { type: 'GET_UNREAD_COUNT' }
  // LLM usage
  | { type: 'GET_USAGE_SUMMARY'; sinceDaysAgo?: number }
  // Offscreen document
  | { type: 'ENSURE_OFFSCREEN' }
  // Settings (read via chrome.storage.local directly, but some actions go through SW)
  | { type: 'ADD_DOMAIN_PERMISSION'; permission: DomainPermission }
  | { type: 'REMOVE_DOMAIN_PERMISSION'; domain: string };

// Response type mapping
export type MessageResponse = {
  CREATE_TASK: { ok: true };
  UPDATE_TASK: { ok: true };
  DELETE_TASK: { ok: true };
  GET_TASKS: { tasks: Task[] };
  GET_TASK: { task: Task | undefined };
  EXECUTE_TASK: { ok: true };
  CANCEL_EXECUTION: { ok: true };
  GET_RUNS: { runs: ScriptRun[] };
  GENERATE_SCRIPT: { source: string; astValid: boolean; securityPassed: boolean };
  TEST_SCRIPT: { ok: boolean; result?: unknown; error?: string };
  GET_A11Y_TREE: { tree: unknown };
  SCREENSHOT: { dataUrl: string };
  ATTACH_DEBUGGER: { ok: true };
  DETACH_DEBUGGER: { ok: true };
  GET_NOTIFICATIONS: { notifications: TaskNotification[] };
  MARK_NOTIFICATION_READ: { ok: true };
  GET_UNREAD_COUNT: { count: number };
  GET_USAGE_SUMMARY: { summary: UsageSummary };
  ENSURE_OFFSCREEN: { ok: true };
  ADD_DOMAIN_PERMISSION: { ok: true };
  REMOVE_DOMAIN_PERMISSION: { ok: true };
};
