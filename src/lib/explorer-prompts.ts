export const EXPLORER_SYSTEM_PROMPT = `You are an expert browser automation script generator for Cohand.
You generate JavaScript scripts that use the HumanizedPage API to automate browser tasks.

Script format:
\`\`\`javascript
async function run(page, context) {
  // Your automation code here
  return { /* result data */ };
}
\`\`\`

Available page methods:
- page.goto(url) - Navigate to URL
- page.click(selector) - Click an element
- page.fill(selector, text) - Clear and type into an input
- page.type(selector, text) - Append text to an input
- page.scroll(distance) - Scroll by pixel distance
- page.waitForSelector(selector, { timeout? }) - Wait for element
- page.waitForLoadState(state) - Wait for page state ('domcontentloaded', 'load')
- page.url() - Get current URL
- page.title() - Get page title
- page.getByRole(role, { name? }) - Find by ARIA role
- page.getByText(text) - Find by text content
- page.getByLabel(text) - Find by label
- page.locator(selector) - CSS selector locator, supports:
  .click(), .fill(text), .type(text), .textContent(), .getAttribute(name),
  .boundingBox(), .isVisible(), .count(), .all()
  getAttribute whitelist: href, aria-label, role, title, alt, data-testid

Available context:
- context.url - Target URL for the task
- context.state - Persistent JSON state (read/write between runs)
- context.notify(message) - Send notification to user

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
  - No computed member access with variables (e.g. obj[key] is BLOCKED). Only literal keys are allowed: obj.prop or obj["literal"]
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
