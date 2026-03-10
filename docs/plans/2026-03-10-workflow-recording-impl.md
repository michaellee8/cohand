# Workflow Recording & Codex OAuth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Implement workflow recording, Codex OAuth, and pi-ai LLM migration as designed in `docs/plans/2026-03-10-workflow-recording-design.md`.

**Architecture:** Chrome MV3 extension (WXT + React 19 + Zustand). Content script captures user actions, service worker enriches with screenshots, sidepanel manages state and LLM calls. LLM calls migrate from OpenAI SDK wrapper (`LLMClient`) to `@mariozechner/pi-ai`. OAuth uses `declarativeNetRequest` redirect + PKCE.

**Tech Stack:** TypeScript, WXT, React 19, Zustand 5, Tailwind v4, `@mariozechner/pi-ai`, IndexedDB, Web Speech API, `chrome.declarativeNetRequest`

**Dependency graph (task numbers):**
```
1 → 2 → 3 → 4 → 5 → 6
         3 → 7 → 8
              7 → 9
1 → 10 → 11
1 → 12 → 13 → 14 → 15
     12 → 16 → 17 → 18 → 19 → 20
                              20 → 21
```

---

### Task 1: Build Configuration & Dependencies

**Files:**
- Modify: `package.json`
- Modify: `wxt.config.ts`
- Create: `vitest.config.ts`

**Step 1: Install pi-ai and create vitest config**

```bash
cd /home/sb1/repos/cohand
npm install @mariozechner/pi-ai
```

**Step 2: Create vitest.config.ts**

```typescript
// vitest.config.ts
import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  test: {
    environment: 'happy-dom',
    ssr: {
      noExternal: ['@mariozechner/pi-ai'],
    },
  },
});
```

**Step 3: Update wxt.config.ts — add permissions and oauth-callback entrypoint**

Add `'declarativeNetRequest'` and `'webNavigation'` to manifest.permissions. Add `web_accessible_resources` entry:

```typescript
// In manifest object, after existing permissions array:
permissions: [
  'debugger', 'sidePanel', 'storage', 'activeTab', 'scripting',
  'tabs', 'tabGroups', 'alarms', 'notifications', 'offscreen',
  'unlimitedStorage', 'declarativeNetRequest', 'webNavigation',
],
// Add after sandbox:
web_accessible_resources: [{
  resources: ['oauth-callback.html'],
  matches: ['http://localhost/*'],
}],
```

**Step 4: Update package.json test script**

Replace the placeholder test script:
```json
"test": "vitest run",
"test:watch": "vitest"
```

**Step 5: Remove direct openai dependency**

```bash
npm uninstall openai
```

Note: `openai` remains as a transitive dependency of `@mariozechner/pi-ai`.

**Step 6: Verify build still works**

```bash
npx wxt build
```

**Step 7: Commit**

```bash
git add package.json package-lock.json wxt.config.ts vitest.config.ts
git commit -m "build: add pi-ai, vitest config, new manifest permissions"
```

---

### Task 2: Recording & OAuth Type Definitions

**Files:**
- Create: `src/types/recording.ts`
- Modify: `src/types/storage.ts`
- Modify: `src/types/script.ts`
- Modify: `src/types/index.ts`
- Modify: `src/constants.ts`

**Step 1: Create src/types/recording.ts**

```typescript
// src/types/recording.ts

export interface A11yNode {
  role: string;
  name?: string;
  children?: A11yNode[];
  [key: string]: unknown;
}

export interface RawRecordingAction {
  action: 'click' | 'type' | 'navigate';
  timestamp: number;
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: A11yNode;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
}

export interface RecordingStep {
  id: string;
  recordingId: string;
  sequenceIndex: number;
  status: 'raw' | 'enriched' | 'described';
  action: 'click' | 'type' | 'navigate' | 'narration';
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: A11yNode;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
  screenshot?: string;
  speechTranscript?: string;
  description?: string;
}

export interface RecordingSession {
  id: string;
  startedAt: string;
  completedAt?: string;
  activeTabId: number;
  trackedTabs: number[];
  pageSnapshots: Record<string, A11yNode>;
  steps: RecordingStep[];
  generatedTaskId?: string;
}

export interface RecordingRecord {
  id: string;
  startedAt: string;
  completedAt?: string;
  activeTabId: number;
  trackedTabs: number[];
  stepCount: number;
  generatedTaskId?: string;
}

export interface RecordingStepRecord {
  id: string;
  recordingId: string;
  sequenceIndex: number;
  timestamp: number;
  action: 'click' | 'type' | 'navigate' | 'narration';
  selector?: string;
  elementTag?: string;
  elementText?: string;
  elementAttributes?: Record<string, string>;
  elementRole?: string;
  a11ySubtree?: unknown;
  typedText?: string;
  url?: string;
  pageTitle?: string;
  viewportDimensions?: { width: number; height: number };
  clickPositionHint?: { x: number; y: number };
  speechTranscript?: string;
  description?: string;
}

export interface RecordingPageSnapshot {
  id: string;
  recordingId: string;
  snapshotKey: string;
  url: string;
  tree: unknown;
  capturedAt: string;
}

export interface EncryptedCodexOAuth {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}
```

**Step 2: Update src/types/storage.ts — add codexOAuthTokens**

Add to `StorageLocal` interface:
```typescript
export interface StorageLocal {
  _storageSchemaVersion: number;
  settings: Settings;
  encryptedTokens: EncryptedTokens;
  domainPermissions: DomainPermission[];
  codexOAuthTokens?: EncryptedCodexOAuth;
}
```

Add import of `EncryptedCodexOAuth` from `'./recording'`.

**Step 3: Update src/types/script.ts — extend generatedBy**

```typescript
generatedBy: 'explorer' | 'repair' | 'user_edit' | 'recording';
// Add optional field:
recordingId?: string;
```

**Step 4: Update src/types/index.ts — export recording types**

```typescript
export * from './recording';
```

**Step 5: Update src/constants.ts — bump DB_VERSION, add recording constants**

```typescript
export const DB_VERSION = 2;
export const MAX_PAGE_SNAPSHOTS = 20;
export const MAX_SNAPSHOT_SIZE = 50 * 1024; // 50KB
export const MAX_A11Y_DEPTH = 5;
export const CLICK_DEDUP_MS = 300;
export const SPEECH_ASSOCIATION_WINDOW_MS = 3000;
export const OAUTH_RULE_ID = 99999;
export const OAUTH_RULE_CHECK_INTERVAL_MS = 30_000;
export const OAUTH_RULE_MAX_LIFETIME_MS = 5 * 60 * 1000;
export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_REDIRECT_URI = 'http://localhost:1455/auth/callback';
export const CODEX_AUTH_URL = 'https://auth.openai.com/oauth/authorize';
export const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token';
```

**Step 6: Commit**

```bash
git add src/types/ src/constants.ts
git commit -m "feat: add recording and OAuth type definitions"
```

---

### Task 3: pi-ai Bridge Module

**Files:**
- Create: `src/lib/pi-ai-bridge.ts`
- Create: `src/lib/pi-ai-bridge.test.ts`

**Step 1: Write failing tests for resolveModel and getModelSafe**

