import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Settings } from '../types';
import type { LlmUsageRecord } from '../types/notification';

// vi.hoisted ensures these are available when the mock factory runs
const { mockGetModel } = vi.hoisted(() => {
  const mockGetModel = vi.fn();
  return { mockGetModel };
});

vi.mock('@mariozechner/pi-ai', () => ({
  getModel: mockGetModel,
}));

import {
  getModelSafe,
  resolveModel,
  getSecurityReviewModels,
  mapUsage,
  extractAccountId,
  refreshCodexToken,
  getCodexApiKey,
  type ModelLike,
  type OAuthCredentials,
} from './pi-ai-bridge';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    yoloMode: false,
    language: 'en',
    ...overrides,
  };
}

function makeFakeModel(overrides: Partial<ModelLike> = {}): ModelLike {
  return {
    id: 'gpt-4o',
    name: 'GPT-4o',
    api: 'openai-responses',
    provider: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    reasoning: false,
    input: ['text'],
    cost: { input: 15, output: 60, cacheRead: 7.5, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
    ...overrides,
  };
}

describe('getModelSafe', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns registered model when found', () => {
    const fakeModel = makeFakeModel();
    mockGetModel.mockReturnValueOnce(fakeModel);

    const result = getModelSafe('openai', 'openai-responses', 'gpt-4o');
    expect(result).toBe(fakeModel);
    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4o');
  });

  it('returns fallback when getModel returns undefined', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    const result = getModelSafe('openai', 'openai-responses', 'gpt-future');
    expect(result).toEqual({
      id: 'gpt-future',
      name: 'gpt-future',
      api: 'openai-responses',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      reasoning: false,
      input: ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it('returns fallback with correct base URL for anthropic', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    const result = getModelSafe('anthropic', 'anthropic-messages', 'claude-new');
    expect(result.baseUrl).toBe('https://api.anthropic.com/v1');
    expect(result.provider).toBe('anthropic');
    expect(result.api).toBe('anthropic-messages');
  });

  it('returns fallback with correct base URL for openai-codex', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    const result = getModelSafe('openai-codex', 'openai-codex-responses', 'gpt-5.4');
    expect(result.baseUrl).toBe('https://chatgpt.com/backend-api/codex');
    expect(result.provider).toBe('openai-codex');
  });

  it('returns fallback with correct base URL for google', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    const result = getModelSafe('google', 'google-generative-ai', 'gemini-pro');
    expect(result.baseUrl).toBe('https://generativelanguage.googleapis.com/v1beta');
  });

  it('returns fallback with empty base URL for unknown provider', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    const result = getModelSafe('some-unknown-provider', 'some-api', 'some-model');
    expect(result.baseUrl).toBe('');
  });
});

describe('resolveModel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('maps openai provider correctly', () => {
    const fakeModel = makeFakeModel();
    mockGetModel.mockReturnValueOnce(fakeModel);

    const result = resolveModel(makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }));
    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4o');
    expect(result).toBe(fakeModel);
  });

  it('maps chatgpt-subscription provider correctly', () => {
    const fakeModel = makeFakeModel({ id: 'gpt-5.4', provider: 'openai-codex' });
    mockGetModel.mockReturnValueOnce(fakeModel);

    const result = resolveModel(makeSettings({ llmProvider: 'chatgpt-subscription', llmModel: 'gpt-5.4' }));
    expect(mockGetModel).toHaveBeenCalledWith('openai-codex', 'gpt-5.4');
    expect(result).toBe(fakeModel);
  });

  it('uses overrideModel when provided for chatgpt-subscription', () => {
    const fakeModel = makeFakeModel({ id: 'gpt-5.3-codex' });
    mockGetModel.mockReturnValueOnce(fakeModel);

    const result = resolveModel(
      makeSettings({ llmProvider: 'chatgpt-subscription', llmModel: 'gpt-5.4' }),
      'gpt-5.3-codex',
    );
    expect(mockGetModel).toHaveBeenCalledWith('openai-codex', 'gpt-5.3-codex');
  });

  it('defaults to gpt-5.4 for chatgpt-subscription without override', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    resolveModel(makeSettings({ llmProvider: 'chatgpt-subscription', llmModel: 'whatever' }));
    expect(mockGetModel).toHaveBeenCalledWith('openai-codex', 'gpt-5.4');
  });

  it('maps anthropic provider correctly', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    resolveModel(makeSettings({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514' }));
    expect(mockGetModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-20250514');
  });

  it('maps gemini provider correctly', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    resolveModel(makeSettings({ llmProvider: 'gemini', llmModel: 'gemini-2.5-pro' }));
    expect(mockGetModel).toHaveBeenCalledWith('google', 'gemini-2.5-pro');
  });

  it('returns inline Model for custom provider', () => {
    const result = resolveModel(
      makeSettings({ llmProvider: 'custom', llmModel: 'local-llama', llmBaseUrl: 'http://localhost:8080/v1' }),
    );
    expect(result.api).toBe('openai-completions');
    expect(result.provider).toBe('custom');
    expect(result.id).toBe('local-llama');
    expect(result.baseUrl).toBe('http://localhost:8080/v1');
    // Should NOT call getModel for custom
    expect(mockGetModel).not.toHaveBeenCalled();
  });

  it('uses overrideModel for openai provider', () => {
    mockGetModel.mockReturnValueOnce(undefined);

    resolveModel(makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }), 'gpt-4o-mini');
    expect(mockGetModel).toHaveBeenCalledWith('openai', 'gpt-4o-mini');
  });
});

