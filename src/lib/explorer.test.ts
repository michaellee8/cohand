import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock chrome APIs ---
const mockSendMessage = vi.fn();
const mockTabsGet = vi.fn();
const mockCaptureVisibleTab = vi.fn();

vi.stubGlobal('chrome', {
  runtime: { sendMessage: mockSendMessage },
  tabs: { get: mockTabsGet, captureVisibleTab: mockCaptureVisibleTab },
});

// --- Mock pi-ai complete ---
const { mockComplete } = vi.hoisted(() => {
  const mockComplete = vi.fn();
  return { mockComplete };
});

vi.mock('@mariozechner/pi-ai', () => ({
  complete: mockComplete,
}));

import {
  generateScript,
  repairScript,
  cleanScriptSource,
  type ExplorationResult,
} from './explorer';
import {
  buildGenerationMessages,
  buildRepairMessages,
  EXPLORER_SYSTEM_PROMPT,
  SCRIPT_GENERATION_PROMPT,
  REPAIR_PROMPT,
} from './explorer-prompts';

/** Helper to create a mock AssistantMessage with text content */
function mockAssistantMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'openai',
    model: 'test-model',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

const fakeModel = { id: 'test-model', name: 'test-model', api: 'openai-completions', provider: 'openai', baseUrl: '', reasoning: false, input: ['text'] as ('text' | 'image')[], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 };
const fakeApiKey = 'test-api-key';

describe('cleanScriptSource', () => {
  it('strips ```javascript wrapper', () => {
    const input = '```javascript\nasync function run(page) {}\n```';
    expect(cleanScriptSource(input)).toBe('async function run(page) {}');
  });

  it('strips ``` wrapper without language tag', () => {
    const input = '```\nasync function run(page) {}\n```';
    expect(cleanScriptSource(input)).toBe('async function run(page) {}');
  });

  it('handles no wrapper', () => {
    const input = 'async function run(page) {}';
    expect(cleanScriptSource(input)).toBe('async function run(page) {}');
  });

  it('trims whitespace', () => {
    const input = '  \n  async function run(page) {}  \n  ';
    expect(cleanScriptSource(input)).toBe('async function run(page) {}');
  });

  it('strips wrapper with trailing whitespace inside fences', () => {
    const input = '```js\n  const x = 1;\n  return x;\n```';
    expect(cleanScriptSource(input)).toBe('const x = 1;\n  return x;');
  });

  it('handles code fences without closing fence', () => {
    const input = '```javascript\nasync function run(page) {}';
    // No closing ```, so it just strips the opening line
    expect(cleanScriptSource(input)).toBe('async function run(page) {}');
  });
});

describe('generateScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const observation: ExplorationResult = {
    a11yTree: JSON.stringify({ role: 'main', name: 'Test' }),
    url: 'https://example.com',
    title: 'Test Page',
  };

  it('generates a script from description and observation', async () => {
    const validScript = 'async function run(page, context) {\n  await page.goto("https://example.com");\n  return {};\n}';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(validScript));

    const result = await generateScript(fakeModel, fakeApiKey, 'Navigate to example.com', observation, ['example.com']);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    // Verify model and apiKey were passed
    expect(mockComplete.mock.calls[0][0]).toBe(fakeModel);
    expect(mockComplete.mock.calls[0][2]).toEqual(expect.objectContaining({ apiKey: fakeApiKey }));
    expect(result.source).toBe(validScript);
    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('strips markdown code fences from response', async () => {
    const wrappedScript = '```javascript\nasync function run(page) {\n  await page.click("button");\n}\n```';
    const expectedScript = 'async function run(page) {\n  await page.click("button");\n}';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(wrappedScript));

    const result = await generateScript(fakeModel, fakeApiKey, 'Click button', observation, ['example.com']);

    expect(result.source).toBe(expectedScript);
  });

  it('validates AST on generated script', async () => {
    const validScript = 'async function run(page) { await page.goto("https://example.com"); }';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(validScript));

    const result = await generateScript(fakeModel, fakeApiKey, 'Go to page', observation, ['example.com']);

    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('returns AST errors for invalid scripts', async () => {
    const dangerousScript = 'async function run(page) { eval("alert(1)"); }';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(dangerousScript));

    const result = await generateScript(fakeModel, fakeApiKey, 'Do something', observation, ['example.com']);

    expect(result.astValid).toBe(false);
    expect(result.astErrors.length).toBeGreaterThan(0);
    expect(result.astErrors.some(e => e.includes('eval'))).toBe(true);
  });

  it('returns AST errors for syntax errors', async () => {
    const invalidSyntax = 'function {{{ broken';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(invalidSyntax));

    const result = await generateScript(fakeModel, fakeApiKey, 'Do something', observation, ['example.com']);

    expect(result.astValid).toBe(false);
    expect(result.astErrors[0]).toContain('Parse error');
  });

  it('passes context with system prompt and user message to complete()', async () => {
    mockComplete.mockResolvedValueOnce(mockAssistantMessage('async function run(page) { return {}; }'));

    await generateScript(fakeModel, fakeApiKey, 'Describe page', observation, ['example.com']);

    const context = mockComplete.mock.calls[0][1];
    expect(context.systemPrompt).toBe(EXPLORER_SYSTEM_PROMPT);
    expect(context.messages).toHaveLength(1);
    expect(context.messages[0].role).toBe('user');
  });
});

