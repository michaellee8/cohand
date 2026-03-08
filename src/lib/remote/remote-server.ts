import { validateToken } from './remote-auth';
import { executeRemoteCommand, releaseTab, type RemoteCommand, type RemoteResult } from './remote-relay';
import { CDPManager } from '../cdp';
import { getDomainPermissions } from '../storage';

interface RemoteSession {
  extensionId: string;
  allowedDomains: string[];
  authenticatedAt: number;
}

const activeSessions = new Map<string, RemoteSession>();

/**
 * Get the number of active sessions. Used for testing.
 */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}

/**
 * Clear all active sessions. Used for testing.
 */
export function clearActiveSessions(): void {
  activeSessions.clear();
}

/**
 * Handle external extension messages for Remote mode.
 * Register with chrome.runtime.onMessageExternal.
 */
export function createRemoteHandler(
  cdp: CDPManager,
  getTabUrl: (tabId: number) => Promise<string>,
) {
  return async (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ) => {
    const extensionId = sender.id;
    if (!extensionId) {
      sendResponse({ error: 'No extension ID' });
      return true;
    }

    // Auth handshake
    if (message.type === 'remote:auth') {
      const valid = await validateToken(message.token);
      if (!valid) {
        sendResponse({ ok: false, error: 'Invalid token' });
        return true;
      }
      // Intersect client-requested domains with user's configured permissions
      const configuredPermissions = await getDomainPermissions();
      const configuredDomains = new Set(configuredPermissions.map(p => p.domain));
      const requestedDomains: string[] = message.allowedDomains || [];
      const allowedDomains = configuredDomains.size > 0
        ? requestedDomains.filter(d => configuredDomains.has(d))
        : []; // No configured permissions = no domains allowed

      activeSessions.set(extensionId, {
        extensionId,
        allowedDomains,
        authenticatedAt: Date.now(),
      });
      sendResponse({ ok: true });
      return true;
    }

    // All other messages require auth
    const session = activeSessions.get(extensionId);
    if (!session) {
      sendResponse({ ok: false, error: 'Not authenticated' });
      return true;
    }

    // CDP command
    if (message.type === 'remote:command') {
      const command: RemoteCommand = {
        id: message.id,
        method: message.method,
        params: message.params,
        tabId: message.tabId,
      };
      const result = await executeRemoteCommand(cdp, command, session.allowedDomains, getTabUrl);
      sendResponse(result);
      return true;
    }

    // Release tab
    if (message.type === 'remote:release') {
      releaseTab(message.tabId);
      sendResponse({ ok: true });
      return true;
    }

    // Disconnect
    if (message.type === 'remote:disconnect') {
      activeSessions.delete(extensionId);
      sendResponse({ ok: true });
      return true;
    }

    sendResponse({ error: 'Unknown remote message type' });
    return true;
  };
}
