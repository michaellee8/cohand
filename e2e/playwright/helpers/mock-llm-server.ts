import http from 'node:http';

export interface MockLLMResponse {
  content: string;
  model?: string;
  finishReason?: string;
}

/**
 * Lightweight mock LLM server that mimics both the OpenAI Chat Completions API
 * and the Codex Responses API (used by chatgpt-subscription provider via pi-ai).
 * Supports regular and streaming responses for both APIs.
 * No external dependencies -- uses node:http only.
 */
export class MockLLMServer {
  private server: http.Server | null = null;
  private responses: MockLLMResponse[] = [];
  private requestLog: { path: string; body: unknown; headers: Record<string, string> }[] = [];
  private routeResponses: Map<string, MockLLMResponse[]> = new Map();
  private defaultResponse: MockLLMResponse = {
    content: 'Mock LLM response for testing.',
    model: 'gpt-5.4',
    finishReason: 'stop',
  };

  /** Set the response queue. Each request pops the next response. */
  setResponses(responses: MockLLMResponse[]): void {
    this.responses = [...responses];
  }

  /** Set a single response for all requests */
  setDefaultResponse(response: MockLLMResponse): void {
    this.defaultResponse = response;
  }

  /**
   * Set response queue for a specific route pattern.
   * Useful for tests that need different responses for script generation
   * vs security review vs chat.
   *
   * @param routePattern - Substring to match against the request path (e.g. 'codex/responses', 'chat/completions')
   * @param responses - Queue of responses for this route
   */
  setRouteResponses(routePattern: string, responses: MockLLMResponse[]): void {
    this.routeResponses.set(routePattern, [...responses]);
  }

  /** Get logged requests (includes headers for auth verification) */
  getRequestLog(): { path: string; body: unknown; headers: Record<string, string> }[] {
    return [...this.requestLog];
  }

  /** Get requests matching a path substring */
  getRequestsForRoute(routePattern: string): { path: string; body: unknown; headers: Record<string, string> }[] {
    return this.requestLog.filter(r => r.path.includes(routePattern));
  }

  /** Clear request log */
  clearLog(): void {
    this.requestLog = [];
  }

  /** Reset all state (responses, route responses, log) */
  reset(): void {
    this.responses = [];
    this.routeResponses.clear();
    this.requestLog = [];
    this.defaultResponse = {
      content: 'Mock LLM response for testing.',
      model: 'gpt-5.4',
      finishReason: 'stop',
    };
  }