describe('getSecurityReviewModels', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns two different models for chatgpt-subscription', () => {
    const model1 = makeFakeModel({ id: 'gpt-5.4', provider: 'openai-codex' });
    const model2 = makeFakeModel({ id: 'gpt-5.3-codex', provider: 'openai-codex' });
    mockGetModel.mockReturnValueOnce(model1).mockReturnValueOnce(model2);

    const [m1, m2] = getSecurityReviewModels(
      makeSettings({ llmProvider: 'chatgpt-subscription' }),
    );

    expect(m1.id).toBe('gpt-5.4');
    expect(m2.id).toBe('gpt-5.3-codex');
    expect(m1.id).not.toBe(m2.id);
  });

  it('returns same model for openai provider', () => {
    const fakeModel = makeFakeModel({ id: 'gpt-4o' });
    mockGetModel.mockReturnValue(fakeModel);

    const [m1, m2] = getSecurityReviewModels(
      makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }),
    );

    expect(m1.id).toBe('gpt-4o');
    expect(m2.id).toBe('gpt-4o');
  });

  it('returns same model for anthropic provider', () => {
    const fakeModel = makeFakeModel({ id: 'claude-sonnet-4-20250514', provider: 'anthropic' });
    mockGetModel.mockReturnValue(fakeModel);

    const [m1, m2] = getSecurityReviewModels(
      makeSettings({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514' }),
    );

    expect(m1.id).toBe('claude-sonnet-4-20250514');
    expect(m2.id).toBe('claude-sonnet-4-20250514');
  });
});

describe('mapUsage', () => {
  it('correctly maps all fields', () => {
    const msg = {
      role: 'assistant' as const,
      content: [],
      api: 'openai-responses',
      provider: 'openai',
      model: 'gpt-4o',
      usage: {
        input: 500,
        output: 200,
        cacheRead: 50,
        cacheWrite: 10,
        totalTokens: 760,
        cost: { input: 0.01, output: 0.02, cacheRead: 0.001, cacheWrite: 0.0002, total: 0.0312 },
      },
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    };

    const result = mapUsage(msg, 'task-1', 'explore');

    expect(result).toEqual({
      taskId: 'task-1',
      purpose: 'explore',
      provider: 'openai',
      model: 'gpt-4o',
      inputTokens: 500,
      outputTokens: 200,
      cachedTokens: 50,
      costUsd: 0.0312,
    });
  });

  it('handles different purposes', () => {
    const msg = {
      role: 'assistant' as const,
      content: [],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      usage: {
        input: 100,
        output: 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 150,
        cost: { input: 0.005, output: 0.003, cacheRead: 0, cacheWrite: 0, total: 0.008 },
      },
      stopReason: 'stop' as const,
      timestamp: Date.now(),
    };

    const result = mapUsage(msg, 'task-2', 'security_review');
    expect(result.purpose).toBe('security_review');
    expect(result.provider).toBe('anthropic');
  });
});