```typescript
// src/lib/pi-ai-bridge.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Settings } from '../types';

// Mock pi-ai's getModel
const mockGetModel = vi.fn();
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: mockGetModel,
}));

import { resolveModel, getModelSafe, getSecurityReviewModels, mapUsage } from './pi-ai-bridge';

function makeSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    llmProvider: 'openai',
    llmModel: 'gpt-4o',
    yoloMode: false,
    language: 'en',
    ...overrides,
  };
}

describe('getModelSafe', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns registered model when getModel finds it', () => {
    const registered = { id: 'gpt-4o', name: 'GPT-4o', api: 'openai-responses', provider: 'openai' };
    mockGetModel.mockReturnValueOnce(registered);
    const result = getModelSafe('openai', 'openai-responses', 'gpt-4o');
    expect(result).toBe(registered);
  });

  it('returns fallback model when getModel returns undefined', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const result = getModelSafe('openai', 'openai-responses', 'my-custom-model');
    expect(result.id).toBe('my-custom-model');
    expect(result.api).toBe('openai-responses');
    expect(result.provider).toBe('openai');
    expect(result.contextWindow).toBe(128000);
  });
});

describe('resolveModel', () => {
  beforeEach(() => vi.clearAllMocks());

  it('resolves openai provider to openai-responses API', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const model = resolveModel(makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }));
    expect(model.api).toBe('openai-responses');
    expect(model.id).toBe('gpt-4o');
  });

  it('resolves chatgpt-subscription to openai-codex-responses API', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const model = resolveModel(makeSettings({ llmProvider: 'chatgpt-subscription' }));
    expect(model.api).toBe('openai-codex-responses');
  });

  it('resolves anthropic to anthropic-messages API', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const model = resolveModel(makeSettings({ llmProvider: 'anthropic', llmModel: 'claude-sonnet-4-20250514' }));
    expect(model.api).toBe('anthropic-messages');
  });

  it('resolves gemini to google-generative-ai API', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const model = resolveModel(makeSettings({ llmProvider: 'gemini', llmModel: 'gemini-2.5-pro' }));
    expect(model.api).toBe('google-generative-ai');
  });

  it('resolves custom to openai-completions API with custom baseUrl', () => {
    const model = resolveModel(makeSettings({
      llmProvider: 'custom',
      llmModel: 'local-llama',
      llmBaseUrl: 'http://localhost:8080/v1',
    }));
    expect(model.api).toBe('openai-completions');
    expect(model.baseUrl).toBe('http://localhost:8080/v1');
  });

  it('uses overrideModel when provided', () => {
    mockGetModel.mockReturnValueOnce(undefined);
    const model = resolveModel(makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }), 'gpt-5.4');
    expect(model.id).toBe('gpt-5.4');
  });
});

describe('getSecurityReviewModels', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns two different models for chatgpt-subscription', () => {
    mockGetModel.mockReturnValue(undefined);
    const [m1, m2] = getSecurityReviewModels(makeSettings({ llmProvider: 'chatgpt-subscription' }));
    expect(m1.id).toBe('gpt-5.4');
    expect(m2.id).toBe('gpt-5.3-codex');
  });

  it('returns same model twice for API key providers', () => {
    mockGetModel.mockReturnValue(undefined);
    const [m1, m2] = getSecurityReviewModels(makeSettings({ llmProvider: 'openai', llmModel: 'gpt-4o' }));
    expect(m1.id).toBe(m2.id);
  });
});

describe('mapUsage', () => {
  it('maps pi-ai AssistantMessage.usage to LlmUsageRecord fields', () => {
    const msg = {
      provider: 'openai',
      model: 'gpt-4o',
      usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.005 } },
    } as any;
    const record = mapUsage(msg, 'task-1', 'chat');
    expect(record.taskId).toBe('task-1');
    expect(record.purpose).toBe('chat');
    expect(record.inputTokens).toBe(100);
    expect(record.outputTokens).toBe(50);
    expect(record.cachedTokens).toBe(10);
    expect(record.costUsd).toBe(0.005);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx vitest run src/lib/pi-ai-bridge.test.ts
```
Expected: FAIL — module `./pi-ai-bridge` not found.

**Step 3: Implement pi-ai-bridge.ts**

```typescript
// src/lib/pi-ai-bridge.ts
import { getModel } from '@mariozechner/pi-ai';
import type { Settings } from '../types';
import { CODEX_CLIENT_ID, CODEX_TOKEN_URL } from '../constants';
import { importKey, decrypt, encrypt } from './crypto';
import { getEncryptionKeyEncoded } from './storage';

// ============================================================================
// Model Resolution
// ============================================================================

type Api = string;

interface ModelLike {
  id: string;
  name: string;
  api: Api;
  provider: string;
  baseUrl?: string;
  reasoning: boolean;
  input: string[];
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

const DEFAULT_BASE_URLS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  'openai-codex': 'https://chatgpt.com/backend-api/codex',
  anthropic: 'https://api.anthropic.com/v1',
  google: 'https://generativelanguage.googleapis.com/v1beta',
};

export function getModelSafe(provider: string, api: Api, modelId: string): ModelLike {
  const registered = getModel(provider as any, modelId as any);
  if (registered) return registered as unknown as ModelLike;
  return {
    id: modelId,
    name: modelId,
    api,
    provider,
    baseUrl: DEFAULT_BASE_URLS[provider],
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}

export function resolveModel(settings: Settings, overrideModel?: string): ModelLike {
  const modelId = overrideModel ?? settings.llmModel;
  switch (settings.llmProvider) {
    case 'openai':
      return getModelSafe('openai', 'openai-responses', modelId);
    case 'chatgpt-subscription':
      return getModelSafe('openai-codex', 'openai-codex-responses', overrideModel ?? 'gpt-5.4');
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
        baseUrl: settings.llmBaseUrl,
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 16384,
      };
  }
}

// ============================================================================
// Security Review Models
// ============================================================================

export function getSecurityReviewModels(settings: Settings): [ModelLike, ModelLike] {
  if (settings.llmProvider === 'chatgpt-subscription') {
    return [
      getModelSafe('openai-codex', 'openai-codex-responses', 'gpt-5.4'),
      getModelSafe('openai-codex', 'openai-codex-responses', 'gpt-5.3-codex'),
    ];
  }
  const model = resolveModel(settings);
  return [model, model];
}

// ============================================================================
// Usage Mapping
// ============================================================================

export interface LlmUsageRecord {
  id: string;
  taskId: string;
  purpose: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  costUsd: number;
  createdAt: string;
}

export function mapUsage(
  msg: { provider: string; model: string; usage: { input: number; output: number; cacheRead: number; cost: { total: number } } },
  taskId: string,
  purpose: string,
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

// ============================================================================
// Codex OAuth Token Refresh (browser-safe, no pi-ai/oauth import)
// ============================================================================

export interface OAuthCredentials {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
}

export function extractAccountId(accessToken: string): string {
  const payload = JSON.parse(atob(accessToken.split('.')[1]));
  return payload['https://api.openai.com/auth']?.chatgpt_account_id ?? '';
}

export async function refreshCodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CODEX_CLIENT_ID,
    }),
  });
  if (!response.ok) throw new Error('Failed to refresh Codex OAuth token');
  const json = await response.json();
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

// Refresh mutex: single in-flight refresh promise
let refreshPromise: Promise<OAuthCredentials> | null = null;

export async function getCodexApiKey(
  loadDecrypted: () => Promise<OAuthCredentials | null>,
  saveEncrypted: (creds: OAuthCredentials) => Promise<void>,
): Promise<string> {
  const stored = await loadDecrypted();
  if (!stored) throw new Error('Not logged in to ChatGPT');
  if (Date.now() < stored.expires) return stored.access;

  if (!refreshPromise) {
    refreshPromise = refreshCodexToken(stored.refresh).finally(() => {
      refreshPromise = null;
    });
  }
  const refreshed = await refreshPromise;
  await saveEncrypted(refreshed);
  return refreshed.access;
}
```

**Step 4: Run tests to verify they pass**

```bash
npx vitest run src/lib/pi-ai-bridge.test.ts
```
Expected: PASS

**Step 5: Commit**

```bash
git add src/lib/pi-ai-bridge.ts src/lib/pi-ai-bridge.test.ts
git commit -m "feat: add pi-ai bridge with model resolution, usage mapping, token refresh"
```

---

### Task 4: Migrate explorer.ts to pi-ai

**Files:**
- Modify: `src/lib/explorer.ts`
- Modify: `src/lib/explorer.test.ts` (if exists, update mocks)

**Step 1: Update explorer.ts imports and function signatures**

Replace:
```typescript
import { LLMClient } from './llm-client';
```
With:
```typescript
import { complete } from '@mariozechner/pi-ai';
import type { Settings } from '../types';
```

Change `generateScript` signature from `(client: LLMClient, ...)` to:
```typescript
export async function generateScript(
  model: any,
  apiKey: string,
  description: string,
  observation: ExplorationResult,
  domains: string[],
  opts?: { transport?: string },
): Promise<ScriptGenerationResult> {
```

Replace `client.chat(messages as any)` body with:
```typescript
  const messages = buildGenerationMessages({ description, url: observation.url, domains, a11yTree: observation.a11yTree, screenshot: observation.screenshot });
  const context = messages.map(m => ({
    role: m.role as 'system' | 'user',
    content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
  }));
  const result = await complete(model, context, { apiKey, ...opts });
  const source = cleanScriptSource(result.content ?? '');
  const validation = validateAST(source);
  return { source, astValid: validation.valid, astErrors: validation.errors };
```

**Step 2: Update repairScript similarly**

Change signature from `(client: LLMClient, params)` to `(model: any, apiKey: string, params)`.

Replace `client.chat(messages)` with `complete(model, context, { apiKey })`.

**Step 3: Run existing explorer tests**

```bash
npx vitest run src/lib/explorer.test.ts
```

Fix any import/mock issues.

**Step 4: Commit**

```bash
git add src/lib/explorer.ts src/lib/explorer.test.ts
git commit -m "refactor: migrate explorer.ts from LLMClient to pi-ai complete()"
```

---

### Task 5: Migrate security-review.ts to pi-ai

**Files:**
- Modify: `src/lib/security/security-review.ts`
- Modify: `src/lib/security/security-review.test.ts` (if exists)

**Step 1: Update security-review.ts**

Replace:
```typescript
import type { LLMClient } from '../llm-client';
```
With:
```typescript
import { complete } from '@mariozechner/pi-ai';
```

