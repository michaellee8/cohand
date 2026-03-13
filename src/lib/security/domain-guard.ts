/**
 * Domain restriction guard for the Cohand Chrome extension.
 *
 * Layer 6 of the security pipeline: every CDP command goes through
 * domain validation before reaching chrome.debugger.sendCommand().
 */

import { NAVIGATOR_PERMISSION_EXPIRY_DAYS } from '../../constants';
import type { DomainPermission } from '../../types';

/**
 * Check if a domain permission has expired.
 * A permission expires after NAVIGATOR_PERMISSION_EXPIRY_DAYS (30 days) from grantedAt.
 */
export function isPermissionExpired(permission: DomainPermission): boolean {
  const grantedAt = new Date(permission.grantedAt).getTime();
  if (isNaN(grantedAt)) return true; // Invalid date = treat as expired
  const expiryMs = NAVIGATOR_PERMISSION_EXPIRY_DAYS * 24 * 60 * 60 * 1000;
  return Date.now() > grantedAt + expiryMs;
}

/**
 * Filter a list of domain permissions, returning only those that have not expired.
 */
export function getValidDomainPermissions(permissions: DomainPermission[]): DomainPermission[] {
  return permissions.filter(p => !isPermissionExpired(p));
}

/**
 * Check if a URL's hostname matches the allowed domains list.
 * Supports exact match and subdomain matching.
 *
 * Examples:
 *   isDomainAllowed('https://www.amazon.com/dp/123', ['amazon.com']) => true
 *   isDomainAllowed('https://evil.com', ['amazon.com']) => false
 *   isDomainAllowed('https://sub.amazon.com', ['amazon.com']) => true
 *   isDomainAllowed('https://notamazon.com', ['amazon.com']) => false
 */
export function isDomainAllowed(url: string, allowedDomains: string[]): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false; // Invalid URL = not allowed
  }

  return allowedDomains.some(domain => {
    // Normalize: remove leading dot if present
    const d = domain.startsWith('.') ? domain.slice(1) : domain;
    return hostname === d || hostname.endsWith('.' + d);
  });
}

/**
 * Extract the domain from a URL.
 */
export function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Check if a URL is on the sensitive-page blocklist.
 * These are pages within allowed domains that should still be blocked
 * (settings pages, security pages, etc.)
 */
const SENSITIVE_PATH_PATTERNS = [
  /\/settings\b/i,
  /\/account\b/i,
  /\/security\b/i,
  /\/password\b/i,
  /\/privacy\b/i,
  /\/billing\b/i,
  /\/payment\b/i,
  /\/admin\b/i,
  /\/oauth\b/i,
  /\/auth\b/i,
  /\/login\b/i,
  /\/signin\b/i,
  /\/signup\b/i,
  /\/register\b/i,
  /\/2fa\b/i,
  /\/mfa\b/i,
];

export function isSensitivePage(url: string): boolean {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.toLowerCase();
    return SENSITIVE_PATH_PATTERNS.some(pattern => pattern.test(path));
  } catch {
    return true; // Invalid URL = treat as sensitive
  }
}
