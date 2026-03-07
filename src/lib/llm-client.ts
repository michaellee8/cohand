import OpenAI from 'openai';
import type { Settings } from '../types';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMCallOptions {
  signal?: AbortSignal;
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
}

export class LLMClient {
  private client: OpenAI;
  private model: string;

  constructor(settings: Settings, token: string) {
    const config: ConstructorParameters<typeof OpenAI>[0] = {
      apiKey: token,
      dangerouslyAllowBrowser: true,
    };

    // Configure base URL based on provider
    switch (settings.llmProvider) {
      case 'anthropic':
        config.baseURL = 'https://api.anthropic.com/v1';
        break;
      case 'gemini':
        config.baseURL =
          'https://generativelanguage.googleapis.com/v1beta/openai';
        break;
      case 'custom':
        if (settings.llmBaseUrl) config.baseURL = settings.llmBaseUrl;
        break;
      // openai and chatgpt-subscription use default OpenAI base URL
    }

    this.client = new OpenAI(config);
    this.model = settings.llmModel;
  }

  async chat(messages: ChatMessage[], opts?: LLMCallOptions): Promise<string> {
    const response = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: opts?.temperature,
        max_tokens: opts?.maxTokens,
        response_format: opts?.jsonMode
          ? { type: 'json_object' }
          : undefined,
      },
      {
        signal: opts?.signal,
      },
    );

    return (response as OpenAI.Chat.ChatCompletion).choices[0]?.message
      ?.content ?? '';
  }

  async *stream(
    messages: ChatMessage[],
    opts?: LLMCallOptions,
  ): AsyncGenerator<string> {
    const stream = await this.client.chat.completions.create(
      {
        model: this.model,
        messages,
        temperature: opts?.temperature,
        max_tokens: opts?.maxTokens,
        stream: true,
      },
      {
        signal: opts?.signal,
      },
    );

    for await (const chunk of stream as AsyncIterable<OpenAI.Chat.ChatCompletionChunk>) {
      const content = chunk.choices[0]?.delta?.content;
      if (content) yield content;
    }
  }

  get modelName(): string {
    return this.model;
  }
}

/**
 * Create two LLM clients for dual-model security review.
 * In ChatGPT subscription mode, uses two different model families.
 * In API key mode, returns two clients with the same model (fresh contexts).
 */
export function createSecurityReviewClients(
  settings: Settings,
  token: string,
): [LLMClient, LLMClient] {
  if (settings.llmProvider === 'chatgpt-subscription') {
    const client1 = new LLMClient(
      { ...settings, llmModel: 'gpt-5.4' },
      token,
    );
    const client2 = new LLMClient(
      { ...settings, llmModel: 'gpt-5.3-codex' },
      token,
    );
    return [client1, client2];
  }

  // API key mode: same model, fresh contexts
  return [
    new LLMClient(settings, token),
    new LLMClient(settings, token),
  ];
}