Change `securityReview` signature:
```typescript
export async function securityReview(
  source: string,
  models: [any, any],
  apiKey: string,
  previousApprovedSource?: string,
): Promise<SecurityReviewResult> {
  const [model1, model2] = models;
  const [result1, result2] = await Promise.all([
    runSingleReview(source, model1, apiKey, 'data_flow', previousApprovedSource),
    runSingleReview(source, model2, apiKey, 'capability', previousApprovedSource),
  ]);
  return { approved: result1.approved && result2.approved, details: [result1, result2] };
}
```

Change `runSingleReview`:
```typescript
async function runSingleReview(
  source: string,
  model: any,
  apiKey: string,
  promptType: 'data_flow' | 'capability',
  previousApprovedSource?: string,
): Promise<ReviewDetail> {
  const messages = buildReviewMessages(source, promptType, previousApprovedSource);
  try {
    const result = await complete(model, messages, { apiKey });
    const parsed = JSON.parse(result.content ?? '{}');
    if (typeof parsed.approved !== 'boolean') {
      return { model: model.id, approved: false, issues: ['Malformed review response'] };
    }
    return { model: model.id, approved: parsed.approved, issues: Array.isArray(parsed.issues) ? parsed.issues : [] };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { model: model.id, approved: false, issues: [`Review error: ${message}`] };
  }
}
```

**Step 2: Run security review tests**

```bash
npx vitest run src/lib/security/security-review.test.ts
```

**Step 3: Commit**

```bash
git add src/lib/security/security-review.ts src/lib/security/security-review.test.ts
git commit -m "refactor: migrate security-review.ts from LLMClient to pi-ai complete()"
```

---

### Task 6: Migrate chat-store.ts and wizard-store.ts to pi-ai

**Files:**
- Modify: `src/entrypoints/sidepanel/stores/chat-store.ts`
- Modify: `src/entrypoints/sidepanel/stores/wizard-store.ts`
- Modify: `src/entrypoints/sidepanel/stores/settings-store.ts`
- Delete: `src/lib/llm-client.ts`
- Delete: `src/lib/llm-client.test.ts`

**Step 1: Update chat-store.ts**

Replace LLMClient import with pi-ai:
```typescript
import { stream as piStream } from '@mariozechner/pi-ai';
import { resolveModel } from '../../../lib/pi-ai-bridge';
```

Replace `client: LLMClient | null` in state with `model: any | null`. Replace `initClient` body:
```typescript
initClient: async () => {
  try {
    const settings = await getSettings();
    const tokens = await getEncryptedTokens();
    let token = '';
    const keyEncoded = await getEncryptionKeyEncoded();
    if (keyEncoded && tokens.apiKey) {
      const key = await importKey(keyEncoded);
      token = await decrypt(key, tokens.apiKey);
    } else if (tokens.apiKey) {
      token = tokens.apiKey;
    }
    if (!token) {
      set({ error: 'No API key configured. Go to Settings to add one.' });
      return;
    }
    const model = resolveModel(settings);
    set({ model, apiKey: token, error: null });
  } catch (err: any) {
    set({ error: `Failed to initialize LLM: ${err.message}` });
  }
},
```

Replace streaming loop in `sendMessage`:
```typescript
const { model, apiKey } = get();
if (!model || !apiKey) { set({ error: 'LLM not initialized' }); return; }
// ... build context from messages ...
let fullContent = '';
const streamResult = piStream(model, context, { apiKey, signal: abortController.signal, transport: 'sse' });
for await (const event of streamResult) {
  if (event.type === 'text') {
    fullContent += event.text;
    // update message in state
  }
}
```

**Step 2: Update wizard-store.ts**

Replace `initLLMClient()` helper with:
```typescript
async function initLLM(): Promise<{ model: any; apiKey: string }> {
  const settings = await getSettings();
  const tokens = await getEncryptedTokens();
  let token = '';
  const keyEncoded = await getEncryptionKeyEncoded();
  if (keyEncoded && tokens.apiKey) {
    const key = await importKey(keyEncoded);
    token = await decrypt(key, tokens.apiKey);
  } else if (tokens.apiKey) { token = tokens.apiKey; }
  if (!token) throw new Error('No API key configured.');
  return { model: resolveModel(settings), apiKey: token };
}
```

Replace `generateScript(client, ...)` call with `generateScript(model, apiKey, ...)`.
Replace `createSecurityReviewClients` with `getSecurityReviewModels` + updated `securityReview(source, models, apiKey)`.

**Step 3: Update settings-store.ts hasApiKey check**

```typescript
// Load codexOAuthTokens too
const codexOAuth = (await chrome.storage.local.get('codexOAuthTokens')).codexOAuthTokens;
set({
  hasApiKey: !!(tokens.apiKey || tokens.oauthToken || codexOAuth?.access),
  // ...
});
```

**Step 4: Delete src/lib/llm-client.ts and src/lib/llm-client.test.ts**

```bash
rm src/lib/llm-client.ts src/lib/llm-client.test.ts
```

**Step 5: Verify no remaining imports of llm-client**

```bash
grep -r "llm-client" src/ --include="*.ts" --include="*.tsx"
```

Fix any remaining references.

**Step 6: Run all tests**

```bash
npx vitest run
```

**Step 7: Commit**

```bash
git add -A
git commit -m "refactor: migrate all LLM callers to pi-ai, delete LLMClient"
```

---

### Task 7: Message Types & IndexedDB v2

**Files:**
- Modify: `src/lib/messages.ts`
- Modify: `src/lib/db.ts`
- Modify: `src/lib/db.test.ts`

**Step 1: Add recording and OAuth message types to messages.ts**

Add to `Message` union:
```typescript
  | { type: 'START_RECORDING'; tabId: number }
  | { type: 'STOP_RECORDING'; sessionId: string }
  | { type: 'OAUTH_CALLBACK'; code: string; state: string }
  | { type: 'START_CODEX_OAUTH' }
  | { type: 'LOGOUT_CODEX' }
```

Add new union type for content script events:
```typescript
export type ContentScriptEvent =
  | { type: 'RECORDING_ACTION'; action: import('../types/recording').RawRecordingAction }
  | { type: 'KEYSTROKE_UPDATE'; text: string; element: { selector: string; tag: string; name?: string }; isFinal: boolean }
  | { type: 'ELEMENT_SELECTION'; elementInfo: Record<string, unknown>; url: string; cancelled?: boolean };

export type RecordingPortMessage =
  | { type: 'RECORDING_STEP'; step: import('../types/recording').RecordingStep }
  | { type: 'PAGE_SNAPSHOT'; url: string; snapshotKey: string; tree: unknown };

export type OAuthMessage =
  | { type: 'OAUTH_CALLBACK'; code: string; state: string };
```

Add to `MessageResponse`:
```typescript
  START_RECORDING: { ok: true; sessionId: string };
  STOP_RECORDING: { ok: true };
  OAUTH_CALLBACK: { ok: true };
  START_CODEX_OAUTH: { ok: true };
  LOGOUT_CODEX: { ok: true };
```

**Step 2: Update db.ts — add v2 migration for recording stores**

```typescript
request.onupgradeneeded = (event) => {
  const db = request.result;
  const old = event.oldVersion;
  if (old < 1) {
    // ... existing v1 stores (unchanged) ...
  }
  if (old < 2) {
    const recordings = db.createObjectStore('recordings', { keyPath: 'id' });
    recordings.createIndex('by_started', 'startedAt');

    const steps = db.createObjectStore('recording_steps', { keyPath: 'id' });
    steps.createIndex('by_recording_seq', ['recordingId', 'sequenceIndex']);
    steps.createIndex('by_recording', 'recordingId');

    const snapshots = db.createObjectStore('recording_page_snapshots', { keyPath: 'id' });
    snapshots.createIndex('by_recording_key', ['recordingId', 'snapshotKey']);
    snapshots.createIndex('by_recording', 'recordingId');
  }
};
```

**Step 3: Write test for v2 migration**

Add to `db.test.ts`:
```typescript
it('creates recording stores in v2', async () => {
  const db = await openDB();
  expect(db.objectStoreNames.contains('recordings')).toBe(true);
  expect(db.objectStoreNames.contains('recording_steps')).toBe(true);
  expect(db.objectStoreNames.contains('recording_page_snapshots')).toBe(true);
  db.close();
});
```

**Step 4: Run tests**

```bash
npx vitest run src/lib/db.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/messages.ts src/lib/db.ts src/lib/db.test.ts
git commit -m "feat: add recording message types and IndexedDB v2 migration"
```

---

### Task 8: IndexedDB Helpers for Recordings

**Files:**
- Modify: `src/lib/db-helpers.ts`
- Modify: `src/lib/db-helpers.test.ts`

**Step 1: Write failing tests for recording helpers**

