import { MAX_STATE_SIZE } from '../../constants';

export interface ScanResult {
  safe: boolean;
  filtered: string | null; // filtered content if unsafe, null if safe
  flags: string[]; // what was detected
}

// Patterns that indicate potential prompt injection or sensitive data
const INJECTION_PATTERNS = [
  // Common prompt injection markers
  /ignore\s+(previous|above|all)\s+(instructions?|prompts?)/i,
  /system\s*prompt/i,
  /you\s+are\s+(now|a)\s+/i,
  /\bact\s+as\b/i,
  /\bdisregard\b.*\binstructions?\b/i,
  /\bjailbreak\b/i,
  /\bDAN\b/, // "Do Anything Now"
];

// PII/sensitive data patterns
const SENSITIVE_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  {
    name: 'email',
    pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    name: 'phone',
    pattern:
      /(?:\+?1[-.]?)?\(?[0-9]{3}\)?[-.\s]?[0-9]{3}[-.\s]?[0-9]{4}/g,
  },
  {
    name: 'credit_card',
    pattern: /\b(?:\d{4}[-\s]?){3}\d{4}\b/g,
  },
  { name: 'ssn', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
  {
    name: 'api_key',
    pattern: /(?:sk|pk|api[_-]?key)[-_][a-zA-Z0-9]{20,}/gi,
  },
  {
    name: 'jwt',
    pattern:
      /eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g,
  },
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  },
];

const FILTERED_PLACEHOLDER =
  '<filtered_for_possible_prompt_security_issues/>';

/**
 * Scan a string value for injection patterns and sensitive data.
 */
export function scanString(value: string): ScanResult {
  const flags: string[] = [];

  // Check for injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(value)) {
      flags.push('prompt_injection');
      return { safe: false, filtered: FILTERED_PLACEHOLDER, flags };
    }
  }

  // Check for sensitive data (flag but don't block)
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(value)) {
      flags.push(`sensitive:${name}`);
    }
    // Reset regex lastIndex
    pattern.lastIndex = 0;
  }

  return { safe: true, filtered: null, flags };
}

/**
 * Scan a script's return value before display.
 * Fail-closed: any error during scanning = content blocked.
 */
export function scanReturnValue(value: unknown): ScanResult {
  try {
    if (value === null || value === undefined) {
      return { safe: true, filtered: null, flags: [] };
    }

    const serialized = JSON.stringify(value);
    return scanString(serialized);
  } catch {
    // Fail-closed
    return {
      safe: false,
      filtered: FILTERED_PLACEHOLDER,
      flags: ['scan_error'],
    };
  }
}

/**
 * Scan state changes before persistence.
 * Checks both keys and values.
 */
export function scanState(state: Record<string, unknown>): ScanResult {
  try {
    const serialized = JSON.stringify(state);

    // Check size limit
    if (serialized.length > MAX_STATE_SIZE) {
      return { safe: false, filtered: null, flags: ['state_too_large'] };
    }

    return scanString(serialized);
  } catch {
    return {
      safe: false,
      filtered: FILTERED_PLACEHOLDER,
      flags: ['scan_error'],
    };
  }
}

/**
 * Scan a notification message before delivery.
 */
export function scanNotification(message: string): ScanResult {
  try {
    return scanString(message);
  } catch {
    return {
      safe: false,
      filtered: FILTERED_PLACEHOLDER,
      flags: ['scan_error'],
    };
  }
}

/**
 * Classify content flags for reporting.
 * Returns human-readable descriptions.
 */
export function classifyFlags(flags: string[]): string[] {
  return flags.map((flag) => {
    if (flag === 'prompt_injection')
      return 'Possible prompt injection detected';
    if (flag === 'state_too_large')
      return `State exceeds ${MAX_STATE_SIZE} byte limit`;
    if (flag === 'scan_error')
      return 'Scanner error (content blocked as precaution)';
    if (flag.startsWith('sensitive:')) {
      const type = flag.replace('sensitive:', '');
      return `Contains ${type.replace('_', ' ')} pattern`;
    }
    return flag;
  });
}
