import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';

// vi.hoisted ensures these are available when the mock factory runs (hoisted)
const { mockCreate, constructorCalls, MockOpenAI } = vi.hoisted(() => {
  const mockCreate = vi.fn();
  const constructorCalls: Record<string, unknown>[] = [];

  class MockOpenAI {
    _config: Record<string, unknown>;
    chat = {
      completions: {
        create: mockCreate,
      },
    };

    constructor(config: Record<string, unknown>) {
      this._config = config;
      constructorCalls.push(config);
    }
  }

  return { mockCreate, constructorCalls, MockOpenAI };
});

vi.mock('openai', () => ({
  default: MockOpenAI,
}));

import { LLMClient, createSecurityReviewClients } from './llm-client';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    yoloMode: false,
    language: 'en',
    ...overrides,
  };
}

describe('LLMClient', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  describe('constructor / provider base URLs', () => {
    it('uses default base URL for openai provider', () => {
      new LLMClient(makeSettings({ llmProvider: 'openai' }), 'sk-test');
      expect(constructorCalls).toHaveLength(1);
      expect(constructorCalls[0]).toMatchObject({
        apiKey: 'sk-test',
        dangerouslyAllowBrowser: true,
      });
      // Should NOT have a baseURL for openai
      expect(constructorCalls[0].baseURL).toBeUndefined();
    });

    it('uses default base URL for chatgpt-subscription provider', () => {
      new LLMClient(makeSettings({ llmProvider: 'chatgpt-subscription' }), 'tok');
      expect(constructorCalls[0].baseURL).toBeUndefined();
    });

    it('sets anthropic base URL', () => {
      new LLMClient(makeSettings({ llmProvider: 'anthropic' }), 'sk-ant');
      expect(constructorCalls[0].baseURL).toBe('https://api.anthropic.com/v1');
    });

    it('sets gemini base URL', () => {
      new LLMClient(makeSettings({ llmProvider: 'gemini' }), 'gemkey');
      expect(constructorCalls[0].baseURL).toBe(
        'https://generativelanguage.googleapis.com/v1beta/openai',
      );
    });

    it('sets custom base URL when provided', () => {
      new LLMClient(
        makeSettings({
          llmProvider: 'custom',
          llmBaseUrl: 'https://my-llm.example.com/v1',
        }),
        'key',
      );
      expect(constructorCalls[0].baseURL).toBe('https://my-llm.example.com/v1');
    });

    it('does not set base URL for custom provider without llmBaseUrl', () => {
      new LLMClient(makeSettings({ llmProvider: 'custom' }), 'key');
      expect(constructorCalls[0].baseURL).toBeUndefined();
    });
  });

  describe('modelName', () => {
    it('returns the configured model', () => {
      const client = new LLMClient(
        makeSettings({ llmModel: 'claude-sonnet-4-20250514' }),
        'key',
      );
      expect(client.modelName).toBe('claude-sonnet-4-20250514');
    });
  });

  describe('chat()', () => {
    it('returns response content', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'Hello from LLM' } }],
      });

      const client = new LLMClient(makeSettings(), 'key');
      const result = await client.chat([
        { role: 'user', content: 'Hi' },
      ]);

      expect(result).toBe('Hello from LLM');
    });

    it('passes correct model, messages, and temperature', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' } }],
      });

      const client = new LLMClient(
        makeSettings({ llmModel: 'gpt-4o-mini' }),
        'key',
      );
      const messages = [
        { role: 'system' as const, content: 'You are helpful.' },
        { role: 'user' as const, content: 'Hello' },
      ];
      await client.chat(messages, { temperature: 0.7 });

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          model: 'gpt-4o-mini',
          messages,
          temperature: 0.7,
        }),
        expect.any(Object),
      );
    });

    it('supports jsonMode', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: '{"key":"value"}' } }],
      });

      const client = new LLMClient(makeSettings(), 'key');
      await client.chat(
        [{ role: 'user', content: 'return json' }],
        { jsonMode: true },
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: { type: 'json_object' },
        }),
        expect.any(Object),
      );
    });

    it('does not set response_format when jsonMode is false/undefined', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'text' } }],
      });

      const client = new LLMClient(makeSettings(), 'key');
      await client.chat([{ role: 'user', content: 'hi' }]);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          response_format: undefined,
        }),
        expect.any(Object),
      );
    });

    it('passes signal through', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'ok' } }],
      });

      const controller = new AbortController();
      const client = new LLMClient(makeSettings(), 'key');
      await client.chat(
        [{ role: 'user', content: 'hi' }],
        { signal: controller.signal },
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.any(Object),
        expect.objectContaining({ signal: controller.signal }),
      );
    });

    it('passes maxTokens through', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'short' } }],
      });

      const client = new LLMClient(makeSettings(), 'key');
      await client.chat(
        [{ role: 'user', content: 'hi' }],
        { maxTokens: 100 },
      );

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ max_tokens: 100 }),
        expect.any(Object),
      );
    });

    it('returns empty string when no content in response', async () => {
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: null } }],
      });

      const client = new LLMClient(makeSettings(), 'key');
      const result = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(result).toBe('');
    });

    it('returns empty string when choices is empty', async () => {
      mockCreate.mockResolvedValueOnce({ choices: [] });

      const client = new LLMClient(makeSettings(), 'key');
      const result = await client.chat([{ role: 'user', content: 'hi' }]);
      expect(result).toBe('');
    });
  });

  describe('stream()', () => {
    it('yields chunks from stream', async () => {
      const chunks = [
        { choices: [{ delta: { content: 'Hello' } }] },
        { choices: [{ delta: { content: ' world' } }] },
        { choices: [{ delta: { content: '!' } }] },
        { choices: [{ delta: {} }] }, // no content chunk
      ];

      mockCreate.mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          for (const chunk of chunks) yield chunk;
        },
      });

      const client = new LLMClient(makeSettings(), 'key');
      const parts: string[] = [];
      for await (const part of client.stream([
        { role: 'user', content: 'hi' },
      ])) {
        parts.push(part);
      }

      expect(parts).toEqual(['Hello', ' world', '!']);
    });

    it('passes stream: true to the API', async () => {
      mockCreate.mockResolvedValueOnce({
        [Symbol.asyncIterator]: async function* () {
          // empty stream
        },
      });

      const client = new LLMClient(makeSettings(), 'key');
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _ of client.stream([
        { role: 'user', content: 'hi' },
      ])) {
        // consume
      }

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        expect.any(Object),
      );
    });
  });
});