```typescript
describe('recording helpers', () => {
  it('putRecording stores and getRecording retrieves', async () => {
    const rec = { id: 'rec-1', startedAt: new Date().toISOString(), activeTabId: 1, trackedTabs: [1], stepCount: 0 };
    await putRecording(db, rec);
    const retrieved = await getRecording(db, 'rec-1');
    expect(retrieved?.id).toBe('rec-1');
  });

  it('putRecordingStep stores and getRecordingSteps retrieves in order', async () => {
    const step1 = { id: 's1', recordingId: 'rec-1', sequenceIndex: 0, timestamp: 1000, action: 'click' as const };
    const step2 = { id: 's2', recordingId: 'rec-1', sequenceIndex: 1, timestamp: 2000, action: 'type' as const };
    await putRecordingStep(db, step1);
    await putRecordingStep(db, step2);
    const steps = await getRecordingSteps(db, 'rec-1');
    expect(steps).toHaveLength(2);
    expect(steps[0].id).toBe('s1');
  });

  it('deleteRecordingStep removes a step', async () => {
    await putRecordingStep(db, { id: 's3', recordingId: 'rec-1', sequenceIndex: 2, timestamp: 3000, action: 'navigate' as const });
    await deleteRecordingStep(db, 's3');
    const steps = await getRecordingSteps(db, 'rec-1');
    expect(steps.find(s => s.id === 's3')).toBeUndefined();
  });

  it('putRecordingPageSnapshot stores and retrieves snapshots', async () => {
    const snap = { id: 'snap-1', recordingId: 'rec-1', snapshotKey: 'https://example.com#0', url: 'https://example.com', tree: { role: 'document' }, capturedAt: new Date().toISOString() };
    await putRecordingPageSnapshot(db, snap);
    const snaps = await getRecordingPageSnapshots(db, 'rec-1');
    expect(snaps).toHaveLength(1);
  });
});
```

**Step 2: Run to verify failure**

```bash
npx vitest run src/lib/db-helpers.test.ts
```

**Step 3: Implement helpers in db-helpers.ts**

Add functions: `putRecording`, `getRecording`, `putRecordingStep`, `getRecordingSteps`, `deleteRecordingStep`, `putRecordingPageSnapshot`, `getRecordingPageSnapshots`, `deleteRecording` (cascade deletes steps + snapshots).

Each follows the existing `putTask`/`getTask` pattern with `new Promise((resolve, reject) => { const tx = db.transaction(...) ... })`.

**Step 4: Run tests**

```bash
npx vitest run src/lib/db-helpers.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/db-helpers.ts src/lib/db-helpers.test.ts
git commit -m "feat: add IndexedDB helpers for recordings, steps, and page snapshots"
```

---

### Task 9: Self-Healing Recording Context

**Files:**
- Modify: `src/lib/self-healing.ts`
- Modify: `src/types/script.ts` (already done in Task 2)

**Step 1: Update HealingContext to accept recording data**

Add optional fields to `HealingContext`:
```typescript
export interface HealingContext {
  // ... existing fields ...
  recordingSteps?: import('../types').RecordingStepRecord[];
  recordingSnapshots?: import('../types').RecordingPageSnapshot[];
}
```

**Step 2: Update repairScript call in selfHeal to pass recording context**

In the repair loop, when `task.generatedBy === 'recording'`:
```typescript
const repaired = await ctx.repairScript(
  activeVersion.source,
  failedRun.error || 'Unknown error',
  a11yTree,
  ctx.recordingSteps,   // new param
  ctx.recordingSnapshots, // new param
);
```

**Step 3: Update explorer-prompts.ts REPAIR_PROMPT to include recording context**

Add optional recording context section to `buildRepairMessages`:
```typescript
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
```

**Step 4: Run self-healing tests**

```bash
npx vitest run src/lib/self-healing.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/self-healing.ts src/lib/explorer-prompts.ts
git commit -m "feat: pass recording context to self-healing repair loop"
```

---

### Task 10: OAuth PKCE Flow & declarativeNetRequest

**Files:**
- Create: `src/lib/codex-oauth.ts`
- Create: `src/lib/codex-oauth.test.ts`

**Step 1: Write failing tests**

```typescript
// src/lib/codex-oauth.test.ts
import { describe, it, expect, vi } from 'vitest';
import { generatePKCE, buildAuthUrl, exchangeCodeForToken } from './codex-oauth';

describe('generatePKCE', () => {
  it('returns verifier and challenge strings', async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(verifier).toHaveLength(43); // base64url of 32 bytes
    expect(challenge.length).toBeGreaterThan(0);
    expect(verifier).not.toBe(challenge);
  });
});

describe('buildAuthUrl', () => {
  it('constructs correct authorize URL with all params', () => {
    const url = buildAuthUrl('challenge123', 'state456');
    expect(url).toContain('https://auth.openai.com/oauth/authorize');
    expect(url).toContain('code_challenge=challenge123');
    expect(url).toContain('state=state456');
    expect(url).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(url).toContain('codex_cli_simplified_flow=true');
  });
});
```

**Step 2: Run to verify failure**

```bash
npx vitest run src/lib/codex-oauth.test.ts
```

**Step 3: Implement codex-oauth.ts**

```typescript
// src/lib/codex-oauth.ts
import {
  CODEX_CLIENT_ID, CODEX_REDIRECT_URI, CODEX_AUTH_URL, CODEX_TOKEN_URL,
  OAUTH_RULE_ID, OAUTH_RULE_CHECK_INTERVAL_MS, OAUTH_RULE_MAX_LIFETIME_MS,
} from '../constants';
import { extractAccountId, type OAuthCredentials } from './pi-ai-bridge';

// ============================================================================
// PKCE
// ============================================================================

export async function generatePKCE(): Promise<{ verifier: string; challenge: string }> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const verifier = base64UrlEncode(bytes);
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(hash));
  return { verifier, challenge };
}

function base64UrlEncode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function buildAuthUrl(challenge: string, state: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: CODEX_CLIENT_ID,
    redirect_uri: CODEX_REDIRECT_URI,
    scope: 'openid profile email offline_access',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    codex_cli_simplified_flow: 'true',
  });
  return `${CODEX_AUTH_URL}?${params}`;
}

// ============================================================================
// Token Exchange
// ============================================================================

export async function exchangeCodeForToken(code: string, verifier: string): Promise<OAuthCredentials> {
  const response = await fetch(CODEX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CODEX_CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: CODEX_REDIRECT_URI,
    }),
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  const json = await response.json();
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: extractAccountId(json.access_token),
  };
}

// ============================================================================
// declarativeNetRequest Rule Lifecycle
// ============================================================================

let ruleMonitorInterval: ReturnType<typeof setInterval> | null = null;
let ruleAddedAt = 0;

export async function addOAuthRedirectRule(extensionId: string): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_RULE_ID],
    addRules: [{
      id: OAUTH_RULE_ID,
      priority: 1,
      action: {
        type: chrome.declarativeNetRequest.RuleActionType.REDIRECT,
        redirect: {
          regexSubstitution: `chrome-extension://${extensionId}/oauth-callback.html\\1`,
        },
      },
      condition: {
        regexFilter: '^http://localhost:1455/auth/callback(\\\\?.*)?$',
        resourceTypes: [chrome.declarativeNetRequest.ResourceType.MAIN_FRAME],
      },
    }],
  });
  ruleAddedAt = Date.now();
}

export async function removeOAuthRedirectRule(): Promise<void> {
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [OAUTH_RULE_ID],
  });
  if (ruleMonitorInterval) {
    clearInterval(ruleMonitorInterval);
    ruleMonitorInterval = null;
  }
}

export function startAdaptiveMonitor(authTabId: number): void {
  ruleMonitorInterval = setInterval(async () => {
    // Hard max lifetime
    if (Date.now() - ruleAddedAt > OAUTH_RULE_MAX_LIFETIME_MS) {
      await removeOAuthRedirectRule();
      return;
    }
    // Check if auth tab is still on auth.openai.com
    try {
      const tab = await chrome.tabs.get(authTabId);
      if (!tab.url?.includes('auth.openai.com')) {
        await removeOAuthRedirectRule();
      }
    } catch {
      // Tab closed
      await removeOAuthRedirectRule();
    }
  }, OAUTH_RULE_CHECK_INTERVAL_MS);
}

export async function cleanupStaleOAuthState(): Promise<void> {
  await removeOAuthRedirectRule();
  // Clean stale PKCE state (older than 10 minutes)
  const result = await chrome.storage.local.get('_oauthPkce');
  if (result._oauthPkce?.createdAt && Date.now() - result._oauthPkce.createdAt > 10 * 60 * 1000) {
    await chrome.storage.local.remove('_oauthPkce');
  }
}
```

**Step 4: Run tests**

```bash
npx vitest run src/lib/codex-oauth.test.ts
```

**Step 5: Commit**

```bash
git add src/lib/codex-oauth.ts src/lib/codex-oauth.test.ts
git commit -m "feat: add Codex OAuth PKCE flow with declarativeNetRequest rule lifecycle"
```

---

### Task 11: OAuth Callback Page & Storage Helpers

**Files:**
- Create: `src/entrypoints/oauth-callback/index.html`
- Create: `src/entrypoints/oauth-callback/main.ts`
- Modify: `src/lib/storage.ts`

**Step 1: Create oauth-callback HTML entrypoint**

```html
<!-- src/entrypoints/oauth-callback/index.html -->
<!DOCTYPE html>
<html>
<head><title>Cohand — OAuth</title></head>
<body>
  <p>Completing login...</p>
  <script src="./main.ts" type="module"></script>
