import { describe, it, expect, vi, beforeEach } from 'vitest';
import { securityReview } from './security-review';
import { buildReviewMessages, DATA_FLOW_REVIEW_PROMPT, CAPABILITY_REVIEW_PROMPT } from './review-prompts';

// Mock pi-ai's complete function
const mockComplete = vi.fn();
vi.mock('@mariozechner/pi-ai', () => ({
  complete: (...args: any[]) => mockComplete(...args),
}));

function createMockModel(id: string) {
  return {
    id,
    name: id,
    api: 'test',
    provider: 'test',
    baseUrl: '',
    reasoning: false,
    input: ['text'] as ('text' | 'image')[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

function makeAssistantMessage(text: string) {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    model: 'test',
    provider: 'test',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
  };
}

const TEST_API_KEY = 'test-api-key';

describe('securityReview', () => {
  const safeScript = `
    async function run(page, context) {
      await page.goto('https://example.com');
      const text = await page.locator('.price').textContent();
      context.state.price = text;
      return { price: text };
    }
  `;

  beforeEach(() => {
    mockComplete.mockReset();
  });

  it('approves when both models approve', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(true);
    expect(result.details).toHaveLength(2);
    expect(result.details[0].approved).toBe(true);
    expect(result.details[1].approved).toBe(true);
  });

  it('rejects when first model rejects', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: false, issues: ['Data exfiltration risk'] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Data exfiltration risk');
    expect(result.details[1].approved).toBe(true);
  });

  it('rejects when second model rejects', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: false, issues: ['Capability escape detected'] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(true);
    expect(result.details[1].approved).toBe(false);
    expect(result.details[1].issues).toContain('Capability escape detected');
  });

  it('rejects with both details when both models reject', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: false, issues: ['Issue A'] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: false, issues: ['Issue B'] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details).toHaveLength(2);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Issue A');
    expect(result.details[1].approved).toBe(false);
    expect(result.details[1].issues).toContain('Issue B');
  });

  it('fail-closed on malformed JSON response', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage('not valid json'))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues[0]).toMatch(/Review error/);
  });

  it('fail-closed when approved field is missing', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ issues: ['something'] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Malformed review response: missing approved field');
  });

  it('fail-closed on LLM error/timeout', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockRejectedValueOnce(new Error('Request timeout'))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues[0]).toContain('Request timeout');
  });

  it('includes previous source in messages for repairs', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const previousSource = 'async function run(page) { await page.goto("https://example.com"); }';
    await securityReview(safeScript, [model1, model2], TEST_API_KEY, previousSource);

    // Verify both complete() calls received contexts that include previous source
    expect(mockComplete).toHaveBeenCalledTimes(2);

    const call1Context = mockComplete.mock.calls[0][1];
    const call2Context = mockComplete.mock.calls[1][1];

    // The user message in the context should contain the previous source
    const call1UserContent = call1Context.messages[0]?.content;
    const call2UserContent = call2Context.messages[0]?.content;

    expect(call1UserContent).toContain('Previous approved version');
    expect(call1UserContent).toContain(previousSource);
    expect(call2UserContent).toContain('Previous approved version');
    expect(call2UserContent).toContain(previousSource);
  });

  it('sends correct prompt types to each model', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    const call1Context = mockComplete.mock.calls[0][1];
    const call2Context = mockComplete.mock.calls[1][1];

    // First model gets data_flow prompt
    expect(call1Context.systemPrompt).toContain('DATA FLOW analysis');

    // Second model gets capability prompt
    expect(call2Context.systemPrompt).toContain('CAPABILITY analysis');
  });

  it('includes issues array in details', async () => {
    const issues = ['Potential data exfiltration via state keys', 'Reads password field'];
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: false, issues })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    const result = await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    expect(result.details[0].issues).toEqual(issues);
    expect(result.details[0].model).toBe('model-a');
    expect(result.details[1].issues).toEqual([]);
    expect(result.details[1].model).toBe('model-b');
  });

  it('passes model and apiKey to complete()', async () => {
    const model1 = createMockModel('model-a');
    const model2 = createMockModel('model-b');

    mockComplete
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })))
      .mockResolvedValueOnce(makeAssistantMessage(JSON.stringify({ approved: true, issues: [] })));

    await securityReview(safeScript, [model1, model2], TEST_API_KEY);

    // Verify correct model and apiKey passed to each call
    expect(mockComplete.mock.calls[0][0]).toBe(model1);
    expect(mockComplete.mock.calls[0][2]).toEqual({ apiKey: TEST_API_KEY });
    expect(mockComplete.mock.calls[1][0]).toBe(model2);
    expect(mockComplete.mock.calls[1][2]).toEqual({ apiKey: TEST_API_KEY });
  });
});

describe('buildReviewMessages', () => {
  const source = 'async function run(page) { await page.click(".btn"); }';

  it('builds data_flow messages with correct system prompt', () => {
    const messages = buildReviewMessages(source, 'data_flow');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(DATA_FLOW_REVIEW_PROMPT);
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(source);
  });

  it('builds capability messages with correct system prompt', () => {
    const messages = buildReviewMessages(source, 'capability');

    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(CAPABILITY_REVIEW_PROMPT);
    expect(messages[1].role).toBe('user');
    expect(messages[1].content).toContain(source);
  });

  it('includes previous source when provided', () => {
    const prev = 'async function run(page) { }';
    const messages = buildReviewMessages(source, 'data_flow', prev);

    expect(messages[1].content).toContain('Previous approved version');
    expect(messages[1].content).toContain(prev);
    expect(messages[1].content).toContain('evaluate ONLY the delta');
  });

  it('does not include previous source section when not provided', () => {
    const messages = buildReviewMessages(source, 'data_flow');

    expect(messages[1].content).not.toContain('Previous approved version');
  });

  it('wraps source in code blocks', () => {
    const messages = buildReviewMessages(source, 'capability');

    expect(messages[1].content).toContain('```javascript');
    expect(messages[1].content).toContain('```');
  });
});

describe('review prompts content', () => {
  it('DATA_FLOW_REVIEW_PROMPT contains adversarial examples', () => {
    expect(DATA_FLOW_REVIEW_PROMPT).toContain('ADVERSARIAL EXAMPLES');
    expect(DATA_FLOW_REVIEW_PROMPT).toContain('Function constructor abuse');
  });

  it('CAPABILITY_REVIEW_PROMPT contains adversarial examples', () => {
    expect(CAPABILITY_REVIEW_PROMPT).toContain('ADVERSARIAL EXAMPLES');
    expect(CAPABILITY_REVIEW_PROMPT).toContain('String concatenation to bypass static checks');
  });

  it('DATA_FLOW_REVIEW_PROMPT focuses on data flow', () => {
    expect(DATA_FLOW_REVIEW_PROMPT).toContain('DATA FLOW');
    expect(DATA_FLOW_REVIEW_PROMPT).toContain('EXFILTRATION');
  });

  it('CAPABILITY_REVIEW_PROMPT focuses on capabilities', () => {
    expect(CAPABILITY_REVIEW_PROMPT).toContain('CAPABILITY');
    expect(CAPABILITY_REVIEW_PROMPT).toContain('Allowed page methods');
  });
});
