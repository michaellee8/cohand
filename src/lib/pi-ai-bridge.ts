import { getModel } from '@mariozechner/pi-ai';
import type { AssistantMessage } from '@mariozechner/pi-ai';
import type { Settings } from '../types';
import type { LlmUsageRecord } from '../types/notification';
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from '../constants';

// ---------------------------------------------------------------------------
// Local Model type (avoids importing the complex generic Model<TApi> from pi-ai)
// ---------------------------------------------------------------------------

export interface ModelLike {
  id: string;
  name: string;
  api: string;
  provider: string;
  baseUrl: string;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

// ---------------------------------------------------------------------------
// OAuth credentials shape
// ---------------------------------------------------------------------------

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

// ---------------------------------------------------------------------------
// Default base URLs per provider
// ---------------------------------------------------------------------------

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api/codex',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

// ---------------------------------------------------------------------------
// getModelSafe
// ---------------------------------------------------------------------------

/**
 * Try pi-ai's `getModel()`; fall back to an inline Model with sensible defaults.
 */
export function getModelSafe(
  provider: string,
  api: string,
  modelId: string,
): ModelLike {
  const registered = getModel(provider as any, modelId as any);
  if (registered) return registered as unknown as ModelLike;

  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: DEFAULT_BASE_URLS[provider] ?? '',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

// ---------------------------------------------------------------------------
// resolveModel
// ---------------------------------------------------------------------------

/**
 * Map cohand's Settings.llmProvider to a pi-ai provider/API pair and resolve
 * the model.
 */
export function resolveModel(
  settings: Settings,
  overrideModel?: string,
): ModelLike {
  const modelId = overrideModel ?? settings.llmModel;

  switch (settings.llmProvider) {
    case 'openai':
      return getModelSafe('openai', 'openai-responses', modelId);

    case 'chatgpt-subscription':
      return getModelSafe(
        'openai-codex',
        'openai-codex-responses',
        overrideModel ?? 'gpt-5.4',
      );

    case 'anthropic':
      return getModelSafe('anthropic', 'anthropic-messages', modelId);

    case 'gemini':
      return getModelSafe('google', 'google-generative-ai', modelId);

    case 'custom':
      return {
        id: modelId,
        name: modelId,
        api: 'openai-completions',
        provider: 'custom',
        baseUrl: settings.llmBaseUrl ?? '',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      };
  }
}

// ---------------------------------------------------------------------------
// getSecurityReviewModels
// ---------------------------------------------------------------------------

/**
 * Return `[Model, Model]` for dual-model security review.
 * ChatGPT subscription uses two different model families; other providers
 * use the same model twice (fresh contexts).
 */
export function getSecurityReviewModels(
  settings: Settings,
): [ModelLike, ModelLike] {
  if (settings.llmProvider === 'chatgpt-subscription') {
    return [
      resolveModel(settings, 'gpt-5.4'),
      resolveModel(settings, 'gpt-5.3-codex'),
    ];
  }

  const model = resolveModel(settings);
  return [model, model];
}

// ---------------------------------------------------------------------------
// mapUsage
// ---------------------------------------------------------------------------

/**
 * Map a pi-ai AssistantMessage's usage to cohand's LlmUsageRecord shape.
 */
export function mapUsage(
  msg: AssistantMessage,
  taskId: string,
  purpose: LlmUsageRecord['purpose'],
): Omit<LlmUsageRecord, 'id' | 'createdAt'> {
  return {
    taskId,
    purpose,
    provider: msg.provider,
    model: msg.model,
    inputTokens: msg.usage.input,
    outputTokens: msg.usage.output,
    cachedTokens: msg.usage.cacheRead,
    costUsd: msg.usage.cost.total,
  };
}

// ---------------------------------------------------------------------------
// extractAccountId
// ---------------------------------------------------------------------------

/**
 * Parse a JWT access token and extract the `chatgpt_account_id` claim.
 * Returns `undefined` on any failure.
 */
export function extractAccountId(accessToken: string): string | undefined {
  try {
    const parts = accessToken.split('.');
    if (parts.length < 2) return undefined;
    const payload = JSON.parse(atob(parts[1]));
    return payload.chatgpt_account_id ?? undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// refreshCodexToken
// ---------------------------------------------------------------------------

/**
 * Browser-safe token refresh via direct fetch (no import from pi-ai/oauth).
 */
export async function refreshCodexToken(
  refreshToken: string,
): Promise<OAuthCredentials> {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CODEX_CLIENT_ID,
  });

  const res = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  const access: string = data.access_token;
  const refresh: string = data.refresh_token;
  const expiresIn: number = data.expires_in;

  return {
    access,
    refresh,
    expires: Date.now() + expiresIn * 1000,
    accountId: extractAccountId(access) ?? '',
  };
}

// ---------------------------------------------------------------------------
// getCodexApiKey
// ---------------------------------------------------------------------------

/** Single in-flight refresh promise (mutex). */
let refreshPromise: Promise<OAuthCredentials> | null = null;

/**
 * Get a valid Codex API key. Checks expiry and refreshes if needed.
 * Uses a mutex so only one refresh is in-flight at a time.
 */
export async function getCodexApiKey(
  loadDecrypted: () => Promise<OAuthCredentials | null>,
  saveEncrypted: (creds: OAuthCredentials) => Promise<void>,
): Promise<string> {
  const creds = await loadDecrypted();
  if (!creds) {
    throw new Error('No Codex OAuth credentials found');
  }

  // Token still valid (with 30s buffer)
  if (creds.expires > Date.now() + 30_000) {
    return creds.access;
  }

  // Need to refresh — use mutex
  if (!refreshPromise) {
    refreshPromise = refreshCodexToken(creds.refresh)
      .then(async (newCreds) => {
        await saveEncrypted(newCreds);
        return newCreds;
      })
      .finally(() => {
        refreshPromise = null;
      });
  }

  const newCreds = await refreshPromise;
  return newCreds.access;
}