</body>
</html>
```

**Step 2: Create oauth-callback main.ts**

```typescript
// src/entrypoints/oauth-callback/main.ts
const params = new URLSearchParams(window.location.search);
const code = params.get('code');
const state = params.get('state');

if (code && state) {
  chrome.runtime.sendMessage({ type: 'OAUTH_CALLBACK', code, state });
  document.body.textContent = 'Login successful! You can close this tab.';
} else {
  document.body.textContent = 'Login failed — missing authorization code.';
}
```

**Step 3: Add OAuth storage helpers to storage.ts**

```typescript
// Codex OAuth token storage
export async function getCodexOAuthTokens(): Promise<import('../types').EncryptedCodexOAuth | null> {
  const result = await chrome.storage.local.get('codexOAuthTokens');
  return result.codexOAuthTokens ?? null;
}

export async function setCodexOAuthTokens(tokens: import('../types').EncryptedCodexOAuth | null): Promise<void> {
  if (tokens) {
    await chrome.storage.local.set({ codexOAuthTokens: tokens });
  } else {
    await chrome.storage.local.remove('codexOAuthTokens');
  }
}
```

**Step 4: Commit**

```bash
git add src/entrypoints/oauth-callback/ src/lib/storage.ts
git commit -m "feat: add OAuth callback page and Codex OAuth storage helpers"
```

---

### Task 12: Content Script Recording Overlay

**Files:**
- Create: `src/lib/recording/element-selector.ts`
- Modify: `src/entrypoints/content.ts`

**Step 1: Create element-selector.ts**

```typescript
// src/lib/recording/element-selector.ts
import { CLICK_DEDUP_MS } from '../../constants';
import type { RawRecordingAction } from '../../types/recording';

const SENSITIVE_PATTERNS = /^(password|passwd|pin|cvv|cvc|ssn|otp|mfa|totp|secret|token)$/i;
const SENSITIVE_AUTOCOMPLETE = /cc-number|cc-csc|cc-exp|new-password|current-password|one-time-code/;

let active = false;
let highlightEl: HTMLDivElement | null = null;
let lastClickTarget: Element | null = null;
let lastClickTime = 0;
let textBuffer = '';
let textTarget: Element | null = null;

export function activate(): void {
  if (active) return;
  active = true;
  document.addEventListener('click', handleClick, true);
  document.addEventListener('keydown', handleKeyDown, true);
  document.addEventListener('focusout', handleFocusOut, true);
  document.addEventListener('mouseover', handleMouseOver, true);
  document.addEventListener('mouseout', handleMouseOut, true);
  createHighlight();
}

export function deactivate(): void {
  if (!active) return;
  active = false;
  document.removeEventListener('click', handleClick, true);
  document.removeEventListener('keydown', handleKeyDown, true);
  document.removeEventListener('focusout', handleFocusOut, true);
  document.removeEventListener('mouseover', handleMouseOver, true);
  document.removeEventListener('mouseout', handleMouseOut, true);
  highlightEl?.remove();
  highlightEl = null;
}

function createHighlight(): void {
  highlightEl = document.createElement('div');
  highlightEl.style.cssText = 'position:fixed;pointer-events:none;border:2px solid #3b82f6;border-radius:3px;z-index:2147483647;transition:all 0.1s;display:none;';
  document.documentElement.appendChild(highlightEl);
}

function handleMouseOver(e: MouseEvent): void {
  const el = e.target as Element;
  if (!highlightEl || el === highlightEl) return;
  const rect = el.getBoundingClientRect();
  Object.assign(highlightEl.style, {
    display: 'block',
    top: `${rect.top}px`, left: `${rect.left}px`,
    width: `${rect.width}px`, height: `${rect.height}px`,
  });
}

function handleMouseOut(): void {
  if (highlightEl) highlightEl.style.display = 'none';
}

function isSensitiveField(el: Element): boolean {
  if (el instanceof HTMLInputElement && el.type === 'password') return true;
  const ac = el.getAttribute('autocomplete') ?? '';
  if (SENSITIVE_AUTOCOMPLETE.test(ac)) return true;
  const nameOrId = (el.getAttribute('name') ?? '') + (el.id ?? '');
  return SENSITIVE_PATTERNS.test(nameOrId);
}

function buildSelector(el: Element): string {
  if (el.id) return `#${CSS.escape(el.id)}`;
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return `[aria-label="${CSS.escape(ariaLabel)}"]`;
  const classes = Array.from(el.classList).slice(0, 2).map(c => `.${CSS.escape(c)}`).join('');
  if (classes) return `${el.tagName.toLowerCase()}${classes}`;
  return el.tagName.toLowerCase();
}

function buildA11ySubtree(el: Element, depth = 3): unknown {
  if (depth <= 0) return null;
  const node: Record<string, unknown> = {
    role: el.getAttribute('role') ?? el.tagName.toLowerCase(),
    name: el.getAttribute('aria-label') ?? el.textContent?.slice(0, 100)?.trim(),
  };
  const children: unknown[] = [];
  for (const child of el.children) {
    const c = buildA11ySubtree(child, depth - 1);
    if (c) children.push(c);
  }
  if (children.length) node.children = children;
  return node;
}

function handleClick(e: MouseEvent): void {
  const el = e.target as Element;
  // Deduplication
  if (el === lastClickTarget && Date.now() - lastClickTime < CLICK_DEDUP_MS) return;
  lastClickTarget = el;
  lastClickTime = Date.now();

  // Flush pending text
  flushTextBuffer();

  const action: RawRecordingAction = {
    action: 'click',
    timestamp: Date.now(),
    selector: buildSelector(el),
    elementTag: el.tagName.toLowerCase(),
    elementText: el.textContent?.slice(0, 200)?.trim(),
    elementAttributes: getAttributes(el),
    elementRole: el.getAttribute('role') ?? undefined,
    a11ySubtree: buildA11ySubtree(el) as any,
    viewportDimensions: { width: window.innerWidth, height: window.innerHeight },
    clickPositionHint: { x: e.clientX, y: e.clientY },
  };
  sendAction(action);
}

function handleKeyDown(e: KeyboardEvent): void {
  const el = e.target as Element;
  if (isSensitiveField(el)) return; // never capture sensitive input

  if (el !== textTarget) {
    flushTextBuffer();
    textTarget = el;
    textBuffer = '';
  }
  if (e.key === 'Backspace') {
    textBuffer = textBuffer.slice(0, -1);
  } else if (e.key.length === 1) {
    textBuffer += e.key;
  }
  // Send update
  chrome.runtime.sendMessage({
    type: 'KEYSTROKE_UPDATE',
    text: textBuffer,
    element: { selector: buildSelector(el), tag: el.tagName.toLowerCase(), name: el.getAttribute('name') ?? undefined },
    isFinal: false,
  });
}

function handleFocusOut(): void {
  flushTextBuffer();
}

function flushTextBuffer(): void {
  if (!textBuffer || !textTarget) return;
  const el = textTarget;
  const action: RawRecordingAction = {
    action: 'type',
    timestamp: Date.now(),
    selector: buildSelector(el),
    elementTag: el.tagName.toLowerCase(),
    typedText: isSensitiveField(el) ? undefined : textBuffer,
    elementAttributes: getAttributes(el),
  };
  if (isSensitiveField(el)) {
    // Still send step, just without the actual text
    action.typedText = undefined;
  }
  sendAction(action);
  textBuffer = '';
  textTarget = null;
}

function getAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const attr of el.attributes) {
    attrs[attr.name] = attr.value;
  }
  return attrs;
}

function sendAction(action: RawRecordingAction): void {
  chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', action });
}
```

**Step 2: Update content.ts to handle recording activation**

Add to the `main()` function in content.ts:
```typescript
import { activate, deactivate } from '@/lib/recording/element-selector';

// In the message listener:
if (msg.type === 'ACTIVATE_RECORDING') {
  activate();
  sendResponse({ ok: true });
  return true;
}
if (msg.type === 'DEACTIVATE_RECORDING') {
  deactivate();
  sendResponse({ ok: true });
  return true;
}
```

**Step 3: Commit**

```bash
git add src/lib/recording/ src/entrypoints/content.ts
git commit -m "feat: add content script recording overlay with click/keystroke capture"
```

---

### Task 13: Voice Narration Module

**Files:**
- Create: `src/lib/recording/speech.ts`

**Step 1: Implement speech.ts**

```typescript
// src/lib/recording/speech.ts
import { SPEECH_ASSOCIATION_WINDOW_MS } from '../../constants';

export interface SpeechResult {
  transcript: string;
  startTime: number;
  endTime: number;
  isFinal: boolean;
}

