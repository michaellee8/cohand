import { CDPManager } from '../cdp';
import { isDomainAllowed } from '../security/domain-guard';

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
 * Tab mutex: tracks which tabs are under which control mode.
 * A tab is either under local script control (Modes 1/2) OR remote control (Mode 3).
 */
const tabOwnership = new Map<number, 'local' | 'remote'>();

export function claimTab(tabId: number, mode: 'local' | 'remote'): boolean {
  const current = tabOwnership.get(tabId);
  if (current && current !== mode) return false;
  tabOwnership.set(tabId, mode);
  return true;
}

export function releaseTab(tabId: number): void {
  tabOwnership.delete(tabId);
}

export function getTabOwner(tabId: number): 'local' | 'remote' | null {
  return tabOwnership.get(tabId) ?? null;
}

/**
 * Reset all tab ownership state. Used for testing.
 */
export function resetTabOwnership(): void {
  tabOwnership.clear();
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
  // Input (mouse/touch allowed, keyboard blocked separately)
  'Input.dispatchMouseEvent',
  'Input.dispatchTouchEvent',
  // Page info
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
]);

/**
 * Execute a remote CDP command with domain validation.
 */
export async function executeRemoteCommand(
  cdp: CDPManager,
  command: RemoteCommand,
  allowedDomains: string[],
  getTabUrl: (tabId: number) => Promise<string>,
): Promise<RemoteResult> {
  try {
    // Check tab ownership
    const owner = getTabOwner(command.tabId);
    if (owner === 'local') {
      return {
        id: command.id,
        ok: false,
        error: 'Tab is under local script control',
      };
    }

    // Claim for remote if not already
    if (!claimTab(command.tabId, 'remote')) {
      return {
        id: command.id,
        ok: false,
        error: 'Failed to claim tab for remote control',
      };
    }

    // Domain validation
    const tabUrl = await getTabUrl(command.tabId);
    if (!isDomainAllowed(tabUrl, allowedDomains)) {
      return {
        id: command.id,
        ok: false,
        error: `Domain not allowed: ${tabUrl}`,
      };
    }

    // CDP method whitelist — only allow safe methods, reject everything else
    if (!ALLOWED_CDP_METHODS.has(command.method) &&
        !command.method.startsWith('Input.dispatchMouseEvent') &&
        !command.method.startsWith('Input.dispatchTouchEvent')) {
      return {
        id: command.id,
        ok: false,
        error: `CDP method not allowed: ${command.method}`,
      };
    }

    // Input lock: block text input and form submission unless explicitly unlocked
    const blockedInputMethods = [
      'Input.dispatchKeyEvent',
      'Input.insertText',
      'Input.imeSetComposition',
    ];
    if (blockedInputMethods.includes(command.method)) {
      return {
        id: command.id,
        ok: false,
        error: 'Text input blocked in remote mode. Use unlock-input command first.',
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
    return { id: command.id, ok: false, error: err.message };
  }
}
