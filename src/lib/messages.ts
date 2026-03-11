import type { Task, ScriptRun, TaskNotification, DomainPermission } from '../types';
import type { UsageSummary } from './llm-usage';

// All messages that can be sent to the service worker
export type Message =
  // Task management
  | { type: 'CREATE_TASK'; task: Task; scriptSource?: string; astValidationPassed?: boolean; securityReviewPassed?: boolean; reviewDetails?: import('../types/script').ReviewDetail[] }
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
  | { type: 'REMOVE_DOMAIN_PERMISSION'; domain: string }
  // Recording
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'OAUTH_CALLBACK'; code: string; state: string }
  | { type: 'START_CODEX_OAUTH' }
  | { type: 'LOGOUT_CODEX' }
  | { type: 'DELETE_RECORDING_STEP'; stepId: string };

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
  START_RECORDING: { ok: true; sessionId: string };
  STOP_RECORDING: { ok: true };
  OAUTH_CALLBACK: { ok: true };
  START_CODEX_OAUTH: { ok: true };
  LOGOUT_CODEX: { ok: true };
  DELETE_RECORDING_STEP: { ok: true };
};

// Content script → Service worker (events from recording overlay)
export type ContentScriptEvent =
  | { type: 'RECORDING_ACTION'; action: import('../types/recording').RawRecordingAction }
  | { type: 'KEYSTROKE_UPDATE'; text: string; element: { selector: string; tag: string; name?: string }; isFinal: boolean }
  | { type: 'ELEMENT_SELECTION'; elementInfo: Record<string, unknown>; url: string; cancelled?: boolean };

// Service worker → Sidepanel (via 'recording-stream' long-lived port)
export type RecordingPortMessage =
  | { type: 'RECORDING_STEP'; step: import('../types/recording').RecordingStep }
  | { type: 'PAGE_SNAPSHOT'; url: string; snapshotKey: string; tree: unknown };