export type SpeechCallback = (result: SpeechResult) => void;

let recognition: SpeechRecognition | null = null;
let callback: SpeechCallback | null = null;
let segmentStart = 0;

export async function checkMicPermission(): Promise<PermissionState> {
  const result = await navigator.permissions.query({ name: 'microphone' as PermissionName });
  return result.state;
}

export async function requestMicPermission(): Promise<boolean> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    return true;
  } catch {
    return false;
  }
}

export function startSpeechRecognition(onResult: SpeechCallback): void {
  const SpeechRecognition = window.SpeechRecognition || (window as any).webkitSpeechRecognition;
  if (!SpeechRecognition) return;

  callback = onResult;
  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  recognition.onresult = (event: SpeechRecognitionEvent) => {
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (result[0].confidence > 0) {
        if (i === event.resultIndex) segmentStart = Date.now();
        callback?.({
          transcript: result[0].transcript,
          startTime: segmentStart,
          endTime: Date.now(),
          isFinal: result.isFinal,
        });
      }
    }
  };

  recognition.onerror = (event) => {
    console.warn('[Cohand] Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      stopSpeechRecognition();
    }
  };

  recognition.onend = () => {
    // Auto-restart if still active
    if (recognition) {
      try { recognition.start(); } catch { /* already started */ }
    }
  };

  recognition.start();
}

export function stopSpeechRecognition(): void {
  if (recognition) {
    recognition.onend = null; // prevent auto-restart
    recognition.abort();
    recognition = null;
    callback = null;
  }
}

export function pauseSpeechRecognition(): void {
  recognition?.stop();
}

export function resumeSpeechRecognition(): void {
  try { recognition?.start(); } catch { /* already started */ }
}

export function findAssociatedStepIndex(
  speechStartTime: number,
  stepTimestamps: number[],
): number | null {
  for (let i = stepTimestamps.length - 1; i >= 0; i--) {
    if (stepTimestamps[i] <= speechStartTime &&
        speechStartTime - stepTimestamps[i] <= SPEECH_ASSOCIATION_WINDOW_MS) {
      return i;
    }
  }
  return null;
}
```

**Step 2: Commit**

```bash
git add src/lib/recording/speech.ts
git commit -m "feat: add Web Speech API wrapper for voice narration"
```

---

### Task 14: Recording Zustand Store

**Files:**
- Create: `src/entrypoints/sidepanel/stores/recording-store.ts`

**Step 1: Implement recording-store.ts**

```typescript
// src/entrypoints/sidepanel/stores/recording-store.ts
import { create } from 'zustand';
import type { RecordingSession, RecordingStep } from '../../../types/recording';

interface RecordingState {
  isRecording: boolean;
  isPaused: boolean;
  session: RecordingSession | null;
  voiceEnabled: boolean;
  error: string | null;

  startRecording: (tabId: number) => Promise<void>;
  stopRecording: () => Promise<void>;
  togglePause: () => void;
  toggleVoice: () => void;
  removeStep: (stepId: string) => void;
  appendStep: (step: RecordingStep) => void;
  updateStepDescription: (stepId: string, description: string) => void;
  addPageSnapshot: (snapshotKey: string, tree: unknown) => void;
  reset: () => void;
}

export const useRecordingStore = create<RecordingState>((set, get) => ({
  isRecording: false,
  isPaused: false,
  session: null,
  voiceEnabled: false,
  error: null,

  startRecording: async (tabId: number) => {
    const sessionId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const session: RecordingSession = {
      id: sessionId,
      startedAt: new Date().toISOString(),
      activeTabId: tabId,
      trackedTabs: [tabId],
      pageSnapshots: {},
      steps: [],
    };
    set({ isRecording: true, isPaused: false, session, error: null });

    try {
      // Tell service worker to start
      const response = await chrome.runtime.sendMessage({
        type: 'START_RECORDING', tabId,
      });
      if (!response?.ok) throw new Error('Failed to start recording');

      // Activate content script overlay
      await chrome.tabs.sendMessage(tabId, { type: 'ACTIVATE_RECORDING' });
    } catch (err: any) {
      set({ isRecording: false, session: null, error: err.message });
    }
  },

  stopRecording: async () => {
    const { session } = get();
    if (!session) return;

    try {
      // Deactivate content script
      await chrome.tabs.sendMessage(session.activeTabId, { type: 'DEACTIVATE_RECORDING' });
      // Tell service worker
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING', sessionId: session.id });
    } catch {
      // Best effort
    }

    set(state => ({
      isRecording: false,
      isPaused: false,
      session: state.session ? { ...state.session, completedAt: new Date().toISOString() } : null,
    }));
  },

  togglePause: () => set(state => ({ isPaused: !state.isPaused })),
  toggleVoice: () => set(state => ({ voiceEnabled: !state.voiceEnabled })),

  removeStep: (stepId: string) => {
    set(state => {
      if (!state.session) return state;
      const steps = state.session.steps.filter(s => s.id !== stepId);
      return { session: { ...state.session, steps } };
    });
    // Also delete from IndexedDB (fire-and-forget)
    chrome.runtime.sendMessage({ type: 'DELETE_RECORDING_STEP', stepId }).catch(() => {});
  },

  appendStep: (step: RecordingStep) => {
    set(state => {
      if (!state.session) return state;
      return { session: { ...state.session, steps: [...state.session.steps, step] } };
    });
  },

  updateStepDescription: (stepId: string, description: string) => {
    set(state => {
      if (!state.session) return state;
      const steps = state.session.steps.map(s =>
        s.id === stepId ? { ...s, description, status: 'described' as const } : s,
      );
      return { session: { ...state.session, steps } };
    });
  },

  addPageSnapshot: (snapshotKey: string, tree: unknown) => {
    set(state => {
      if (!state.session) return state;
      const snapshots = { ...state.session.pageSnapshots, [snapshotKey]: tree as any };
      return { session: { ...state.session, pageSnapshots: snapshots } };
    });
  },

  reset: () => set({
    isRecording: false, isPaused: false, session: null, voiceEnabled: false, error: null,
  }),
}));
```

**Step 2: Commit**

```bash
git add src/entrypoints/sidepanel/stores/recording-store.ts
git commit -m "feat: add recording Zustand store"
```

---

### Task 15: Service Worker Recording & OAuth Handlers

**Files:**
- Modify: `src/entrypoints/background.ts`

**Step 1: Import new modules**

Add imports for:
- `putRecording`, `putRecordingStep`, `putRecordingPageSnapshot` from `db-helpers`
- `addOAuthRedirectRule`, `removeOAuthRedirectRule`, `startAdaptiveMonitor`, `exchangeCodeForToken`, `generatePKCE`, `buildAuthUrl`, `cleanupStaleOAuthState` from `codex-oauth`
- `setCodexOAuthTokens`, `getCodexOAuthTokens` from `storage`
- `encrypt`, `decrypt`, `importKey` from `crypto`
- `getEncryptionKeyEncoded` from `storage`

**Step 2: Add recording port listener**

In `init()`, add:
```typescript
// Recording port (long-lived connection from sidepanel)
let recordingPort: chrome.runtime.Port | null = null;
const activeRecordingSessions = new Map<string, { tabId: number; sessionId: string }>();

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'recording-stream') {
    recordingPort = port;
    port.onDisconnect.addListener(() => { recordingPort = null; });
  }
});
```

**Step 3: Add START_RECORDING handler**

```typescript
router.on('START_RECORDING', async (msg) => {
  const sessionId = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRecordingSessions.set(sessionId, { tabId: msg.tabId, sessionId });
  await putRecording(db, {
    id: sessionId, startedAt: new Date().toISOString(),
    activeTabId: msg.tabId, trackedTabs: [msg.tabId], stepCount: 0,
  });
  return { ok: true as const, sessionId };
});
```

**Step 4: Add RECORDING_ACTION handler in content script message listener**

Add a second `chrome.runtime.onMessage.addListener` that handles `RECORDING_ACTION` from content scripts (distinguished by `sender.tab`):
```typescript
// Enrich with screenshot, forward to recording port
const dataUrl = await chrome.tabs.captureVisibleTab(sender.tab!.windowId!, { format: 'png' });
const step = { ...action, id: crypto.randomUUID(), screenshot: dataUrl, status: 'enriched' };
// Persist (without screenshot)
await putRecordingStep(db, { ...step, screenshot: undefined });
// Forward via port
recordingPort?.postMessage({ type: 'RECORDING_STEP', step });
```

**Step 5: Add STOP_RECORDING handler**

```typescript
router.on('STOP_RECORDING', async (msg) => {
  activeRecordingSessions.delete(msg.sessionId);
  // Update recording completedAt in DB
  return { ok: true as const };
});
```

**Step 6: Add OAuth handlers**

```typescript
router.on('START_CODEX_OAUTH', async () => {
  const { verifier, challenge } = await generatePKCE();
  const state = crypto.randomUUID();
  await chrome.storage.local.set({ _oauthPkce: { verifier, state, createdAt: Date.now() } });
  await addOAuthRedirectRule(chrome.runtime.id);
  const authUrl = buildAuthUrl(challenge, state);
  const tab = await chrome.tabs.create({ url: authUrl });
  if (tab.id) startAdaptiveMonitor(tab.id);
  return { ok: true as const };
});