describe('createSecurityReviewClients', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    constructorCalls.length = 0;
  });

  it('returns two different models for chatgpt-subscription', () => {
    const [c1, c2] = createSecurityReviewClients(
      makeSettings({ llmProvider: 'chatgpt-subscription' }),
      'tok',
    );

    expect(c1.modelName).toBe('gpt-5.4');
    expect(c2.modelName).toBe('gpt-5.3-codex');
    expect(c1.modelName).not.toBe(c2.modelName);
  });

  it('returns same model for openai API key provider', () => {
    const settings = makeSettings({
      llmProvider: 'openai',
      llmModel: 'gpt-4o',
    });
    const [c1, c2] = createSecurityReviewClients(settings, 'sk-key');

    expect(c1.modelName).toBe('gpt-4o');
    expect(c2.modelName).toBe('gpt-4o');
  });

  it('returns same model for anthropic provider', () => {
    const settings = makeSettings({
      llmProvider: 'anthropic',
      llmModel: 'claude-sonnet-4-20250514',
    });
    const [c1, c2] = createSecurityReviewClients(settings, 'sk-ant');

    expect(c1.modelName).toBe('claude-sonnet-4-20250514');
    expect(c2.modelName).toBe('claude-sonnet-4-20250514');
  });

  it('returns same model for gemini provider', () => {
    const settings = makeSettings({
      llmProvider: 'gemini',
      llmModel: 'gemini-2.5-pro',
    });
    const [c1, c2] = createSecurityReviewClients(settings, 'gkey');

    expect(c1.modelName).toBe('gemini-2.5-pro');
    expect(c2.modelName).toBe('gemini-2.5-pro');
  });

  it('returns same model for custom provider', () => {
    const settings = makeSettings({
      llmProvider: 'custom',
      llmModel: 'local-llama',
      llmBaseUrl: 'http://localhost:8080/v1',
    });
    const [c1, c2] = createSecurityReviewClients(settings, 'nokey');

    expect(c1.modelName).toBe('local-llama');
    expect(c2.modelName).toBe('local-llama');
  });
});
