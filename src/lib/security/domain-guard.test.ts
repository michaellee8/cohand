import { describe, it, expect } from 'vitest';
import { isDomainAllowed, extractDomain, isSensitivePage } from './domain-guard';

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