router.on('OAUTH_CALLBACK', async (msg) => {
  const pkce = (await chrome.storage.local.get('_oauthPkce'))._oauthPkce;
  if (!pkce || pkce.state !== msg.state) throw new Error('Invalid OAuth state');
  await removeOAuthRedirectRule();
  const creds = await exchangeCodeForToken(msg.code, pkce.verifier);
  // Encrypt and store
  let keyEncoded = await getEncryptionKeyEncoded();
  if (!keyEncoded) {
    const key = await generateEncryptionKey();
    keyEncoded = await exportKey(key);
    await setEncryptionKeyEncoded(keyEncoded);
  }
  const key = await importKey(keyEncoded);
  await setCodexOAuthTokens({
    access: await encrypt(key, creds.access),
    refresh: await encrypt(key, creds.refresh),
    expires: creds.expires,
    accountId: creds.accountId,
  });
  await chrome.storage.local.remove('_oauthPkce');
  return { ok: true as const };
});

router.on('LOGOUT_CODEX', async () => {
  await setCodexOAuthTokens(null);
  return { ok: true as const };
});
```

**Step 7: Add startup cleanup**

In `init()`:
```typescript
await cleanupStaleOAuthState();
```

**Step 8: Commit**

```bash
git add src/entrypoints/background.ts
git commit -m "feat: add service worker recording and OAuth handlers"
```

---

### Task 16: Recording UI — Toolbar Component

**Files:**
- Create: `src/entrypoints/sidepanel/components/RecordingToolbar.tsx`

**Step 1: Implement RecordingToolbar**

```tsx
// src/entrypoints/sidepanel/components/RecordingToolbar.tsx
import { useEffect, useState } from 'react';
import { useRecordingStore } from '../stores/recording-store';

export function RecordingToolbar() {
  const { isRecording, isPaused, voiceEnabled, session, stopRecording, togglePause, toggleVoice } = useRecordingStore();
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!isRecording || isPaused) return;
    const start = session?.startedAt ? new Date(session.startedAt).getTime() : Date.now();
    const interval = setInterval(() => setElapsed(Math.floor((Date.now() - start) / 1000)), 1000);
    return () => clearInterval(interval);
  }, [isRecording, isPaused, session?.startedAt]);

  if (!isRecording) return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const stepCount = session?.steps.length ?? 0;

  return (
    <div className="flex items-center gap-3 px-3 py-2 bg-red-50 border-t border-red-200">
      <span className="relative flex h-3 w-3">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75" />
        <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
      </span>
      <span className="text-sm font-mono text-red-700">
        {String(mins).padStart(2, '0')}:{String(secs).padStart(2, '0')}
      </span>
      <span className="text-xs text-red-600 bg-red-100 rounded-full px-2 py-0.5">
        {stepCount} step{stepCount !== 1 ? 's' : ''}
      </span>
      <div className="flex-1" />
      <button onClick={togglePause} className="text-sm text-red-600 hover:text-red-800" title={isPaused ? 'Resume' : 'Pause'}>
        {isPaused ? '▶' : '⏸'}
      </button>
      <button onClick={toggleVoice} className={`text-sm ${voiceEnabled ? 'text-red-600' : 'text-gray-400'} hover:text-red-800`} title="Toggle voice">
        🎤
      </button>
      <button onClick={stopRecording} className="bg-red-500 text-white text-sm rounded-lg px-3 py-1 hover:bg-red-600">
        Stop
      </button>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/entrypoints/sidepanel/components/RecordingToolbar.tsx
git commit -m "feat: add RecordingToolbar component"
```

---

### Task 17: Recording UI — Live Step List

**Files:**
- Create: `src/entrypoints/sidepanel/components/LiveStepList.tsx`

**Step 1: Implement LiveStepList**

```tsx
// src/entrypoints/sidepanel/components/LiveStepList.tsx
import { useEffect, useRef } from 'react';
import { useRecordingStore } from '../stores/recording-store';

const ACTION_ICONS: Record<string, string> = {
  click: '🖱️',
  type: '⌨️',
  navigate: '🌐',
  narration: '🎤',
};

export function LiveStepList() {
  const { session, removeStep } = useRecordingStore();
  const endRef = useRef<HTMLDivElement>(null);
  const steps = session?.steps ?? [];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [steps.length]);

  if (!steps.length) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-400 text-sm">
        Interact with the page to capture steps...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-3 space-y-2">
      {steps.map((step, i) => (
        <div
          key={step.id}
          className="group flex items-start gap-2 p-2 bg-gray-50 rounded-lg animate-[slideIn_0.2s_ease-out]"
        >
          <span className="text-base mt-0.5">{ACTION_ICONS[step.action] ?? '❓'}</span>
          <div className="flex-1 min-w-0">
            <span className="text-xs text-gray-400 mr-1">{i + 1}.</span>
            <span className="text-sm text-gray-800">
              {step.description ?? (
                <span className="inline-block bg-gray-200 rounded h-4 w-32 animate-pulse" />
              )}
            </span>
            {step.selector && (
              <div className="text-xs text-gray-400 truncate font-mono mt-0.5">{step.selector}</div>
            )}
          </div>
          <button
            onClick={() => removeStep(step.id)}
            className="opacity-0 group-hover:opacity-100 text-gray-400 hover:text-red-500 text-xs p-1 transition-opacity"
            title="Remove step"
          >
            ✕
          </button>
        </div>
      ))}
      <div ref={endRef} />
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/entrypoints/sidepanel/components/LiveStepList.tsx
git commit -m "feat: add LiveStepList component for recording UI"
```

---

### Task 18: Recording UI — Start Modal

**Files:**
- Create: `src/entrypoints/sidepanel/components/RecordingStartModal.tsx`

**Step 1: Implement RecordingStartModal**

```tsx
// src/entrypoints/sidepanel/components/RecordingStartModal.tsx
import { useState, useEffect } from 'react';
import { useRecordingStore } from '../stores/recording-store';
import { checkMicPermission, requestMicPermission } from '../../../lib/recording/speech';

interface Props {
  onClose: () => void;
}

export function RecordingStartModal({ onClose }: Props) {
  const { startRecording } = useRecordingStore();
  const [micState, setMicState] = useState<PermissionState>('prompt');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    checkMicPermission().then(setMicState).catch(() => {});
  }, []);

  const handleStart = async () => {
    setStarting(true);
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab');
      await startRecording(tab.id);
      onClose();
    } catch {
      setStarting(false);
    }
  };

  const handleRequestMic = async () => {
    const granted = await requestMicPermission();
    setMicState(granted ? 'granted' : 'denied');
  };

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl shadow-xl max-w-sm w-full p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-2">Teach Cohand your workflow</h2>
        <p className="text-sm text-gray-600 mb-4">
          Go through the steps as if you're teaching a new teammate.
          Cohand will learn the process and repeat it for you.
        </p>

        {micState === 'denied' && (
          <div className="text-xs text-amber-600 bg-amber-50 rounded-lg p-2 mb-3">
            Recording without voice narration (microphone denied)
          </div>
        )}

        {micState === 'prompt' && (
          <button onClick={handleRequestMic} className="w-full text-sm text-blue-600 hover:text-blue-800 mb-3">
            Enable microphone for voice narration
          </button>
        )}

        <div className="flex gap-2">
          <button onClick={onClose} className="flex-1 text-sm text-gray-500 hover:text-gray-700 py-2">
            Cancel
          </button>
          <button
            onClick={handleStart}
            disabled={starting}
            className="flex-1 bg-blue-500 text-white rounded-lg py-2 text-sm font-medium hover:bg-blue-600 disabled:opacity-50"
          >
            {starting ? 'Starting...' : 'Start recording'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

**Step 2: Commit**

```bash
git add src/entrypoints/sidepanel/components/RecordingStartModal.tsx
git commit -m "feat: add RecordingStartModal component"
```

---

### Task 19: Integrate Recording UI into ChatPage

**Files:**
- Modify: `src/entrypoints/sidepanel/pages/ChatPage.tsx`

**Step 1: Import recording components and store**

```tsx
import { useState } from 'react';
import { useRecordingStore } from '../stores/recording-store';
import { RecordingToolbar } from '../components/RecordingToolbar';
import { LiveStepList } from '../components/LiveStepList';
import { RecordingStartModal } from '../components/RecordingStartModal';
```

**Step 2: Add recording state and modal toggle**

```tsx
const { isRecording, session } = useRecordingStore();
const [showRecordModal, setShowRecordModal] = useState(false);
```

**Step 3: Conditionally render recording UI vs chat**

When `isRecording`, show `LiveStepList` instead of chat messages. Always show `RecordingToolbar` when recording.

**Step 4: Add record button next to chat input**

```tsx
<button
  onClick={() => setShowRecordModal(true)}
  disabled={isRecording || isStreaming}
  className="text-gray-400 hover:text-red-500 p-2 rounded-lg transition-colors disabled:opacity-30"
  title="Record workflow"
>
  <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
    <circle cx="12" cy="12" r="8" />
  </svg>
</button>
```

**Step 5: Render RecordingStartModal when showRecordModal**

```tsx
{showRecordModal && <RecordingStartModal onClose={() => setShowRecordModal(false)} />}
```

**Step 6: Wire up recording-stream port for live step updates**

In a `useEffect`, connect the port when recording starts:
```tsx
useEffect(() => {
  if (!isRecording) return;
  const port = chrome.runtime.connect({ name: 'recording-stream' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'RECORDING_STEP') {
      useRecordingStore.getState().appendStep(msg.step);
    }
    if (msg.type === 'PAGE_SNAPSHOT') {
      useRecordingStore.getState().addPageSnapshot(msg.snapshotKey, msg.tree);
    }
  });
  return () => port.disconnect();
}, [isRecording]);
```

**Step 7: Commit**

```bash
git add src/entrypoints/sidepanel/pages/ChatPage.tsx
git commit -m "feat: integrate recording UI into ChatPage"
```

---

### Task 20: Settings Page OAuth UI

**Files:**
- Modify: `src/entrypoints/sidepanel/pages/SettingsPage.tsx`
- Modify: `src/entrypoints/sidepanel/stores/settings-store.ts`

**Step 1: Add OAuth state to settings-store**

```typescript
codexConnected: boolean;
codexAccountId: string | null;

// In load():
const codexOAuth = await getCodexOAuthTokens();
set({ codexConnected: !!codexOAuth?.access, codexAccountId: codexOAuth?.accountId ?? null });

// New actions:
startCodexLogin: async () => {
  await chrome.runtime.sendMessage({ type: 'START_CODEX_OAUTH' });
},
logoutCodex: async () => {
  await chrome.runtime.sendMessage({ type: 'LOGOUT_CODEX' });
  set({ codexConnected: false, codexAccountId: null, hasApiKey: false });
},
```

**Step 2: Update SettingsPage for ChatGPT provider**

Replace `needsApiKey` for `chatgpt-subscription` with OAuth login button:

```tsx
{settings.llmProvider === 'chatgpt-subscription' && (
  <section>
    <h2 className="text-sm font-semibold text-gray-700 mb-2">ChatGPT Account</h2>
    {codexConnected ? (
      <div className="flex items-center gap-2">
        <span className="text-sm text-green-600">Connected{codexAccountId ? ` (${codexAccountId})` : ''}</span>
        <button onClick={logoutCodex} className="text-xs text-red-500 hover:text-red-700">Logout</button>
      </div>
    ) : (
      <button
        onClick={startCodexLogin}
        className="w-full bg-green-500 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-green-600"
      >
        Login with ChatGPT
      </button>
    )}
  </section>
)}
```

**Step 3: Commit**

```bash
git add src/entrypoints/sidepanel/pages/SettingsPage.tsx src/entrypoints/sidepanel/stores/settings-store.ts
git commit -m "feat: add ChatGPT OAuth login UI to settings page"
```

---

### Task 21: Recording-to-Chat Refinement & Script Generation

**Files:**
- Create: `src/lib/recording/recording-prompts.ts`
- Modify: `src/entrypoints/sidepanel/stores/chat-store.ts`

**Step 1: Create recording-prompts.ts**

```typescript
// src/lib/recording/recording-prompts.ts
import type { RecordingStep, RecordingPageSnapshot, RecordingStepRecord } from '../../types/recording';

export const RECORDING_SYSTEM_PROMPT = `You are an expert browser automation script generator.
You are given a user's workflow recording (demonstration steps with selectors, a11y trees, and screenshots)
plus their refinement instructions. Generate a JavaScript automation script using the HumanizedPage API.

The recording is TEACHING MATERIAL — not a literal replay template. You may:
- Add loops, conditionals, state management, error handling
- Use different selectors than what was recorded if more robust options exist
- Skip recorded steps or add new ones based on the user's instructions
- Generate logic that looks nothing like the literal recording

Available page methods: goto, click, fill, type, scroll, waitForSelector, waitForLoadState,
url, title, getByRole, getByText, getByLabel, locator

Available context: context.url, context.state, context.notify(message)

Output TWO things separated by a delimiter:
1. A natural-language TASK DESCRIPTION (1-3 sentences, non-technical)
2. The JavaScript script (async function run(page, context) { ... })

Use this format:
---DESCRIPTION---
[task description here]
---SCRIPT---
[script code here]`;

export function buildRecordingGenerationMessages(params: {
  steps: Array<Partial<RecordingStepRecord>>;
  pageSnapshots: Array<{ snapshotKey: string; tree: unknown }>;
  refinementInstructions: string;
  domains: string[];
}): Array<{ role: 'system' | 'user'; content: string }> {
  const stepsText = params.steps.map((s, i) =>
    `${i + 1}. [${s.action}] ${s.description ?? s.selector ?? 'unknown'}` +
    (s.typedText ? ` — typed: "${s.typedText}"` : '') +
    (s.url ? ` — url: ${s.url}` : ''),
  ).join('\n');

  const snapshotsText = params.pageSnapshots.map(s =>
    `### ${s.snapshotKey}\n${JSON.stringify(s.tree, null, 2).slice(0, 5000)}`,
  ).join('\n\n');

  return [
    { role: 'system', content: RECORDING_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `## Recorded Steps\n${stepsText}\n\n## Page Snapshots\n${snapshotsText}\n\n## Allowed Domains\n${params.domains.join(', ')}\n\n## User Instructions\n${params.refinementInstructions}`,
    },
  ];
}

