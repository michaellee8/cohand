import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isDomainAllowed, extractDomain, isSensitivePage, isPermissionExpired, getValidDomainPermissions } from './domain-guard';
import type { DomainPermission } from '../../types';

describe('isDomainAllowed', () => {
  it('allows exact domain match', () => {
    expect(isDomainAllowed('https://amazon.com/dp/123', ['amazon.com'])).toBe(true);
  });

  it('allows subdomain match', () => {
    expect(isDomainAllowed('https://www.amazon.com/dp/123', ['amazon.com'])).toBe(true);
  });

  it('allows deep subdomain', () => {
    expect(isDomainAllowed('https://a.b.c.amazon.com/', ['amazon.com'])).toBe(true);
  });

  it('rejects different domain', () => {
    expect(isDomainAllowed('https://evil.com', ['amazon.com'])).toBe(false);
  });

  it('rejects suffix-match attacks (notamazon.com)', () => {
    expect(isDomainAllowed('https://notamazon.com', ['amazon.com'])).toBe(false);
  });

  it('allows multiple domains', () => {
    const allowed = ['amazon.com', 'ebay.com'];
    expect(isDomainAllowed('https://www.amazon.com', allowed)).toBe(true);
    expect(isDomainAllowed('https://www.ebay.com', allowed)).toBe(true);
    expect(isDomainAllowed('https://google.com', allowed)).toBe(false);
  });

  it('handles leading dot in domain', () => {
    expect(isDomainAllowed('https://www.example.com', ['.example.com'])).toBe(true);
  });

  it('returns false for invalid URL', () => {
    expect(isDomainAllowed('not-a-url', ['example.com'])).toBe(false);
  });

  it('returns false for empty allowed list', () => {
    expect(isDomainAllowed('https://example.com', [])).toBe(false);
  });

  it('handles URLs with ports', () => {
    expect(isDomainAllowed('https://example.com:8080/path', ['example.com'])).toBe(true);
  });
});

describe('extractDomain', () => {
  it('extracts hostname from URL', () => {
    expect(extractDomain('https://www.example.com/path')).toBe('www.example.com');
  });

  it('returns null for invalid URL', () => {
    expect(extractDomain('not-a-url')).toBeNull();
  });
});

describe('isSensitivePage', () => {
  it('detects settings pages', () => {
    expect(isSensitivePage('https://example.com/settings')).toBe(true);
    expect(isSensitivePage('https://example.com/settings/profile')).toBe(true);
  });

  it('detects auth pages', () => {
    expect(isSensitivePage('https://example.com/login')).toBe(true);
    expect(isSensitivePage('https://example.com/oauth/callback')).toBe(true);
  });

  it('detects payment pages', () => {
    expect(isSensitivePage('https://example.com/billing')).toBe(true);
    expect(isSensitivePage('https://example.com/payment')).toBe(true);
  });

  it('allows normal pages', () => {
    expect(isSensitivePage('https://example.com/products')).toBe(false);
    expect(isSensitivePage('https://example.com/search?q=test')).toBe(false);
  });

  it('treats invalid URL as sensitive', () => {
    expect(isSensitivePage('not-a-url')).toBe(true);
  });
});

describe('isPermissionExpired', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns false for a permission granted just now', () => {
    const permission: DomainPermission = {
      domain: 'example.com',
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
    };
    expect(isPermissionExpired(permission)).toBe(false);
  });

  it('returns false for a permission granted 29 days ago', () => {
    const twentyNineDaysAgo = new Date(Date.now() - 29 * 24 * 60 * 60 * 1000);
    const permission: DomainPermission = {
      domain: 'example.com',
      grantedAt: twentyNineDaysAgo.toISOString(),
      grantedBy: 'user',
    };
    expect(isPermissionExpired(permission)).toBe(false);
  });

  it('returns true for a permission granted 31 days ago', () => {
    const thirtyOneDaysAgo = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    const permission: DomainPermission = {
      domain: 'example.com',
      grantedAt: thirtyOneDaysAgo.toISOString(),
      grantedBy: 'user',
    };
    expect(isPermissionExpired(permission)).toBe(true);
  });

  it('returns true for invalid grantedAt date', () => {
    const permission: DomainPermission = {
      domain: 'example.com',
      grantedAt: 'not-a-date',
      grantedBy: 'user',
    };
    expect(isPermissionExpired(permission)).toBe(true);
  });

  it('returns true for permission granted exactly 30 days and 1 ms ago', () => {
    const justExpired = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000 - 1);
    const permission: DomainPermission = {
      domain: 'example.com',
      grantedAt: justExpired.toISOString(),
      grantedBy: 'task_creation',
    };
    expect(isPermissionExpired(permission)).toBe(true);
  });
});

describe('getValidDomainPermissions', () => {
  it('filters out expired permissions', () => {
    const fresh: DomainPermission = {
      domain: 'fresh.com',
      grantedAt: new Date().toISOString(),
      grantedBy: 'user',
    };
    const expired: DomainPermission = {
      domain: 'expired.com',
      grantedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString(),
      grantedBy: 'user',
    };

    const valid = getValidDomainPermissions([fresh, expired]);
    expect(valid).toHaveLength(1);
    expect(valid[0].domain).toBe('fresh.com');
  });

  it('returns empty array when all are expired', () => {
    const expired1: DomainPermission = {
      domain: 'a.com',
      grantedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
      grantedBy: 'user',
    };
    const expired2: DomainPermission = {
      domain: 'b.com',
      grantedAt: new Date(Date.now() - 45 * 24 * 60 * 60 * 1000).toISOString(),
      grantedBy: 'task_creation',
    };

    const valid = getValidDomainPermissions([expired1, expired2]);
    expect(valid).toHaveLength(0);
  });

  it('returns all when none are expired', () => {
    const permissions: DomainPermission[] = [
      { domain: 'a.com', grantedAt: new Date().toISOString(), grantedBy: 'user' },
      { domain: 'b.com', grantedAt: new Date().toISOString(), grantedBy: 'task_creation' },
    ];

    const valid = getValidDomainPermissions(permissions);
    expect(valid).toHaveLength(2);
  });
});
