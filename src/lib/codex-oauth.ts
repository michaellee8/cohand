import {
  CODEX_CLIENT_ID,
  CODEX_REDIRECT_URI,
  CODEX_AUTH_URL,
  CODEX_TOKEN_URL,
  OAUTH_RULE_ID,
  OAUTH_RULE_CHECK_INTERVAL_MS,
  OAUTH_RULE_MAX_LIFETIME_MS,
} from '../constants';
import { extractAccountId, type OAuthCredentials } from './pi-ai-bridge';

// ---------------------------------------------------------------------------
// PKCE helpers
// ---------------------------------------------------------------------------

/**
 * Base64url-encode a Uint8Array (RFC 7636 Appendix A).
 */
function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Generate a PKCE verifier + challenge pair.
 *
 * - 32 random bytes → base64url verifier (43 chars)
 * - SHA-256(verifier) → base64url challenge
 */
export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64url(randomBytes);

  const encoded = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', encoded);
  const challenge = base64url(new Uint8Array(digest));

  return { verifier, challenge };
}

// ---------------------------------------------------------------------------
// Auth URL
// ---------------------------------------------------------------------------

/**
 * Build the OpenAI OAuth authorize URL with all required PKCE params.
 */
export function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
  });

  return `${CODEX_AUTH_URL}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

/**
 * Exchange an authorization code for tokens using the PKCE verifier.
 */
export async function exchangeCodeForToken(
  code: string,
  verifier: string,
): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: CODEX_CLIENT_ID,
    code,
    code_verifier: verifier,
    redirect_uri: CODEX_REDIRECT_URI,
  });

  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const access: string = data.access_token;
  const refresh: string = data.refresh_token;
  const expiresIn: number = data.expires_in;

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    accountId: extractAccountId(access) ?? '',
  };
}

// ---------------------------------------------------------------------------
// declarativeNetRequest redirect rule
// ---------------------------------------------------------------------------

/** Handle for the adaptive monitor interval so we can clear it. */
let monitorIntervalId: ReturnType<typeof setInterval> | null = null;

/**
 * Add a declarativeNetRequest dynamic rule that redirects the localhost OAuth
 * callback to the extension's oauth-callback.html page.  This intercepts the
 * redirect at the network level so the user never sees a connection error.
 */
export async function addOAuthRedirectRule(extensionId: string): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_RULE_ID],
    addRules: [
      {
        id: OAUTH_RULE_ID,
        priority: 1,
        action: {
          type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
          redirect: {
            regexSubstitution: `chrome-extension://${extensionId}/oauth-callback.html\\1`,
          },
        },
        condition: {
          regexFilter: `http://localhost:1455/auth/callback(\\\\?.*)?$`,
          resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
        },
      },
    ],
  });
}

/**
 * Remove the OAuth redirect rule and clear the adaptive monitor interval.
 */
export async function removeOAuthRedirectRule(): Promise<void> {
  if (monitorIntervalId !== null) {
    clearInterval(monitorIntervalId);
    monitorIntervalId = null;
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_RULE_ID],
  });
}

// ---------------------------------------------------------------------------
// Adaptive monitor
// ---------------------------------------------------------------------------

/**
 * Periodically check whether the OAuth redirect rule should still be active.
 *
 * Removes the rule when:
 * - The maximum lifetime has elapsed
 * - The auth tab has navigated away from auth.openai.com
 * - The auth tab has been closed
 */
export function startAdaptiveMonitor(authTabId: number): void {
  const startTime = Date.now();

  // Clear any existing monitor
  if (monitorIntervalId !== null) {
    clearInterval(monitorIntervalId);
  }

  monitorIntervalId = setInterval(async () => {
    // Lifetime exceeded
    if (Date.now() - startTime > OAUTH_RULE_MAX_LIFETIME_MS) {
      await removeOAuthRedirectRule();
      return;
    }

    try {
      const tab = await chrome.tabs.get(authTabId);

      // Tab navigated away from the auth domain
      if (tab.url && !tab.url.includes('auth.openai.com')) {
        await removeOAuthRedirectRule();
        return;
      }
    } catch {
      // Tab no longer exists (closed)
      await removeOAuthRedirectRule();
    }
  }, OAUTH_RULE_CHECK_INTERVAL_MS);
}

// ---------------------------------------------------------------------------
// Stale state cleanup
// ---------------------------------------------------------------------------

const PKCE_STATE_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Clean up stale OAuth state on extension startup / wake.
 *
 * - Removes any lingering declarativeNetRequest redirect rules
 * - Removes PKCE state from chrome.storage.local if older than 10 minutes
 */
export async function cleanupStaleOAuthState(): Promise<void> {
  // Remove any stale redirect rules
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_RULE_ID],
  });

  // Clean PKCE state from storage if it's older than 10 minutes
  const result = await chrome.storage.local.get(['pkceState', 'pkceTimestamp']);
  if (result.pkceTimestamp) {
    const age = Date.now() - result.pkceTimestamp;
    if (age > PKCE_STATE_MAX_AGE_MS) {
      await chrome.storage.local.remove(['pkceState', 'pkceTimestamp', 'pkceVerifier']);
    }
  }
}