export function parseGenerationOutput(raw: string): { description: string; script: string } {
  const descSplit = raw.indexOf('---DESCRIPTION---');
  const scriptSplit = raw.indexOf('---SCRIPT---');
  if (descSplit === -1 || scriptSplit === -1) {
    return { description: '', script: raw };
  }
  const description = raw.slice(descSplit + '---DESCRIPTION---'.length, scriptSplit).trim();
  const script = raw.slice(scriptSplit + '---SCRIPT---'.length).trim()
    .replace(/^```javascript\n?/, '').replace(/\n?```$/, '');
  return { description, script };
}
```

**Step 2: Add recording-to-chat transition in chat-store.ts**

Add a `submitRecordingRefinement` action that:
1. Takes the completed recording session + refinement text
2. Builds context from `buildRecordingGenerationMessages`
3. Calls `complete(model, context, { apiKey })`
4. Parses output with `parseGenerationOutput`
5. Stores description and script for review

```typescript
submitRecordingRefinement: async (recording: RecordingSession, instructions: string) => {
  const { model, apiKey } = get();
  if (!model || !apiKey) return;
  // ... build messages, call LLM, parse, update state ...
},
```

**Step 3: Commit**

```bash
git add src/lib/recording/recording-prompts.ts src/entrypoints/sidepanel/stores/chat-store.ts
git commit -m "feat: add recording refinement prompts and chat-store integration"
```

---

## Summary

| Task | Description | Depends On | Est. Files |
|------|-------------|------------|------------|
| 1 | Build config & dependencies | — | 3 |
| 2 | Recording & OAuth types | 1 | 5 |
| 3 | pi-ai bridge module | 2 | 2 |
| 4 | Migrate explorer.ts | 3 | 2 |
| 5 | Migrate security-review.ts | 3 | 2 |
| 6 | Migrate stores, delete LLMClient | 3,4,5 | 5 |
| 7 | Message types & IndexedDB v2 | 2 | 3 |
| 8 | IndexedDB recording helpers | 7 | 2 |
| 9 | Self-healing recording context | 3 | 2 |
| 10 | OAuth PKCE & declarativeNetRequest | 2 | 2 |
| 11 | OAuth callback page & storage | 10 | 3 |
| 12 | Content script recording overlay | 2 | 2 |
| 13 | Voice narration module | 2 | 1 |
| 14 | Recording Zustand store | 7 | 1 |
| 15 | Service worker recording/OAuth handlers | 8,10,11 | 1 |
| 16 | Recording toolbar component | 14 | 1 |
| 17 | Live step list component | 14 | 1 |
| 18 | Recording start modal | 13,14 | 1 |
| 19 | Integrate recording UI into ChatPage | 16,17,18 | 1 |
| 20 | Settings page OAuth UI | 15 | 2 |
| 21 | Recording refinement & script gen | 3,14 | 2 |

**Parallelizable groups (independent branches):**
- Tasks 4+5 (both depend on 3, independent of each other)
- Tasks 7+10+12+13 (all depend on 2, independent of each other)
- Tasks 16+17 (both depend on 14, independent of each other)
