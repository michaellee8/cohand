// Shared sensitive-input detection used by both the a11y tree and the
// recording subsystem to prevent password / PII values from leaking.

const SENSITIVE_AUTOCOMPLETE = new Set([
  'cc-number', 'cc-csc', 'cc-exp',
  'new-password', 'current-password', 'one-time-code',
]);

const SENSITIVE_TYPES = new Set(['password', 'email', 'tel', 'hidden']);

const SENSITIVE_NAME_PATTERN =
  /password|passwd|pin|cvv|cvc|ssn|otp|mfa|totp|secret|token|email|phone|tel|mobile|address/i;

export function isSensitiveInput(el: Element): boolean {
  if (el instanceof HTMLInputElement && SENSITIVE_TYPES.has(el.type)) return true;

  const autocomplete = el.getAttribute('autocomplete') || '';
  for (const token of autocomplete.split(/\s+/)) {
    if (SENSITIVE_AUTOCOMPLETE.has(token)) return true;
  }

  const name = el.getAttribute('name') || '';
  const id = el.id || '';
  return SENSITIVE_NAME_PATTERN.test(name) || SENSITIVE_NAME_PATTERN.test(id);
}