describe('extractAccountId', () => {
  it('extracts chatgpt_account_id from JWT payload', () => {
    // JWT structure: header.payload.signature
    const payload = { chatgpt_account_id: 'acct_abc123', sub: 'user_xyz' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    const result = extractAccountId(fakeJwt);
    expect(result).toBe('acct_abc123');
  });

  it('returns undefined when chatgpt_account_id is missing', () => {
    const payload = { sub: 'user_xyz' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeJwt = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    const result = extractAccountId(fakeJwt);
    expect(result).toBeUndefined();
  });

  it('returns undefined for malformed JWT', () => {
    const result = extractAccountId('not-a-jwt');
    expect(result).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    const result = extractAccountId('');
    expect(result).toBeUndefined();
  });
});

describe('refreshCodexToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('calls fetch with correct params', async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: 3600,
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await refreshCodexToken('old-refresh-token');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/x-www-form-urlencoded',
        }),
      }),
    );

    // Check the body contains the expected params
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = callArgs[1].body;
    expect(body).toContain('grant_type=refresh_token');
    expect(body).toContain('refresh_token=old-refresh-token');
    expect(body).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
  });

  it('returns parsed credentials', async () => {
    const payload = { chatgpt_account_id: 'acct_test123' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeAccessToken = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: fakeAccessToken,
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    };
    globalThis.fetch = vi.fn().mockResolvedValue(mockResponse);

    const result = await refreshCodexToken('old-refresh');

    expect(result.access).toBe(fakeAccessToken);
    expect(result.refresh).toBe('new-refresh');
    expect(result.accountId).toBe('acct_test123');
    expect(typeof result.expires).toBe('number');
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: vi.fn().mockResolvedValue('invalid token'),
    });

    await expect(refreshCodexToken('bad-token')).rejects.toThrow();
  });
});

describe('getCodexApiKey', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns cached token if not expired', async () => {
    const creds: OAuthCredentials = {
      access: 'valid-access',
      refresh: 'valid-refresh',
      expires: Date.now() + 60_000, // expires in 60s
      accountId: 'acct_123',
    };

    const loadDecrypted = vi.fn().mockResolvedValue(creds);
    const saveEncrypted = vi.fn().mockResolvedValue(undefined);

    const result = await getCodexApiKey(loadDecrypted, saveEncrypted);

    expect(result).toBe('valid-access');
    expect(loadDecrypted).toHaveBeenCalledOnce();
    expect(saveEncrypted).not.toHaveBeenCalled();
  });

  it('refreshes if expired', async () => {
    const expiredCreds: OAuthCredentials = {
      access: 'old-access',
      refresh: 'old-refresh',
      expires: Date.now() - 1000, // expired 1s ago
      accountId: 'acct_123',
    };

    const payload = { chatgpt_account_id: 'acct_123' };
    const base64Payload = btoa(JSON.stringify(payload));
    const newAccess = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: newAccess,
        refresh_token: 'new-refresh',
        expires_in: 3600,
      }),
    });

    const loadDecrypted = vi.fn().mockResolvedValue(expiredCreds);
    const saveEncrypted = vi.fn().mockResolvedValue(undefined);

    const result = await getCodexApiKey(loadDecrypted, saveEncrypted);

    expect(result).toBe(newAccess);
    expect(saveEncrypted).toHaveBeenCalledOnce();
    const savedCreds = saveEncrypted.mock.calls[0][0] as OAuthCredentials;
    expect(savedCreds.access).toBe(newAccess);
    expect(savedCreds.refresh).toBe('new-refresh');
  });

  it('mutex prevents concurrent refresh', async () => {
    const expiredCreds: OAuthCredentials = {
      access: 'old-access',
      refresh: 'old-refresh',
      expires: Date.now() - 1000,
      accountId: 'acct_123',
    };

    const payload = { chatgpt_account_id: 'acct_123' };
    const base64Payload = btoa(JSON.stringify(payload));
    const newAccess = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    let resolveRefresh!: (value: unknown) => void;
    const fetchPromise = new Promise((resolve) => {
      resolveRefresh = resolve;
    });

    globalThis.fetch = vi.fn().mockReturnValue(fetchPromise);

    const loadDecrypted = vi.fn().mockResolvedValue(expiredCreds);
    const saveEncrypted = vi.fn().mockResolvedValue(undefined);

    // Start two concurrent calls
    const p1 = getCodexApiKey(loadDecrypted, saveEncrypted);
    const p2 = getCodexApiKey(loadDecrypted, saveEncrypted);

    // Resolve the fetch
    resolveRefresh({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: newAccess,
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
    });

    const [r1, r2] = await Promise.all([p1, p2]);

    // Both should return the same token
    expect(r1).toBe(newAccess);
    expect(r2).toBe(newAccess);

    // fetch should only be called once (mutex)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('throws when loadDecrypted returns null', async () => {
    const loadDecrypted = vi.fn().mockResolvedValue(null);
    const saveEncrypted = vi.fn();

    await expect(getCodexApiKey(loadDecrypted, saveEncrypted)).rejects.toThrow();
  });
});
