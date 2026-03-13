import { describe, it, expect, beforeEach } from 'vitest';
import { isSensitiveInput as _isSensitiveInput } from '../security/sensitive-input';
import { _collectElementMeta } from './element-selector';

// ---------------------------------------------------------------------------
// Provide minimal chrome.runtime stub so the module can load
// ---------------------------------------------------------------------------
beforeEach(() => {
  (globalThis as any).chrome = {
    runtime: { sendMessage: () => {} },
  };
});

// ---------------------------------------------------------------------------
// Helper: create an <input> with the given attributes
// ---------------------------------------------------------------------------
function makeInput(attrs: Record<string, string>): HTMLInputElement {
  const el = document.createElement('input');
  for (const [k, v] of Object.entries(attrs)) {
    el.setAttribute(k, v);
  }
  return el;
}

// ---------------------------------------------------------------------------
// isSensitiveInput – type-based detection
// ---------------------------------------------------------------------------
describe('isSensitiveInput – type-based detection (Finding 10)', () => {
  it('detects type="password" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'password' }))).toBe(true);
  });

  it('detects type="email" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'email' }))).toBe(true);
  });

  it('detects type="tel" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'tel' }))).toBe(true);
  });

  it('detects type="hidden" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'hidden' }))).toBe(true);
  });

  it('does NOT flag type="text" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'text' }))).toBe(false);
  });

  it('does NOT flag type="number" as sensitive', () => {
    expect(_isSensitiveInput(makeInput({ type: 'number' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isSensitiveInput – name / id pattern detection
// ---------------------------------------------------------------------------
describe('isSensitiveInput – SENSITIVE_NAME_PATTERN', () => {
  it.each([
    'email', 'phone', 'tel', 'mobile', 'address',
    'password', 'token', 'secret', 'ssn', 'cvv',
  ])('detects name="%s" as sensitive', (name) => {
    expect(_isSensitiveInput(makeInput({ type: 'text', name }))).toBe(true);
  });

  it('detects id containing sensitive term', () => {
    expect(_isSensitiveInput(makeInput({ type: 'text', id: 'user-email-field' }))).toBe(true);
  });

  it('does NOT flag benign name', () => {
    expect(_isSensitiveInput(makeInput({ type: 'text', name: 'username' }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// collectElementMeta – value stripping
// ---------------------------------------------------------------------------
describe('collectElementMeta – value attribute stripping', () => {
  it('strips value for type="email"', () => {
    const el = makeInput({ type: 'email', value: 'user@example.com' });
    const meta = _collectElementMeta(el);
    expect(meta.elementAttributes?.['value']).toBeUndefined();
  });

  it('strips value for type="tel"', () => {
    const el = makeInput({ type: 'tel', value: '+1234567890' });
    const meta = _collectElementMeta(el);
    expect(meta.elementAttributes?.['value']).toBeUndefined();
  });

  it('strips value for type="hidden"', () => {
    const el = makeInput({ type: 'hidden', value: 'csrf-tok-abc' });
    const meta = _collectElementMeta(el);
    expect(meta.elementAttributes?.['value']).toBeUndefined();
  });

  it('strips value for type="password"', () => {
    const el = makeInput({ type: 'password', value: 's3cret' });
    const meta = _collectElementMeta(el);
    expect(meta.elementAttributes?.['value']).toBeUndefined();
  });

  it('preserves value for type="text" (regression check)', () => {
    const el = makeInput({ type: 'text', value: 'hello' });
    const meta = _collectElementMeta(el);
    expect(meta.elementAttributes?.['value']).toBe('hello');
  });
});
