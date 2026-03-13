import { CDPManager } from '../cdp';
import { isDomainAllowed, isSensitivePage } from '../security/domain-guard';

export interface RemoteCommand {
  id: number;
  method: string; // CDP method
  params?: Record<string, unknown>;
  tabId: number;
}

export interface RemoteResult {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/**
 * Tab ownership record. Tracks which mode controls a tab and, for remote mode,
 * which session (identified by extension ID) owns it.
 */
export interface TabOwnershipRecord {
  owner: 'local' | 'remote';
  sessionId?: string;
  taskId?: string;
}

/**
 * Tab mutex: tracks which tabs are under which control mode.
 * A tab is either under local script control (Modes 1/2) OR remote control (Mode 3).
 */
const tabOwnership = new Map<number, TabOwnershipRecord>();

export function claimTab(tabId: number, mode: 'local' | 'remote', sessionId?: string, taskId?: string): boolean {
  const current = tabOwnership.get(tabId);
  if (current && current.owner !== mode) return false;
  // For remote mode, if already claimed by a different session, reject
  if (current && mode === 'remote' && current.sessionId && sessionId && current.sessionId !== sessionId) {
    return false;
  }
  const record: TabOwnershipRecord = { owner: mode, sessionId };
  if (mode === 'local' && taskId) {
    record.taskId = taskId;
  }
  tabOwnership.set(tabId, record);
  return true;
}

export function releaseTab(tabId: number, sessionId?: string): void {
  const current = tabOwnership.get(tabId);
  if (!current) return;
  // If a sessionId is provided, only release if it matches the owning session
  if (sessionId && current.sessionId && current.sessionId !== sessionId) {
    return; // Mismatched session — do not release
  }
  tabOwnership.delete(tabId);
}

export function getTabOwner(tabId: number): TabOwnershipRecord | null {
  return tabOwnership.get(tabId) ?? null;
}

/**
 * Release all tabs owned by a specific session.
 * Called when a remote session disconnects.
 */
export function releaseTabsForSession(sessionId: string): void {
  for (const [tabId, record] of tabOwnership) {
    if (record.sessionId === sessionId) {
      tabOwnership.delete(tabId);
    }
  }
}

/**
 * Reset all tab ownership state. Used for testing.
 */
export function resetTabOwnership(): void {
  tabOwnership.clear();
}

/**
 * Sensitive URL scheme check for remote relay.
 * Blocks CDP operations on browser-internal and local file URLs.
 */
const SENSITIVE_SCHEMES = ['chrome:', 'chrome-extension:', 'about:', 'file:', 'devtools:', 'javascript:', 'data:'];

export function isSensitiveScheme(url: string): boolean {
  try {
    const parsed = new URL(url);
    return SENSITIVE_SCHEMES.includes(parsed.protocol);
  } catch {
    // URLs like about:blank may not parse with URL constructor;
    // check prefix directly as a fallback
    const lower = url.toLowerCase();
    return SENSITIVE_SCHEMES.some(scheme => lower.startsWith(scheme));
  }
}

/**
 * Whitelist of allowed CDP methods for remote mode.
 * Only safe observation and interaction methods are permitted.
 * Runtime.evaluate and similar dangerous methods are excluded.
 */
const ALLOWED_CDP_METHODS = new Set([
  // Navigation
  'Page.navigate',
  'Page.reload',
  'Page.getFrameTree',
  // DOM inspection
  'DOM.getDocument',
  'DOM.querySelector',
  'DOM.querySelectorAll',
  'DOM.getOuterHTML',
  'DOM.getAttributes',
  'DOM.getContentQuads',
  'DOM.scrollIntoViewIfNeeded',
  'DOM.describeNode',
  'DOM.resolveNode',
  'DOM.getBoxModel',
  // Accessibility
  'Accessibility.queryAXTree',
  'Accessibility.getFullAXTree',
  // Input — mouse/touch only; keyboard methods (Input.dispatchKeyEvent,
  // Input.insertText, Input.imeSetComposition) are intentionally excluded
  // to prevent remote text injection.
  'Input.dispatchMouseEvent',
  'Input.dispatchTouchEvent',
  // Page info
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
]);

/**
 * Execute a remote CDP command with domain validation and sensitive page blocking.
 */
export async function executeRemoteCommand(
  cdp: CDPManager,
  command: RemoteCommand,
  allowedDomains: string[],
  getTabUrl: (tabId: number) => Promise<string>,
  sessionId?: string,
): Promise<RemoteResult> {
  try {
    // Check tab ownership
    const owner = getTabOwner(command.tabId);
    if (owner && owner.owner === 'local') {
      return {
        id: command.id,
        ok: false,
        error: 'Tab is under local script control',
      };
    }

    // Domain validation (before claiming tab)
    const tabUrl = await getTabUrl(command.tabId);

    // Sensitive scheme check — block CDP on browser-internal and local file pages
    if (isSensitiveScheme(tabUrl)) {
      return {
        id: command.id,
        ok: false,
        error: `Access denied: sensitive page (${tabUrl})`,
      };
    }

    if (!isDomainAllowed(tabUrl, allowedDomains)) {
      return {
        id: command.id,
        ok: false,
        error: `Domain not allowed: ${tabUrl}`,
      };
    }

    // Sensitive page check — block CDP on settings, login, payment pages etc.
    if (isSensitivePage(tabUrl)) {
      return {
        id: command.id,
        ok: false,
        error: `Access denied: sensitive page path`,
      };
    }

    // CDP method whitelist — only allow safe methods, reject everything else
    if (!ALLOWED_CDP_METHODS.has(command.method)) {
      return {
        id: command.id,
        ok: false,
        error: `CDP method not allowed: ${command.method}`,
      };
    }

    // Block Page.navigate to sensitive or disallowed URLs
    if (command.method === 'Page.navigate' && command.params?.url) {
      const targetUrl = String(command.params.url);
      if (isSensitiveScheme(targetUrl)) {
        return {
          id: command.id,
          ok: false,
          error: `Navigation to sensitive URL blocked: ${targetUrl}`,
        };
      }
      if (!isDomainAllowed(targetUrl, allowedDomains)) {
        return {
          id: command.id,
          ok: false,
          error: `Navigation to disallowed domain blocked`,
        };
      }
    }

    // Claim for remote AFTER all validation checks pass
    if (!claimTab(command.tabId, 'remote', sessionId)) {
      return {
        id: command.id,
        ok: false,
        error: 'Failed to claim tab for remote control',
      };
    }

    // Ensure debugger attached
    if (!cdp.isAttached(command.tabId)) {
      await cdp.attach(command.tabId);
    }

    // Execute CDP command
    const result = await cdp.send(command.tabId, command.method, command.params);

    return { id: command.id, ok: true, result };
  } catch (err: any) {
    // Release tab if it was claimed but execution failed
    releaseTab(command.tabId, sessionId);
    return { id: command.id, ok: false, error: err.message };
  }
}
