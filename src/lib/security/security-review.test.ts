import { describe, it, expect, vi } from 'vitest';
import type { LLMClient } from '../llm-client';
import { securityReview } from './security-review';
import { buildReviewMessages, DATA_FLOW_REVIEW_PROMPT, CAPABILITY_REVIEW_PROMPT } from './review-prompts';

function createMockClient(response: string, modelName = 'test-model'): LLMClient {
  return {
    chat: vi.fn().mockResolvedValue(response),
    modelName,
  } as unknown as LLMClient;
}

describe('securityReview', () => {
  const safeScript = `
    async function run(page, context) {
      await page.goto('https://example.com');
      const text = await page.locator('.price').textContent();
      context.state.price = text;
      return { price: text };
    }
  `;

  it('approves when both models approve', async () => {
    const client1 = createMockClient(JSON.stringify({ approved: true, issues: [] }), 'model-a');
    const client2 = createMockClient(JSON.stringify({ approved: true, issues: [] }), 'model-b');

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(true);
    expect(result.details).toHaveLength(2);
    expect(result.details[0].approved).toBe(true);
    expect(result.details[1].approved).toBe(true);
  });

  it('rejects when first model rejects', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: false, issues: ['Data exfiltration risk'] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Data exfiltration risk');
    expect(result.details[1].approved).toBe(true);
  });

  it('rejects when second model rejects', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: false, issues: ['Capability escape detected'] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(true);
    expect(result.details[1].approved).toBe(false);
    expect(result.details[1].issues).toContain('Capability escape detected');
  });

  it('rejects with both details when both models reject', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: false, issues: ['Issue A'] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: false, issues: ['Issue B'] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details).toHaveLength(2);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Issue A');
    expect(result.details[1].approved).toBe(false);
    expect(result.details[1].issues).toContain('Issue B');
  });

  it('fail-closed on malformed JSON response', async () => {
    const client1 = createMockClient('not valid json', 'model-a');
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues[0]).toMatch(/Review error/);
  });

  it('fail-closed when approved field is missing', async () => {
    const client1 = createMockClient(
      JSON.stringify({ issues: ['something'] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues).toContain('Malformed review response: missing approved field');
  });

  it('fail-closed on LLM error/timeout', async () => {
    const client1 = {
      chat: vi.fn().mockRejectedValue(new Error('Request timeout')),
      modelName: 'model-a',
    } as unknown as LLMClient;
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.approved).toBe(false);
    expect(result.details[0].approved).toBe(false);
    expect(result.details[0].issues[0]).toContain('Request timeout');
  });

  it('includes previous source in messages for repairs', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const previousSource = 'async function run(page) { await page.goto("https://example.com"); }';
    await securityReview(safeScript, [client1, client2], previousSource);

    // Verify both clients received messages that include previous source
    const call1Messages = (client1.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call2Messages = (client2.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];

    const call1UserContent = call1Messages.find((m: { role: string }) => m.role === 'user')?.content;
    const call2UserContent = call2Messages.find((m: { role: string }) => m.role === 'user')?.content;

    expect(call1UserContent).toContain('Previous approved version');
    expect(call1UserContent).toContain(previousSource);
    expect(call2UserContent).toContain('Previous approved version');
    expect(call2UserContent).toContain(previousSource);
  });

  it('sends correct prompt types to each model', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    await securityReview(safeScript, [client1, client2]);

    const call1Messages = (client1.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const call2Messages = (client2.chat as ReturnType<typeof vi.fn>).mock.calls[0][0];

    // First client gets data_flow prompt
    const call1SystemContent = call1Messages.find((m: { role: string }) => m.role === 'system')?.content;
    expect(call1SystemContent).toContain('DATA FLOW analysis');

    // Second client gets capability prompt
    const call2SystemContent = call2Messages.find((m: { role: string }) => m.role === 'system')?.content;
    expect(call2SystemContent).toContain('CAPABILITY analysis');
  });

  it('includes issues array in details', async () => {
    const issues = ['Potential data exfiltration via state keys', 'Reads password field'];
    const client1 = createMockClient(
      JSON.stringify({ approved: false, issues }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    const result = await securityReview(safeScript, [client1, client2]);

    expect(result.details[0].issues).toEqual(issues);
    expect(result.details[0].model).toBe('model-a');
    expect(result.details[1].issues).toEqual([]);
    expect(result.details[1].model).toBe('model-b');
  });

  it('calls LLM with temperature 0 and jsonMode true', async () => {
    const client1 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-a',
    );
    const client2 = createMockClient(
      JSON.stringify({ approved: true, issues: [] }),
      'model-b',
    );

    await securityReview(safeScript, [client1, client2]);

    const call1Opts = (client1.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];
    const call2Opts = (client2.chat as ReturnType<typeof vi.fn>).mock.calls[0][1];

    expect(call1Opts).toEqual({ temperature: 0, jsonMode: true });
    expect(call2Opts).toEqual({ temperature: 0, jsonMode: true });
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
    expect(DATA_FLOW_REVIEW_PROMPT).toContain('exfiltrated');
  });

  it('CAPABILITY_REVIEW_PROMPT focuses on capabilities', () => {
    expect(CAPABILITY_REVIEW_PROMPT).toContain('CAPABILITY');
    expect(CAPABILITY_REVIEW_PROMPT).toContain('Allowed page methods');
  });
});
