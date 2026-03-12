import { validateToken } from './remote-auth';
import { executeRemoteCommand, releaseTab, releaseTabsForSession, type RemoteCommand, type RemoteResult } from './remote-relay';
import { CDPManager } from '../cdp';
import { getDomainPermissions } from '../storage';

interface RemoteSession {
  extensionId: string;
  allowedDomains: string[];
  authenticatedAt: number;
}

/** Session idle timeout: 30 minutes */
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

/** Rate limiting: max 5 failed auth attempts per minute */
const AUTH_RATE_LIMIT_MAX = 5;
const AUTH_RATE_LIMIT_WINDOW_MS = 60 * 1000;

interface AuthAttemptRecord {
  timestamps: number[];
}

const authAttempts = new Map<string, AuthAttemptRecord>();

const activeSessions = new Map<string, RemoteSession>();

/**
 * Get the number of active sessions. Used for testing.
 */
export function getActiveSessionCount(): number {
  return activeSessions.size;
}

/**
 * Clear all active sessions. Used for testing and token regeneration.
 */
export function clearActiveSessions(): void {
  activeSessions.clear();
}

/**
 * Reset auth rate limit state. Used for testing.
 */
export function resetAuthRateLimits(): void {
  authAttempts.clear();
}

/**
 * Check if an extension is rate limited for auth attempts.
 */
function isAuthRateLimited(extensionId: string): boolean {
  const record = authAttempts.get(extensionId);
  if (!record) return false;
  const now = Date.now();
  // Filter to only recent attempts within the window
  record.timestamps = record.timestamps.filter(t => now - t < AUTH_RATE_LIMIT_WINDOW_MS);
  return record.timestamps.length >= AUTH_RATE_LIMIT_MAX;
}

/**
 * Record a failed auth attempt for rate limiting.
 */
function recordFailedAuth(extensionId: string): void {
  const record = authAttempts.get(extensionId);
  const now = Date.now();
  if (record) {
    record.timestamps = record.timestamps.filter(t => now - t < AUTH_RATE_LIMIT_WINDOW_MS);
    record.timestamps.push(now);
  } else {
    authAttempts.set(extensionId, { timestamps: [now] });
  }
}

/**
 * Handle external extension messages for Remote mode.
 * Register with chrome.runtime.onMessageExternal.
 */
export function createRemoteHandler(
  cdp: CDPManager,
  getTabUrl: (tabId: number) => Promise<string>,
) {
  return (
    message: any,
    sender: chrome.runtime.MessageSender,
    sendResponse: (response: any) => void,
  ) => {
    const extensionId = sender.id;
    if (!extensionId) {
      sendResponse({ error: 'No extension ID' });
      return true;
    }

    (async () => {
      // Auth handshake
      if (message.type === 'remote:auth') {
        // Rate limiting check
        if (isAuthRateLimited(extensionId)) {
          return { ok: false, error: 'Rate limited' };
        }

        const valid = await validateToken(message.token);
        if (!valid) {
          recordFailedAuth(extensionId);
          return { ok: false, error: 'Invalid token' };
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
        return { ok: true };
      }

      // All other messages require auth
      const session = activeSessions.get(extensionId);
      if (!session) {
        return { ok: false, error: 'Not authenticated' };
      }

      // Session idle timeout check
      if (Date.now() - session.authenticatedAt > SESSION_IDLE_TIMEOUT_MS) {
        activeSessions.delete(extensionId);
        releaseTabsForSession(extensionId);
        return { ok: false, error: 'Session expired' };
      }

      // CDP command
      if (message.type === 'remote:command') {
        const command: RemoteCommand = {
          id: message.id,
          method: message.method,
          params: message.params,
          tabId: message.tabId,
        };
        const result = await executeRemoteCommand(cdp, command, session.allowedDomains, getTabUrl, extensionId);
        // Update authenticatedAt on successful command (idle timeout, not absolute)
        if (result.ok) {
          session.authenticatedAt = Date.now();
        }
        return result;
      }

      // Release tab — pass extensionId so only the owning session can release
      if (message.type === 'remote:release') {
        releaseTab(message.tabId, extensionId);
        return { ok: true };
      }

      // Disconnect — release all tabs for this session before deleting
      if (message.type === 'remote:disconnect') {
        releaseTabsForSession(extensionId);
        activeSessions.delete(extensionId);
        return { ok: true };
      }

      return { error: 'Unknown remote message type' };
    })()
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ error: err instanceof Error ? err.message : String(err) }));

    return true; // Keep message channel open for async response
  };
}