describe('repairScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a repaired script', async () => {
    const repairedScript = 'async function run(page) {\n  await page.click("[data-testid=\\"btn\\"]");\n  return {};\n}';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(repairedScript));

    const result = await repairScript(fakeModel, fakeApiKey, {
      source: 'async function run(page) { await page.click(".old-selector"); }',
      error: 'SelectorNotFound: .old-selector',
      a11yTree: '{"role":"main"}',
    });

    expect(mockComplete).toHaveBeenCalledTimes(1);
    expect(mockComplete.mock.calls[0][0]).toBe(fakeModel);
    expect(mockComplete.mock.calls[0][2]).toEqual(expect.objectContaining({ apiKey: fakeApiKey }));
    expect(result.source).toBe(repairedScript);
    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('validates AST on repaired script', async () => {
    const dangerousRepair = 'async function run(page) { fetch("https://evil.com"); }';
    mockComplete.mockResolvedValueOnce(mockAssistantMessage(dangerousRepair));

    const result = await repairScript(fakeModel, fakeApiKey, {
      source: 'async function run(page) { await page.click("x"); }',
      error: 'SelectorNotFound',
      a11yTree: '{}',
    });

    expect(result.astValid).toBe(false);
    expect(result.astErrors.some(e => e.includes('fetch'))).toBe(true);
  });

  it('passes schema and lastOutput to repair messages', async () => {
    mockComplete.mockResolvedValueOnce(mockAssistantMessage('async function run(page) { return { price: "10" }; }'));

    await repairScript(fakeModel, fakeApiKey, {
      source: 'async function run(page) { return {}; }',
      error: 'Missing price field',
      a11yTree: '{"role":"main"}',
      schema: '{ price: string }',
      lastOutput: '{ price: "5.99" }',
    });

    const context = mockComplete.mock.calls[0][1];
    const userContent = context.messages[0].content;
    expect(userContent).toContain('{ price: string }');
    expect(userContent).toContain('{ price: "5.99" }');
  });

  it('uses defaults when schema and lastOutput are not provided', async () => {
    mockComplete.mockResolvedValueOnce(mockAssistantMessage('async function run(page) { return {}; }'));

    await repairScript(fakeModel, fakeApiKey, {
      source: 'async function run(page) { return {}; }',
      error: 'Some error',
      a11yTree: '{}',
    });

    const context = mockComplete.mock.calls[0][1];
    const userContent = context.messages[0].content;
    expect(userContent).toContain('Not specified');
    expect(userContent).toContain('None');
  });
});

