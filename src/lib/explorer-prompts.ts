export const EXPLORER_SYSTEM_PROMPT = `You are an expert browser automation script generator for Cohand.
You generate JavaScript scripts that use the HumanizedPage API to automate browser tasks.

Script format:
\`\`\`javascript
async function run(page, context) {
  // Your automation code here
  return { /* result data */ };
}
\`\`\`

Available API (TypeScript definitions):

interface Page {
  goto(url: string): Promise<void>;
  click(selector: string): Promise<void>;
  fill(selector: string, text: string): Promise<void>;
  type(selector: string, text: string): Promise<void>;
  scroll(distance: number): Promise<void>;
  waitForSelector(selector: string, options?: { timeout?: number }): Promise<void>;
  waitForLoadState(state: 'domcontentloaded' | 'load'): Promise<void>;
  url(): Promise<string>;
  title(): Promise<string>;
  getByRole(role: string, options?: { name?: string }): Locator;
  getByText(text: string): Locator;
  getByLabel(text: string): Locator;
  locator(selector: string): Locator;
}

interface Locator {
  click(): Promise<void>;
  fill(text: string): Promise<void>;
  type(text: string): Promise<void>;
  textContent(): Promise<string | null>;  // max 500 chars per call, 50KB cumulative
  getAttribute(name: 'href' | 'aria-label' | 'role' | 'title' | 'alt' | 'data-testid'): Promise<string | null>;
  boundingBox(): Promise<{ x: number; y: number; width: number; height: number } | null>;
  isVisible(): Promise<boolean>;
  count(): Promise<number>;
  all(): Promise<Locator[]>;
}

interface Context {
  url: string;                            // target URL for the task
  state: Record<string, unknown>;         // persistent JSON state, direct property access
  notify(message: string): Promise<void>; // send notification to user
}

Rules:
1. Use await for all page method calls
2. Use CSS selectors or ARIA selectors (getByRole, getByText, getByLabel)
3. Handle errors gracefully (wrap unreliable operations in try/catch)
4. Store useful data in context.state for persistence between runs
5. Use context.notify() to alert the user about important changes
6. Keep scripts focused and simple
7. Return a result object summarizing what was done

Security constraints (scripts are statically analyzed and will be REJECTED if they violate these):

Blocked globals — do NOT reference these anywhere:
  eval, Function, Proxy, Reflect, fetch, XMLHttpRequest, WebSocket, importScripts, require

Blocked property access — do NOT access these on any object:
  constructor, __proto__, prototype, evaluate, $, $$, content,
  mouse, keyboard, route, exposeFunction, addInitScript,
  getPrototypeOf, getOwnPropertyDescriptor, defineProperty, setPrototypeOf,
  getOwnPropertyNames, getOwnPropertySymbols

Blocked patterns:
  - No dynamic import() expressions
  - No computed member access on globals (e.g. globalThis[key], window[key], self[key], this[key] are BLOCKED)
  - No literal computed access to blocked properties (e.g. obj["constructor"] is BLOCKED)
  - Array indexing (arr[i]) and dynamic property access (obj[key]) are fine on regular objects
  - No \`with\` statements
  - No tagged template expressions (e.g. fn\`...\`)
  - No string concatenation that builds blocked names (e.g. 'con' + 'structor')

Runtime limits:
  - 32 MB memory limit, 5 minute execution timeout
  - textContent() returns max 500 characters per call; cumulative text reads capped at 50 KB per execution
  - context.state must be JSON-serializable and under 1 MB total
  - getAttribute() only works for whitelisted attributes: href, aria-label, role, title, alt, data-testid

Domain constraints:
  - Scripts can only navigate to domains listed in the task's allowed domains
  - Sensitive paths are automatically blocked: /settings, /account, /security, /password, /login, /signin, /signup, /register, /admin, /oauth, /auth, /billing, /payment, /2fa, /mfa`;

export const SCRIPT_GENERATION_PROMPT = `Based on the following page observation and user request, generate an automation script.

## User Request
{description}

## Target URL
{url}

## Allowed Domains
{domains}

## Current Page Accessibility Tree
{a11yTree}

## Page Screenshot
[Attached as image]

Generate ONLY the JavaScript script (async function run(page, context) { ... }).
No markdown, no explanation, just the script code.`;

export const REPAIR_PROMPT = `The following automation script is failing. Generate a repaired version.

## Original Script
\`\`\`javascript
{source}
\`\`\`

## Error
{error}

## Current Page Accessibility Tree
{a11yTree}

## Expected Output Schema
{schema}

## Last Successful Output
{lastOutput}

Generate ONLY the repaired JavaScript script.
Keep changes minimal — fix the specific failure without rewriting unrelated parts.`;

export function buildGenerationMessages(params: {
  description: string;
  url: string;
  domains: string[];
  a11yTree: string;
  screenshot?: string;
}): Array<{ role: 'system' | 'user'; content: string | Array<{ type: string; [key: string]: any }> }> {
  const userContent = SCRIPT_GENERATION_PROMPT
    .replace('{description}', params.description)
    .replace('{url}', params.url)
    .replace('{domains}', params.domains.join(', '))
    .replace('{a11yTree}', params.a11yTree);

  const messages: Array<{ role: 'system' | 'user'; content: string | Array<{ type: string; [key: string]: any }> }> = [
    { role: 'system', content: EXPLORER_SYSTEM_PROMPT },
  ];

  if (params.screenshot) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent },
        { type: 'image_url', image_url: { url: params.screenshot } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  return messages;
}

export function buildRepairMessages(params: {
  source: string;
  error: string;
  a11yTree: string;
  schema?: string;
  lastOutput?: string;
  recordingSteps?: unknown[];
  recordingSnapshots?: unknown[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  let userContent = REPAIR_PROMPT
    .replace('{source}', params.source)
    .replace('{error}', params.error)
    .replace('{a11yTree}', params.a11yTree)
    .replace('{schema}', params.schema || 'Not specified')
    .replace('{lastOutput}', params.lastOutput || 'None');

  if (params.recordingSteps?.length) {
    userContent += `\n\n## Original Recording Steps\n${JSON.stringify(params.recordingSteps, null, 2)}`;
  }
  if (params.recordingSnapshots?.length) {
    userContent += `\n\n## Page Snapshots from Recording\n${JSON.stringify(params.recordingSnapshots, null, 2)}`;
  }

  return [
    { role: 'system', content: EXPLORER_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];
}
