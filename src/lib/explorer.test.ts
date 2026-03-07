import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mock chrome APIs ---
const mockSendMessage = vi.fn();
const mockTabsGet = vi.fn();
const mockCaptureVisibleTab = vi.fn();

vi.stubGlobal('chrome', {
  runtime: { sendMessage: mockSendMessage },
  tabs: { get: mockTabsGet, captureVisibleTab: mockCaptureVisibleTab },
});

// --- Mock LLMClient ---
const { mockChat, MockLLMClient } = vi.hoisted(() => {
  const mockChat = vi.fn();

  class MockLLMClient {
    chat = mockChat;
    modelName = 'test-model';
  }

  return { mockChat, MockLLMClient };
});

vi.mock('./llm-client', () => ({
  LLMClient: MockLLMClient,
}));

import {
  observePage,
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
import type { LLMClient } from './llm-client';

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

describe('observePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('gets a11y tree and screenshot', async () => {
    const mockTree = { role: 'main', name: 'Page', children: [] };
    mockSendMessage.mockResolvedValueOnce(mockTree);
    mockTabsGet.mockResolvedValueOnce({
      windowId: 1,
      url: 'https://example.com',
      title: 'Example',
    });
    mockCaptureVisibleTab.mockResolvedValueOnce('data:image/png;base64,abc123');

    const result = await observePage(42);

    expect(mockSendMessage).toHaveBeenCalledWith({ type: 'GET_A11Y_TREE', tabId: 42 });
    expect(mockTabsGet).toHaveBeenCalledWith(42);
    expect(mockCaptureVisibleTab).toHaveBeenCalledWith(1, { format: 'png' });
    expect(result).toEqual({
      a11yTree: JSON.stringify(mockTree, null, 2),
      screenshot: 'data:image/png;base64,abc123',
      url: 'https://example.com',
      title: 'Example',
    });
  });

  it('handles screenshot failure gracefully', async () => {
    const mockTree = { role: 'main', name: 'Page' };
    mockSendMessage.mockResolvedValueOnce(mockTree);
    mockTabsGet.mockResolvedValueOnce({
      windowId: 1,
      url: 'chrome://extensions',
      title: 'Extensions',
    });
    mockCaptureVisibleTab.mockRejectedValueOnce(new Error('Cannot capture restricted page'));

    const result = await observePage(99);

    expect(result.screenshot).toBeUndefined();
    expect(result.url).toBe('chrome://extensions');
    expect(result.title).toBe('Extensions');
    expect(result.a11yTree).toBe(JSON.stringify(mockTree, null, 2));
  });

  it('returns empty strings when tab has no url or title', async () => {
    mockSendMessage.mockResolvedValueOnce({});
    mockTabsGet.mockResolvedValueOnce({ windowId: 1 });
    mockCaptureVisibleTab.mockResolvedValueOnce('data:image/png;base64,xyz');

    const result = await observePage(1);

    expect(result.url).toBe('');
    expect(result.title).toBe('');
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
    mockChat.mockResolvedValueOnce(validScript);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await generateScript(client, 'Navigate to example.com', observation, ['example.com']);

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(result.source).toBe(validScript);
    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('strips markdown code fences from response', async () => {
    const wrappedScript = '```javascript\nasync function run(page) {\n  await page.click("button");\n}\n```';
    const expectedScript = 'async function run(page) {\n  await page.click("button");\n}';
    mockChat.mockResolvedValueOnce(wrappedScript);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await generateScript(client, 'Click button', observation, ['example.com']);

    expect(result.source).toBe(expectedScript);
  });

  it('validates AST on generated script', async () => {
    const validScript = 'async function run(page) { await page.goto("https://example.com"); }';
    mockChat.mockResolvedValueOnce(validScript);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await generateScript(client, 'Go to page', observation, ['example.com']);

    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('returns AST errors for invalid scripts', async () => {
    const dangerousScript = 'async function run(page) { eval("alert(1)"); }';
    mockChat.mockResolvedValueOnce(dangerousScript);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await generateScript(client, 'Do something', observation, ['example.com']);

    expect(result.astValid).toBe(false);
    expect(result.astErrors.length).toBeGreaterThan(0);
    expect(result.astErrors.some(e => e.includes('eval'))).toBe(true);
  });

  it('returns AST errors for syntax errors', async () => {
    const invalidSyntax = 'function {{{ broken';
    mockChat.mockResolvedValueOnce(invalidSyntax);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await generateScript(client, 'Do something', observation, ['example.com']);

    expect(result.astValid).toBe(false);
    expect(result.astErrors[0]).toContain('Parse error');
  });

  it('passes screenshot to LLM when available', async () => {
    const observationWithScreenshot: ExplorationResult = {
      ...observation,
      screenshot: 'data:image/png;base64,screenshot123',
    };
    mockChat.mockResolvedValueOnce('async function run(page) { return {}; }');

    const client = new MockLLMClient() as unknown as LLMClient;
    await generateScript(client, 'Describe page', observationWithScreenshot, ['example.com']);

    const callArgs = mockChat.mock.calls[0][0];
    // The user message should have multimodal content
    const userMessage = callArgs[1];
    expect(Array.isArray(userMessage.content)).toBe(true);
    expect(userMessage.content).toHaveLength(2);
    expect(userMessage.content[0].type).toBe('text');
    expect(userMessage.content[1].type).toBe('image_url');
    expect(userMessage.content[1].image_url.url).toBe('data:image/png;base64,screenshot123');
  });
});

describe('repairScript', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('generates a repaired script', async () => {
    const repairedScript = 'async function run(page) {\n  await page.click("[data-testid=\\"btn\\"]");\n  return {};\n}';
    mockChat.mockResolvedValueOnce(repairedScript);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await repairScript(client, {
      source: 'async function run(page) { await page.click(".old-selector"); }',
      error: 'SelectorNotFound: .old-selector',
      a11yTree: '{"role":"main"}',
    });

    expect(mockChat).toHaveBeenCalledTimes(1);
    expect(result.source).toBe(repairedScript);
    expect(result.astValid).toBe(true);
    expect(result.astErrors).toHaveLength(0);
  });

  it('validates AST on repaired script', async () => {
    const dangerousRepair = 'async function run(page) { fetch("https://evil.com"); }';
    mockChat.mockResolvedValueOnce(dangerousRepair);

    const client = new MockLLMClient() as unknown as LLMClient;
    const result = await repairScript(client, {
      source: 'async function run(page) { await page.click("x"); }',
      error: 'SelectorNotFound',
      a11yTree: '{}',
    });

    expect(result.astValid).toBe(false);
    expect(result.astErrors.some(e => e.includes('fetch'))).toBe(true);
  });

  it('passes schema and lastOutput to repair messages', async () => {
    mockChat.mockResolvedValueOnce('async function run(page) { return { price: "10" }; }');

    const client = new MockLLMClient() as unknown as LLMClient;
    await repairScript(client, {
      source: 'async function run(page) { return {}; }',
      error: 'Missing price field',
      a11yTree: '{"role":"main"}',
      schema: '{ price: string }',
      lastOutput: '{ price: "5.99" }',
    });

    const callArgs = mockChat.mock.calls[0][0];
    const userContent = callArgs[1].content;
    expect(userContent).toContain('{ price: string }');
    expect(userContent).toContain('{ price: "5.99" }');
  });

  it('uses defaults when schema and lastOutput are not provided', async () => {
    mockChat.mockResolvedValueOnce('async function run(page) { return {}; }');

    const client = new MockLLMClient() as unknown as LLMClient;
    await repairScript(client, {
      source: 'async function run(page) { return {}; }',
      error: 'Some error',
      a11yTree: '{}',
    });

    const callArgs = mockChat.mock.calls[0][0];
    const userContent = callArgs[1].content;
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
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.goto');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.click');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.fill');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.type');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.scroll');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('page.locator');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByRole');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByText');
    expect(EXPLORER_SYSTEM_PROMPT).toContain('getByLabel');
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