describe('buildGenerationMessages', () => {
  it('includes system prompt and user prompt', () => {
    const messages = buildGenerationMessages({
      description: 'Click the like button',
      url: 'https://example.com',
      domains: ['example.com'],
      a11yTree: '{"role":"main"}',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(EXPLORER_SYSTEM_PROMPT);
    expect(messages[1].role).toBe('user');
    expect(typeof messages[1].content).toBe('string');
    expect(messages[1].content as string).toContain('Click the like button');
    expect(messages[1].content as string).toContain('https://example.com');
    expect(messages[1].content as string).toContain('example.com');
    expect(messages[1].content as string).toContain('{"role":"main"}');
  });

  it('includes screenshot as image_url when provided', () => {
    const messages = buildGenerationMessages({
      description: 'Test',
      url: 'https://example.com',
      domains: ['example.com'],
      a11yTree: '{}',
      screenshot: 'data:image/png;base64,abc',
    });

    expect(messages).toHaveLength(2);
    const userContent = messages[1].content;
    expect(Array.isArray(userContent)).toBe(true);
    const parts = userContent as Array<{ type: string; [key: string]: any }>;
    expect(parts).toHaveLength(2);
    expect(parts[0].type).toBe('text');
    expect(parts[0].text).toContain('Test');
    expect(parts[1].type).toBe('image_url');
    expect(parts[1].image_url.url).toBe('data:image/png;base64,abc');
  });

  it('excludes screenshot when not provided', () => {
    const messages = buildGenerationMessages({
      description: 'Test',
      url: 'https://example.com',
      domains: ['example.com'],
      a11yTree: '{}',
    });

    expect(messages).toHaveLength(2);
    expect(typeof messages[1].content).toBe('string');
  });

  it('joins multiple domains with commas', () => {
    const messages = buildGenerationMessages({
      description: 'Test',
      url: 'https://example.com',
      domains: ['example.com', 'api.example.com', 'cdn.example.com'],
      a11yTree: '{}',
    });

    const content = messages[1].content as string;
    expect(content).toContain('example.com, api.example.com, cdn.example.com');
  });
});

describe('buildRepairMessages', () => {
  it('includes system prompt and repair prompt', () => {
    const messages = buildRepairMessages({
      source: 'async function run(page) {}',
      error: 'SelectorNotFound',
      a11yTree: '{"role":"main"}',
    });

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(EXPLORER_SYSTEM_PROMPT);
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain('async function run(page) {}');
    expect(messages[1].content).toContain('SelectorNotFound');
    expect(messages[1].content).toContain('{"role":"main"}');
  });

  it('includes schema when provided', () => {
    const messages = buildRepairMessages({
      source: 'code',
      error: 'err',
      a11yTree: '{}',
      schema: '{ items: string[] }',
    });

    expect(messages[1].content).toContain('{ items: string[] }');
  });

  it('includes lastOutput when provided', () => {
    const messages = buildRepairMessages({
      source: 'code',
      error: 'err',
      a11yTree: '{}',
      lastOutput: '{ items: ["a"] }',
    });

    expect(messages[1].content).toContain('{ items: ["a"] }');
  });

  it('uses "Not specified" for missing schema', () => {
    const messages = buildRepairMessages({
      source: 'code',
      error: 'err',
      a11yTree: '{}',
    });

    expect(messages[1].content).toContain('Not specified');
  });

  it('uses "None" for missing lastOutput', () => {
    const messages = buildRepairMessages({
      source: 'code',
      error: 'err',
      a11yTree: '{}',
    });

    expect(messages[1].content).toContain('None');
  });
});

describe('prompt constants', () => {
  it('EXPLORER_SYSTEM_PROMPT mentions HumanizedPage API', () => {
    expect(EXPLORER_SYSTEM_PROMPT).toContain('HumanizedPage');
  });

  it('EXPLORER_SYSTEM_PROMPT lists available page methods', () => {
    expect(EXPLORER_SYSTEM_PROMPT).toContain('goto(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('click(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('fill(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('scroll(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('locator(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByRole(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByText(');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByLabel(');
  });

  it('EXPLORER_SYSTEM_PROMPT lists blocked APIs', () => {
    expect(EXPLORER_SYSTEM_PROMPT).toContain('eval');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('Function');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('fetch');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('import');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('require');
  });

  it('SCRIPT_GENERATION_PROMPT has placeholders', () => {
    expect(SCRIPT_GENERATION_PROMPT).toContain('{description}');
    expect(SCRIPT_GENERATION_PROMPT).toContain('{url}');
    expect(SCRIPT_GENERATION_PROMPT).toContain('{domains}');
    expect(SCRIPT_GENERATION_PROMPT).toContain('{a11yTree}');
  });

  it('REPAIR_PROMPT has placeholders', () => {
    expect(REPAIR_PROMPT).toContain('{source}');
    expect(REPAIR_PROMPT).toContain('{error}');
    expect(REPAIR_PROMPT).toContain('{a11yTree}');
    expect(REPAIR_PROMPT).toContain('{schema}');
    expect(REPAIR_PROMPT).toContain('{lastOutput}');
  });
});