  /** Start the server on the given port. Pass 0 for a random available port. */
  async start(port = 18923): Promise<string> {
    // Stop any existing server on this instance first
    await this.stop();

    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res);
      });

      this.server.on('error', reject);
      this.server.listen(port, '127.0.0.1', () => {
        const addr = this.server!.address() as import('node:net').AddressInfo;
        const baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve(baseUrl);
      });
    });
  }

  /** Stop the server */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => {
        this.server = null;
        resolve();
      });
    });
  }

  private getResponseForRoute(path: string): MockLLMResponse {
    // Check route-specific responses first
    for (const [pattern, queue] of this.routeResponses) {
      if (path.includes(pattern) && queue.length > 0) {
        return queue.shift()!;
      }
    }
    // Fall back to general queue, then default
    return this.responses.shift() ?? this.defaultResponse;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });

    req.on('end', () => {
      let parsed: unknown = null;
      try {
        parsed = body ? JSON.parse(body) : null;
      } catch {
        // ignore parse errors
      }

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === 'string') headers[key] = value;
      }

      this.requestLog.push({ path: req.url ?? '/', body: parsed, headers });

      // CORS headers (extension sends cross-origin requests)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers',
        'Content-Type, Authorization, chatgpt-account-id, OpenAI-Beta, originator, User-Agent, session_id, accept');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = req.url ?? '/';

      // Health check
      if (url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      // Codex Responses API endpoint (used by chatgpt-subscription via pi-ai)
      if (url.includes('/codex/responses')) {
        const mockResp = this.getResponseForRoute(url);
        this.sendCodexResponsesStream(res, mockResp);
        return;
      }

      // Chat completions endpoint (used by openai, anthropic-compatible, custom)
      if (url.includes('/chat/completions')) {
        const mockResp = this.getResponseForRoute(url);
        const isStream = (parsed as any)?.stream === true;

        if (isStream) {
          this.sendStreamingResponse(res, mockResp);
        } else {
          this.sendRegularResponse(res, mockResp);
        }
        return;
      }

      // Anthropic messages endpoint
      if (url.includes('/messages')) {
        const mockResp = this.getResponseForRoute(url);
        const isStream = (parsed as any)?.stream === true;

        if (isStream) {
          this.sendAnthropicStream(res, mockResp);
        } else {
          this.sendAnthropicResponse(res, mockResp);
        }
        return;
      }

      // Models endpoint
      if (url === '/v1/models' || url === '/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          data: [
            { id: 'gpt-5.4', object: 'model' },
            { id: 'gpt-5.3-codex', object: 'model' },
          ],
        }));
        return;
      }

      // Token refresh endpoint (for codex OAuth refresh flow)
      if (url === '/oauth/token') {
        this.sendTokenRefreshResponse(res);
        return;
      }

      // 404 for anything else
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found', path: url }));
    });
  }

  // ---------------------------------------------------------------------------
  // OpenAI Chat Completions format
  // ---------------------------------------------------------------------------

  private sendRegularResponse(res: http.ServerResponse, mock: MockLLMResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: mock.model ?? 'gpt-5.4',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: mock.content },
        finish_reason: mock.finishReason ?? 'stop',
      }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }));
  }

  private sendStreamingResponse(res: http.ServerResponse, mock: MockLLMResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const model = mock.model ?? 'gpt-5.4';
    const id = `chatcmpl-mock-${Date.now()}`;

    const words = mock.content.split(' ');
    const chunks = words.length > 0 ? words : [''];

    for (const word of chunks) {
      const chunk = {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: { content: word + ' ' },
          finish_reason: null,
        }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }

    const finalChunk = {
      id,
      object: 'chat.completion.chunk',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: mock.finishReason ?? 'stop',
      }],
    };
    res.write(`data: ${JSON.stringify(finalChunk)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  }

  // ---------------------------------------------------------------------------
  // Codex Responses API format (SSE events used by openai-codex-responses provider)
  // ---------------------------------------------------------------------------

  private sendCodexResponsesStream(res: http.ServerResponse, mock: MockLLMResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const model = mock.model ?? 'gpt-5.4';
    const responseId = `resp-mock-${Date.now()}`;
    const itemId = `item-mock-${Date.now()}`;
    const outputIdx = 0;
    const contentIdx = 0;

    // response.created
    res.write(`data: ${JSON.stringify({
      type: 'response.created',
      response: {
        id: responseId,
        object: 'response',
        status: 'in_progress',
        model,
        output: [],
      },
    })}\n\n`);

    // response.output_item.added
    res.write(`data: ${JSON.stringify({
      type: 'response.output_item.added',
      output_index: outputIdx,
      item: {
        id: itemId,
        type: 'message',
        role: 'assistant',
        content: [],
      },
    })}\n\n`);

    // response.content_part.added
    res.write(`data: ${JSON.stringify({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIdx,
      content_index: contentIdx,
      part: { type: 'output_text', text: '' },
    })}\n\n`);

    // Stream text deltas word-by-word
    const words = mock.content.split(' ');
    for (const word of words) {
      res.write(`data: ${JSON.stringify({
        type: 'response.output_text.delta',
        item_id: itemId,
        output_index: outputIdx,
        content_index: contentIdx,
        delta: word + ' ',
      })}\n\n`);
    }

    // response.output_text.done
    res.write(`data: ${JSON.stringify({
      type: 'response.output_text.done',
      item_id: itemId,
      output_index: outputIdx,
      content_index: contentIdx,
      text: mock.content,
    })}\n\n`);

    // response.content_part.done
    res.write(`data: ${JSON.stringify({
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIdx,
      content_index: contentIdx,
      part: { type: 'output_text', text: mock.content },
    })}\n\n`);

    // response.output_item.done
    res.write(`data: ${JSON.stringify({
      type: 'response.output_item.done',
      output_index: outputIdx,
      item: {
        id: itemId,
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: mock.content }],
      },
    })}\n\n`);

    // response.completed
    res.write(`data: ${JSON.stringify({
      type: 'response.completed',
      response: {
        id: responseId,
        object: 'response',
        status: 'completed',
        model,
        output: [{
          id: itemId,
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: mock.content }],
        }],
        usage: {
          input_tokens: 10,
          output_tokens: 20,
          total_tokens: 30,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    })}\n\n`);

    res.end();
  }

  // ---------------------------------------------------------------------------
  // Anthropic Messages API format
  // ---------------------------------------------------------------------------

  private sendAnthropicResponse(res: http.ServerResponse, mock: MockLLMResponse): void {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      id: `msg-mock-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: mock.model ?? 'claude-sonnet-4-20250514',
      content: [{ type: 'text', text: mock.content }],
      stop_reason: mock.finishReason ?? 'end_turn',
      usage: { input_tokens: 10, output_tokens: 20 },
    }));
  }

  private sendAnthropicStream(res: http.ServerResponse, mock: MockLLMResponse): void {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    const model = mock.model ?? 'claude-sonnet-4-20250514';

    res.write(`event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: {
        id: `msg-mock-${Date.now()}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        usage: { input_tokens: 10, output_tokens: 0 },
      },
    })}\n\n`);

    res.write(`event: content_block_start\ndata: ${JSON.stringify({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    })}\n\n`);

    const words = mock.content.split(' ');
    for (const word of words) {
      res.write(`event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: word + ' ' },
      })}\n\n`);
    }

    res.write(`event: content_block_stop\ndata: ${JSON.stringify({
      type: 'content_block_stop',
      index: 0,
    })}\n\n`);

    res.write(`event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: mock.finishReason ?? 'end_turn' },
      usage: { output_tokens: 20 },
    })}\n\n`);

    res.write(`event: message_stop\ndata: ${JSON.stringify({
      type: 'message_stop',
    })}\n\n`);

    res.end();
  }

  // ---------------------------------------------------------------------------
  // OAuth token refresh mock
  // ---------------------------------------------------------------------------

  private sendTokenRefreshResponse(res: http.ServerResponse): void {
    // Build a fake JWT with a chatgpt_account_id claim
    const header = btoa(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const payload = btoa(JSON.stringify({
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'mock-account-id',
      },
      exp: Math.floor(Date.now() / 1000) + 3600,
    }));
    const fakeAccessToken = `${header}.${payload}.mock-signature`;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      access_token: fakeAccessToken,
      refresh_token: 'mock-refresh-token-new',
      expires_in: 3600,
      token_type: 'Bearer',
    }));
  }
}

// ---------------------------------------------------------------------------
// Pre-built response fixtures for common E2E scenarios
// ---------------------------------------------------------------------------

export const MOCK_RESPONSES = {
  /** Simple script generation response */
  scriptGeneration: (scriptSource?: string): MockLLMResponse => ({
    content: scriptSource ?? `async function run(page, context) {
  const text = await page.locator('[data-testid="price"]').textContent();
  return { price: text };
}`,
    model: 'gpt-5.4',
  }),

  /** Security review approval */
  securityReviewApproved: (): MockLLMResponse => ({
    content: JSON.stringify({
      approved: true,
      issues: [],
      summary: 'Script is safe. No dangerous operations detected.',
    }),
    model: 'gpt-5.4',
  }),

  /** Security review rejection */
  securityReviewRejected: (reason?: string): MockLLMResponse => ({
    content: JSON.stringify({
      approved: false,
      issues: [reason ?? 'Script uses eval() which is unsafe.'],
      summary: 'Script contains dangerous operations.',
    }),
    model: 'gpt-5.4',
  }),

  /** Chat response */
  chatReply: (text?: string): MockLLMResponse => ({
    content: text ?? 'I can help you create a task for that. What website would you like to monitor?',
    model: 'gpt-5.4',
  }),

  /** Recording refinement / script from recording */
  recordingRefinement: (description?: string, script?: string): MockLLMResponse => ({
    content: `## Description\n${description ?? 'Monitor product price changes'}\n\n## Script\n\`\`\`javascript\n${script ?? 'async function run(page, context) {\n  await page.goto("https://example.com");\n  return { ok: true };\n}'}\n\`\`\``,
    model: 'gpt-5.4',
  }),
};
