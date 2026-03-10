# Workflow Recording & ChatGPT OAuth — Design Document

## 1. Overview

Workflow Recording is a demonstration-based task creation flow for non-technical users. The user performs actions on a web page while the system captures rich contextual data per step. An LLM then generates a proper script informed by the recording, the user's refinement instructions, and full page context — not a literal replay of clicks.

The recording is **teaching material**, not a script template. The LLM may produce a script that looks nothing like the literal recording — adding state management, loops, conditionals, error handling — based on the user's intent expressed through demonstration + refinement instructions.

This design also fixes the currently non-functional "ChatGPT Subscription" provider to use real OpenAI Codex OAuth, and replaces the existing `LLMClient` (OpenAI SDK wrapper) with [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai) — a unified LLM library with built-in support for the Codex Responses API, 20+ providers, streaming, tool calling, cross-provider handoffs, and token/cost tracking.

### Core Flow

```
[User clicks Record]
    → Content script injects element selector overlay
    → User interacts with page normally
    → Each click/type/navigate captured as a step with:
        element info, a11y subtree, screenshot, speech transcript
    → Page snapshots (full a11y tree) captured once per unique URL
    → Steps appear in sidepanel as natural-language descriptions
[User clicks Stop]
    → Steps displayed in chat as a structured message
    → User types refinement instructions
    → LLM generates proper script + natural-language task description
    → User reviews description (not code), approves
    → Enters CreateTaskWizard for naming, domains, schedule
    → Saves as Task with ScriptVersion + description metadata
```

### Why This Approach

Programmatically captured scripts from user interactions have never been reliable — selectors break, page layouts change, literal replays are fragile. Pure LLM-driven workflow creation is reliable but expensive (user must describe everything in words, LLM must explore the page). This hybrid approach gives:

- **Cost savings** of recording (user doesn't describe from scratch, LLM has concrete selectors/DOM context)
- **Intelligence** of LLM-driven generation (handles state, loops, edge cases)

## 2. Content Script — Element Selector Overlay

When the service worker receives a `START_RECORDING` message, it sends an `ACTIVATE_RECORDING` message to the existing content script on the active tab. The recording overlay is a conditionally-activated module within the existing `content.ts` — not a separate `executeScript()` injection. This avoids duplicate content script contexts and listener conflicts. Deactivated on `DEACTIVATE_RECORDING` message.

### Click Capture

Per click, the overlay captures:

- Element metadata: `tagName`, CSS selector (ID → aria-label → class → tag fallback), `textContent`, all HTML attributes
- `aria-*` attributes, `role`, `name`/`placeholder`/`aria-label`
- Click coordinates `{x, y}` relative to viewport (as LLM context hint, not for replay)
- Viewport dimensions
- A11y subtree: the clicked element's ancestors + siblings + children (small slice from the full tree)

### Keystroke Capture

- Accumulated text buffer (handles backspace, enter, tab)
- Target element info (selector, name, placeholder, aria-label)
- `isPending` flag while typing, `isFinal` when focus leaves field
- Sent as `KEYSTROKE_UPDATE` messages

### Sensitive Input Redaction

Keystrokes on sensitive fields are **never captured or sent** to the service worker. The content script checks each keystroke target and suppresses capture for:

- `input[type="password"]`
- Elements with `autocomplete` containing `cc-number`, `cc-csc`, `cc-exp`, `new-password`, `current-password`, `one-time-code`
- Elements whose `name` or `id` matches patterns: `password`, `passwd`, `pin`, `cvv`, `cvc`, `ssn`, `otp`, `mfa`, `totp`, `secret`, `token`

For these fields, the recording step captures only the element selector and a placeholder description ("Typed in password field" / "Entered sensitive data") — no actual `typedText`. This applies to both keystroke events and the final `type` action persisted in IndexedDB.

Note: Claude's Chrome extension ("Teach Claude") does NOT filter sensitive inputs — it captures all field values uniformly and relies on a privacy warning. Cohand takes a stricter approach because recorded steps are persisted to IndexedDB and sent to LLM prompts, increasing the blast radius of accidental credential capture.

### Navigation Capture

- URL, page title, tab ID
- Auto-detected via `chrome.webNavigation.onCompleted` listener in service worker (requires `webNavigation` permission)

### Click Deduplication

Rapid double-clicks on the same element within 300ms are collapsed into a single step. This prevents inflated step counts from accidental double-clicks.

### Visual Feedback

A subtle highlight overlay on hovered elements (like Chrome DevTools inspect mode) so the user knows what they're about to select. Escape key cancels selection / stops recording.

## 3. Recording State & Data Model

### Two Types: Raw Action vs Enriched Step

```typescript
// From content script — no screenshots, no speech
interface RawRecordingAction {
  action: 'click' | 'type' | 'navigate'
  timestamp: number
  selector?: string
  elementTag?: string
  elementText?: string
  elementAttributes?: Record<string, string>
  elementRole?: string
  a11ySubtree?: A11yNode
  typedText?: string
  url?: string
  pageTitle?: string
  viewportDimensions?: { width: number; height: number }
  clickPositionHint?: { x: number; y: number }  // LLM context only
}

// Enriched by service worker + LLM
interface RecordingStep {
  id: string
  recordingId: string
  sequenceIndex: number
  status: 'raw' | 'enriched' | 'described'
  action: 'click' | 'type' | 'navigate' | 'narration'

  // All fields from RawRecordingAction, plus:
  screenshot?: string           // base64, added by service worker, stripped before persist
  speechTranscript?: string     // from voice narration
  description?: string          // LLM-generated natural language
}
```

### Session-Level State

```typescript
interface RecordingSession {
  id: string
  startedAt: string             // ISO-8601
  completedAt?: string
  activeTabId: number
  trackedTabs: number[]         // plain array, not Set (serialization-safe)
  pageSnapshots: Record<string, A11yNode>  // keyed by snapshotKey, max 20, max 50KB per tree
  steps: RecordingStep[]
  generatedTaskId?: string      // set after script generation
}
// Constraints: pageSnapshots capped at 20 entries. A11y trees truncated to 5 levels
// depth and 50KB max per snapshot. Snapshots persisted to IndexedDB as captured (not
// just in-memory) via a recording_page_snapshots store to survive sidepanel crashes.
//
// Snapshot keying: `${url}#${snapshotIndex}` — a new snapshot is captured not only on
// URL change, but also when the user performs an action and the page's a11y tree root
// hash differs significantly from the last snapshot (>30% node-count change heuristic).
// This handles SPAs where modals, tab switches, and inline state changes alter the DOM
// without changing the URL. The 20-entry cap and 50KB limit still apply.
```

### Zustand Store (recording-store.ts)

```typescript
interface RecordingState {
  isRecording: boolean
  isPaused: boolean
  session: RecordingSession | null
  error: string | null

  // Actions
  startRecording: (tabId: number) => void
  stopRecording: () => void
  togglePause: () => void
  removeStep: (stepId: string) => void    // deletes from IndexedDB recording_steps store
  appendStep: (step: RecordingStep) => void
  updateStepDescription: (stepId: string, description: string) => void
}
```

### Communication Architecture

Long-lived port (`chrome.runtime.connect({ name: 'recording-stream' })`) from sidepanel to service worker when recording starts. Port name `'recording-stream'` is distinct from existing `'script-rpc'` port. Service worker acknowledges content script events immediately via `sendResponse({ ok: true })`, enriches asynchronously (screenshot via `captureVisibleTab()`), and forwards enriched steps via the port.

If the port disconnects (sidepanel crash/close), steps are buffered in `chrome.storage.session` with the session ID and `bufferedAt` timestamp. **Screenshots are stripped before buffering** to stay within `chrome.storage.session`'s 10 MB quota (a single screenshot can be 200-500 KB base64). On reconnect, buffered steps are drained. On service worker restart, orphaned buffers (no matching active session) are discarded with a user notification: "Recording was interrupted."

```
Content script
  → chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', ... })
      → Service worker acknowledges immediately (sendResponse)
      → Async: captureVisibleTab() for screenshot
      → Forward enriched step (status: 'enriched') via 'recording-stream' port
          → Recording store appends step
          → Sidepanel fires LLM description enhancement (fire-and-forget per step)
          → On description received, updates step status to 'described'
          → If LLM call fails, step stays 'enriched' (description left blank)
          → At recording stop, any remaining 'enriched' steps are batch-described
```

**LLM description strategy:** Per-step enhancement is fire-and-forget — each step triggers an async LLM call in the sidepanel as soon as it arrives. If the call completes before the next step, the description appears immediately. If the user stops recording before all descriptions are back, remaining steps are batch-described in one call. This balances responsiveness with cost.

### Message Types

Separate `ContentScriptEvent` union from existing command messages, with explicit direction documentation:

```typescript
// Content script → Service worker (events, not commands)
type ContentScriptEvent =
  | { type: 'RECORDING_ACTION'; action: RawRecordingAction }
  | { type: 'KEYSTROKE_UPDATE'; text: string; element: ElementInfo; isFinal: boolean }
  | { type: 'ELEMENT_SELECTION'; elementInfo: ElementInfo; url: string; cancelled?: boolean }

// Service worker → Sidepanel (via 'recording-stream' long-lived port)
type RecordingPortMessage =
  | { type: 'RECORDING_STEP'; step: RecordingStep }
  | { type: 'PAGE_SNAPSHOT'; url: string; tree: A11yNode }

// Sidepanel → Service worker (command messages, extend existing Message union)
// START_RECORDING: { tabId: number }
// STOP_RECORDING: { sessionId: string }
// These are added to the existing Message union in messages.ts alongside
// ContentScriptEvent types. The service worker router uses sender.tab to
// distinguish content script events from sidepanel commands.

// OAuth callback page → Service worker
// oauth-callback.html parses code + state from location.search on load,
// then sends this message. The handler in background.ts retrieves the stored
// PKCE verifier from chrome.storage.local and performs token exchange.
// This works even after service worker restart (message listener re-registered on startup).
type OAuthMessage =
  | { type: 'OAUTH_CALLBACK'; code: string; state: string }
```

### IndexedDB Schema

New stores added to `db.ts`:

```typescript
// recordings store — indexed by startedAt
interface RecordingRecord {
  id: string
  startedAt: string
  completedAt?: string
  activeTabId: number
  trackedTabs: number[]
  stepCount: number
  generatedTaskId?: string
}

// recording_steps store — compound index [recordingId, sequenceIndex]
interface RecordingStepRecord {
  id: string
  recordingId: string
  sequenceIndex: number
  timestamp: number
  action: 'click' | 'type' | 'navigate' | 'narration'
  selector?: string
  elementTag?: string
  elementText?: string
  elementAttributes?: Record<string, string>
  elementRole?: string
  a11ySubtree?: unknown        // A11yNode, serialized
  typedText?: string
  url?: string
  pageTitle?: string
  viewportDimensions?: { width: number; height: number }
  clickPositionHint?: { x: number; y: number }
  speechTranscript?: string
  description?: string
  // screenshot intentionally omitted — stripped before persist
}
// Step deletion: removeStep() physically deletes the record from recording_steps.
// Self-healing and script generation query only existing records — deleted steps
// are never seen. The recordings store's stepCount is decremented on delete.

// recording_page_snapshots store — indexed by [recordingId, snapshotKey]
interface RecordingPageSnapshot {
  id: string
  recordingId: string
  snapshotKey: string        // `${url}#${snapshotIndex}` — re-captured on significant DOM changes
  url: string
  tree: unknown              // A11yNode, serialized, max 50KB
  capturedAt: string         // ISO-8601
}
```

**DB version bump:** Increment `DB_VERSION` from 1 to 2. In the `onupgradeneeded` handler, use `if (old < 2)` (not `old === 1`) to create the new stores. For a fresh install (`old === 0`), both the `old < 1` and `old < 2` blocks run in sequence — this is the standard IndexedDB migration pattern.

## 4. Voice Narration

Speech-to-text runs in the sidepanel via the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). Captures user voice narration in real-time and attaches transcripts to recording steps.

### How It Works

- When recording starts with voice enabled, `SpeechRecognition` initialized with `continuous: true` and `interimResults: true`
- Interim transcripts shown in recording UI as live subtitle
- Final transcripts are associated by **timestamp overlap**: the speech segment's start time is compared against action step timestamps, and the transcript is attached to the step whose timestamp is closest to (and not after) the speech start. If no action step falls within a 3-second window before the speech start, a standalone `narration` step is created instead
- If user speaks without performing any action at all, a standalone `narration` step is created with `description: 'Note: "..."'`
- `sequenceIndex` for narration steps uses speech start time (not end time) to maintain correct ordering relative to action steps, since speech recognition `final` events can fire with 0.5-2s delay

### Permission Flow

- Microphone permission requested via `navigator.mediaDevices.getUserMedia()`
- If denied, recording continues without voice — banner shows "Enable microphone for voice narration"
- Permission state checked upfront via `navigator.permissions.query({ name: 'microphone' })`

### Integration with Step Descriptions

When the LLM enhances a step description, the speech transcript is included as context. Example: user clicks a button and says "this is where I check the daily price" → LLM generates: "Click the price display button to check the current daily price"

### Toggle

Pause/resume voice independently of action recording. Microphone icon in recording toolbar indicates state (active/paused/no permission).

## 5. ChatGPT Subscription OAuth & Codex Responses API

Fixes the currently non-functional "ChatGPT Subscription" provider to use real OpenAI Codex OAuth and the correct API endpoint.

### OAuth Flow — declarativeNetRequest with Adaptive Rule Lifecycle

Uses dynamic `declarativeNetRequest` rules to intercept the localhost OAuth redirect at the network level. The rule uses `regexSubstitution` to preserve query parameters:

```json
{
  "id": 99999,
  "priority": 1,
  "action": {
    "type": "redirect",
    "redirect": {
      "regexSubstitution": "chrome-extension://EXTENSION_ID/oauth-callback.html\\1"
    }
  },
  "condition": {
    "regexFilter": "^http://localhost:1455/auth/callback(\\?.*)?$",
    "resourceTypes": ["main_frame"]
  }
}
```

The extension ID is injected at runtime via `chrome.runtime.id`. The `regexSubstitution` capture group `\\1` preserves the `?code=X&state=Y` query string. User never sees a connection error.

**Adaptive rule management (defensive against disrupting normal Codex CLI usage):**

1. Rule added ONLY when user clicks "Login with ChatGPT"
2. After 30 seconds, check if auth tab is still on `auth.openai.com`:
   - Yes (user still on consent page) → extend rule for another 30 seconds, repeat
   - No (tab closed or navigated away) → remove rule immediately
3. Hard maximum: rule removed after 5 minutes regardless (absolute safety net)
4. On code received: rule removed immediately
5. On extension startup: cleanup any stale rules (crash recovery)

```
startOAuth():
  1. Add dynamic declarativeNetRequest rule
  2. Generate PKCE challenge/verifier, store in chrome.storage.local with 10-minute TTL
     (NOT chrome.storage.session — survives service worker restarts during consent page)
  3. Open auth tab to:
     https://auth.openai.com/oauth/authorize?
       response_type=code&
       client_id=app_EMoamEEZ73f0CkXaXp7hrann&
       redirect_uri=http://localhost:1455/auth/callback&
       scope=openid profile email offline_access&
       code_challenge={challenge}&
       code_challenge_method=S256&
       state={random}&
       codex_cli_simplified_flow=true
  4. Start adaptive monitor:
     every 30s:
       if auth tab still on auth.openai.com → keep rule
       else → remove rule, stop monitor
     after 5min max → remove rule, stop monitor
  5. On code received → remove rule, stop monitor, exchange tokens
```

**Why this is safe for Codex CLI:**

- Rule exists only during active auth flow (typically <30 seconds)
- If user abandons auth, rule cleaned up within 30 seconds
- Hard 5-minute cap prevents permanent state
- Startup cleanup handles crashes
- Codex CLI collision requires simultaneous auth on the same machine — extremely unlikely
- On startup, cleanup stale PKCE state (older than 10 minutes) from `chrome.storage.local`
- On token exchange failure from missing verifier (SW restart), show "Login timed out — please try again"

### Token Exchange

```
POST https://auth.openai.com/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=authorization_code
client_id=app_EMoamEEZ73f0CkXaXp7hrann
code={authorization_code}
code_verifier={pkce_verifier}
redirect_uri=http://localhost:1455/auth/callback
```

Returns: `{ access_token (JWT), refresh_token, expires_in }`

### Account ID Extraction

Access token is a JWT. Extract `chatgpt_account_id` from payload:

```typescript
const payload = JSON.parse(atob(accessToken.split('.')[1]));
const accountId = payload['https://api.openai.com/auth'].chatgpt_account_id;
```

### Token Storage

Encrypt with AES-GCM (existing crypto.ts), store in `chrome.storage.local` as a new top-level key `codexOAuthTokens` (separate from the existing `encryptedTokens` which holds API keys):

```typescript
// New field added to StorageLocal interface in src/types/storage.ts
interface StorageLocal {
  // ... existing fields ...
  codexOAuthTokens?: EncryptedCodexOAuth
}

// Storage format — encrypted at rest, NOT the same shape as pi-ai's OAuthCredentials
interface EncryptedCodexOAuth {
  access: string           // encrypted with AES-GCM (field name matches pi-ai)
  refresh: string          // encrypted with AES-GCM (field name matches pi-ai)
  expires: number          // milliseconds timestamp (plaintext, not sensitive)
  accountId: string        // plaintext, needed for API headers
}
```

**Decrypt/map layer (in `pi-ai-bridge.ts`):** Before any pi-ai call, `getCodexApiKey()` decrypts `access` and `refresh` from storage, producing a plaintext `OAuthCredentials` object (`{ access, refresh, expires, accountId }`) that matches pi-ai's expected format. The `accountId` field uses the `[key: string]: unknown` slot in `OAuthCredentials`. Callers never pass the encrypted storage struct directly to pi-ai.

The existing `settings-store.ts` `hasApiKey` check is updated: `hasApiKey: !!(tokens.apiKey || tokens.oauthToken || codexOAuth?.access)`.

### Token Refresh

Before each API call, check `expiresAt`. If expired:

```
POST https://auth.openai.com/oauth/token
grant_type=refresh_token
refresh_token={token}
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

**Refresh mutex:** A single in-flight `Promise<void>` prevents concurrent refresh races. If two callers (e.g., dual-model security review's `Promise.all`) both see an expired token, only the first triggers a refresh — the second awaits the same promise. This prevents the second refresh from using an already-invalidated refresh token.

### Codex Responses API

The wire format is handled entirely by pi-ai's built-in `openai-codex-responses` provider (`streamOpenAICodexResponses`). Cohand does NOT implement the Codex API client directly. For reference, the endpoint and format:

```
POST https://chatgpt.com/backend-api/codex/responses
Headers: Authorization, chatgpt-account-id, OpenAI-Beta: responses=experimental
Body: { model, stream, instructions, input[], tools[], reasoning: { effort } }
Response: SSE stream (response.created, response.done, response.completed, response.failed)
```

pi-ai handles: SSE + WebSocket dual transport, session-based connection caching (5-min TTL), 3-attempt retry with exponential backoff, reasoning effort mapping per model, usage limit detection with reset time calculation, and `chatgpt-account-id` extraction from the JWT token.

**Cohand-specific error surfacing** (on top of pi-ai's error handling):
- `response.failed` / `stopReason === 'error'`: Surface `errorMessage` to user via chat UI
- HTTP 429 (rate limit): pi-ai retries with backoff; if exhausted, show "Usage limit reached. Try again in ~{mins} minutes."
- `stopReason === 'length'`: Show "Response was cut short due to length limits"
- Usage tracking: `AssistantMessage.usage` → `recordLlmUsage()` after every call

### LLM Client Architecture — Adopting `@mariozechner/pi-ai`

Replace the existing `LLMClient` (OpenAI SDK wrapper) with [`@mariozechner/pi-ai`](https://github.com/badlogic/pi-mono/tree/main/packages/ai), a unified LLM library with built-in support for 20+ providers including the Codex Responses API. This eliminates the need for a custom `ILLMClient` interface or separate `CodexResponsesClient`.

**Why pi-ai instead of custom clients:**

- Already implements `openai-codex-responses` provider with SSE + WebSocket transport, session caching, reasoning effort, retry logic, and usage limit handling
- Handles cross-provider message transformation (thinking blocks, tool call ID normalization, orphaned tool call injection)
- Typed `Context` object serializes to JSON for persistence and cross-provider handoffs
- TypeBox-based tool schemas with AJV validation
- Token/cost tracking built into every `AssistantMessage.usage`
- Eliminates direct OpenAI SDK dependency for LLM calls

**Core API surface used by cohand:**

```typescript
import {
  getModel, stream, complete, streamSimple, completeSimple,
  type Model, type Context, type AssistantMessage, type Tool,
  Type, StringEnum,
} from '@mariozechner/pi-ai';

// Provider → pi-ai model resolution
// getModel() returns undefined for unknown model IDs, so all branches use
// getModelSafe() which falls back to constructing a custom Model object.
function resolveModel(settings: Settings, overrideModel?: string): Model<Api> {
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
      return buildCustomModel(settings);
  }
}

// Try pi-ai registry first; if model ID is unknown (user-entered free-form text),
// fall back to an inline Model object with sensible defaults for the provider's API.
function getModelSafe(provider: string, api: Api, modelId: string): Model<Api> {
  const registered = getModel(provider as any, modelId as any);
  if (registered) return registered;
  return {
    id: modelId, name: modelId, api, provider,
    baseUrl: getDefaultBaseUrl(provider),
    reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384,
  } as Model<Api>;
}

function buildCustomModel(settings: Settings): Model<'openai-completions'> {
  return {
    id: settings.llmModel, name: settings.llmModel,
    api: 'openai-completions', provider: 'custom',
    baseUrl: settings.llmBaseUrl!,
    reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000, maxTokens: 16384,
  } satisfies Model<'openai-completions'>;
}
```

**Caller migration (all callers switch to pi-ai's `Context` + `stream`/`complete`):**

| Caller | Before | After |
|--------|--------|-------|
| `chat-store.ts` | `client.stream(messages, { signal })` | `stream(model, context, { signal, apiKey })` |
| `wizard-store.ts` | `client.chat(messages, { jsonMode })` | `complete(model, context, { apiKey })` |
| `explorer.ts` | `client.chat(messages)` | `complete(model, context, { apiKey })` |
| `security-review.ts` | `createSecurityReviewClients()` → two `LLMClient` | Two `Model` objects + `complete()` calls |
| `self-healing.ts` | `ctx.repairScript(client, ...)` | `ctx.repairScript(model, apiKey, ...)` |

**Dual-model security review with pi-ai:**

```typescript
function getSecurityReviewModels(settings: Settings): [Model<Api>, Model<Api>] {
  if (settings.llmProvider === 'chatgpt-subscription') {
    return [
      getModel('openai-codex', 'gpt-5.4'),       // data flow analysis
      getModel('openai-codex', 'gpt-5.3-codex'),  // capability analysis
    ];
  }
  // API key mode: same model, two independent calls
  const model = resolveModel(settings);
  return [model, model];
}
```

**API key resolution:** In browser, pi-ai requires explicit `apiKey` in call options (no env vars). Cohand decrypts the stored token and passes it per-call. For `chatgpt-subscription`, the OAuth access token is passed as `apiKey`, and pi-ai's Codex provider handles the `chatgpt-account-id` header internally (extracted from JWT).

**Browser compatibility notes:**

- Amazon Bedrock not available in browser (acceptable — not a cohand target)
- Tool argument validation (AJV) disabled under CSP restrictions — cohand validates at the application layer
- OAuth login flows use the Chrome-specific `declarativeNetRequest` approach (section above), NOT pi-ai's Node.js `loginOpenAICodex`. Do NOT import `@mariozechner/pi-ai/oauth` — it triggers Node.js module loads at import time (see Token Refresh section above)
- OAuth credentials stored encrypted in `chrome.storage.local` with pi-ai-compatible field names (`access`, `refresh`, `expires`), decrypted into `OAuthCredentials` shape on demand in `pi-ai-bridge.ts`
- **Transport: SSE only** — all Codex API calls must set `transport: 'sse'` in stream options. Browser `WebSocket` constructor ignores custom `headers` (Node.js-only feature of the `ws` library), so pi-ai's WebSocket transport path would connect without auth headers and fail with 401. Explicitly setting `transport: 'sse'` prevents this
- **ESM/Vitest config** — pi-ai is ESM-only (`"type": "module"`). WXT/Vite handles this for the extension build, but Vitest tests need `@mariozechner/pi-ai` added to `ssr.noExternal` in `vitest.config.ts` to avoid `ERR_REQUIRE_ESM`

**Token refresh — direct `fetch`, no pi-ai/oauth barrel import:**

**Important:** Do NOT import from `@mariozechner/pi-ai/oauth` in extension code. The barrel `index.ts` registers all OAuth providers at module load time, including `openai-codex.ts` which conditionally imports `node:crypto` and `node:http`. Whether the guard (`process.versions?.node`) fires depends on WXT's build shims — if it does, the dynamic imports will throw in a service worker. Instead, implement token refresh directly using `fetch`:

```typescript
// In pi-ai-bridge.ts — browser-safe token refresh (no pi-ai/oauth import)
async function refreshCodexToken(refreshToken: string): Promise<OAuthCredentials> {
  const response = await fetch('https://auth.openai.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    }),
  });
  if (!response.ok) throw new Error('Failed to refresh Codex OAuth token');
  const json = await response.json();
  const accountId = extractAccountId(json.access_token);  // JWT parse
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId,
  };
}

// Wrapped with refresh mutex
let refreshPromise: Promise<OAuthCredentials> | null = null;

async function getCodexApiKey(): Promise<string> {
  const stored = await loadAndDecryptCodexOAuth();  // decrypt from chrome.storage.local
  if (!stored) throw new Error('Not logged in to ChatGPT');
  if (Date.now() < stored.expires) return stored.access;

  // Mutex: single in-flight refresh
  if (!refreshPromise) {
    refreshPromise = refreshCodexToken(stored.refresh).finally(() => { refreshPromise = null; });
  }
  const refreshed = await refreshPromise;
  await encryptAndSaveCodexOAuth(refreshed);
  return refreshed.access;
}
```

This is functionally identical to pi-ai's `refreshOpenAICodexToken` (which is just a `fetch` POST) but avoids the module-load side effects of the OAuth barrel.

**Usage tracking integration:** pi-ai's `AssistantMessage.usage` maps directly to cohand's `LlmUsageRecord`:

```typescript
function mapUsage(msg: AssistantMessage, taskId: string, purpose: string): LlmUsageRecord {
  return {
    id: crypto.randomUUID(),
    taskId,
    purpose,
    provider: msg.provider,
    model: msg.model,
    inputTokens: msg.usage.input,
    outputTokens: msg.usage.output,
    cachedTokens: msg.usage.cacheRead,
    costUsd: msg.usage.cost.total,
    createdAt: new Date().toISOString(),
  };
}
```

**Dependencies change:** Remove direct `openai@^6.27.0` dependency, add `@mariozechner/pi-ai` (includes `@sinclair/typebox` re-export). Note: `openai` remains in the bundle as a transitive dependency of pi-ai — this is fine, as it already bundles successfully in the extension via WXT/Vite today.

### Manifest Additions

```json
{
  "permissions": ["declarativeNetRequest", "webNavigation"],
  "host_permissions": ["<all_urls>"],
  "web_accessible_resources": [{
    "resources": ["oauth-callback.html"],
    "matches": ["http://localhost/*"]
  }]
}
```

Note: `web_accessible_resources` is technically not required for `declarativeNetRequest` `main_frame` redirects — Chrome navigates to `chrome-extension://` URLs directly, bypassing the WAR check. The entry is included defensively but the `matches` field is functionally inert. The important part is that WXT must build `oauth-callback.html` as a **page entrypoint**: `src/entrypoints/oauth-callback/index.html` (template) + `src/entrypoints/oauth-callback/main.ts` (script that parses `location.search` and sends `OAUTH_CALLBACK` message to the service worker).

## 6. Refinement Chat & Script Generation

After recording stops, the workflow enters the existing ChatPage for iterative refinement. This is the core value — turning a demonstration into an intelligent script.

### Step 1: Recording Summary in Chat

Steps rendered as a structured chat message — numbered list of natural-language descriptions with small screenshot thumbnails. Not code. Example:

```
I recorded your workflow (8 steps):

1. Navigate to coinbase.com/price/bitcoin
2. Click the "1D" timeframe button
3. Read the current price display ($67,432.18)
4. Click the "Price Alerts" link
5. Click "Create Alert"
6. Type "65000" into the price target field
7. Click "Below" for alert direction
8. Click "Create Alert" to confirm

What would you like me to do with this workflow?
```

### Step 2: User Refinement

User describes their actual intent in natural language:

> "Don't create an alert. Instead, check the price every hour and notify me if it drops more than 5% from the last check."

### Step 3: LLM Script Generation

The LLM receives:

- Recorded steps (descriptions, selectors, element metadata, a11y subtrees)
- Page snapshots (full a11y trees per URL visited)
- User's refinement instructions
- Speech transcripts from narration

Generates two outputs:

1. **Natural-language task description** — shown to user: "Every hour, navigate to Coinbase, read the current Bitcoin price, compare it against the last stored price, and send a notification if it dropped more than 5%."
2. **Executable script** — `page.goto()`, `page.waitForSelector()`, `page.textContent()`, state diffing logic, `page.notify()` — using real selectors from the recording

### Step 4: User Reviews Description (Not Code)

Description shown in chat. User can:

- Approve → proceeds to save
- Request changes → another refinement round ("also track Ethereum")
- Script is hidden from non-technical users; only the description is visible

### Step 5: Save as Task

On approval, transitions to existing CreateTaskWizard for:

- Naming the task
- Confirming allowed domains (pre-filled from recording URLs)
- Setting schedule (manual / interval)
- Script goes through AST validation + security review before saving as ScriptVersion

### Attaching to Existing Tasks

Save modal defaults to creating a new task but has a dropdown to attach to an existing one instead. Useful for "re-teaching" a broken task when self-healing has exhausted its repair budget.

## 7. Security Pipeline Integration

Recorded workflows produce scripts that go through the existing security pipeline. Recording doesn't bypass any safety checks.

### Script Validation on Save

1. **AST Validation** — generated script parsed and checked for blocked globals (`eval`, `Function`, `fetch`, etc.) and dangerous property access (`.constructor`, `.__proto__`). Same validator used for all scripts.
2. **Dual-model security review** — ChatGPT subscription: `gpt-5.4` + `gpt-5.3-codex` both must approve. Other providers: same model, two independent reviews. Fail-closed on error.
3. **Domain guard** — allowed domains pre-filled from recording URLs, validated against user's configured domain permissions.

### Output Scanning at Runtime

Data the script reads from the page goes through the injection scanner before being passed to LLM context or stored in state.

### Recording-Specific Security

- **Sensitive input redaction** — password fields, MFA codes, payment inputs, and other credential fields are never captured (see §2 Sensitive Input Redaction). Only the element selector and a placeholder description are recorded
- Screenshots stripped before IndexedDB persistence (no accidental storage of sensitive page content)
- Voice transcripts stored only in the recording session, not in the final task
- Content script element selector overlay removed when recording stops — no persistent page modification
- Raw recording data (full element attributes) available to LLM during generation but not persisted in final ScriptVersion

### Self-Healing Integration

- Natural-language task description stored alongside script
- `ScriptVersion.generatedBy` extended with `'recording'` value + optional `recordingId?: string` linking back to `RecordingRecord`
- When self-healing triggers for recording-originated scripts, LLM has: the description, the persisted `recording_steps` (a11y subtrees, selectors), and the `recording_page_snapshots` (full a11y trees from recording time) as repair context
- Richer context than scripts generated from text prompts alone
- The self-healing loop checks `generatedBy === 'recording'` to load this additional context

## 8. UI Components

### Recording Toolbar (overlays chat input when recording)

- Red pulsing dot + elapsed timer
- Pause/Resume button
- Microphone toggle (active/paused/no permission states)
- Stop button
- Step count badge

### Live Step List (replaces chat messages during recording)

- Scrollable list of captured steps
- Each step: action icon (click/type/navigate/mic), LLM-generated description (or "Loading..." shimmer while enhancing), small screenshot thumbnail
- Remove button per step (X icon on hover)
- Steps appear with slide-in animation as captured

### Recording Start Modal

- Hero image + "Teach Cohand your workflow"
- "Go through the steps as if you're teaching a new teammate. Cohand will learn the process and repeat it for you."
- "Start recording" button (if mic permission granted) or "Enable microphone" button (if not)
- Can proceed without mic — banner: "Recording without voice narration"

### Entry Points

- Record button (circle icon) next to chat input — always visible
- `/record` slash command in chat

### Post-Recording (in chat)

- Numbered step summary as structured chat message
- Normal chat input for refinement instructions
- "Create Task" button appears after user approves LLM-generated description
- Transitions to existing CreateTaskWizard

### Settings Page Additions

- "ChatGPT Subscription" provider shows "Login with ChatGPT" button instead of API key field
- Connected state shows account email + "Logout" button
- Token refresh status indicator

## 9. Implementation Summary

### New Files

- `src/lib/recording/element-selector.ts` — content script overlay injection
- `src/lib/recording/step-capture.ts` — step enrichment (screenshots, a11y)
- `src/lib/recording/speech.ts` — Web Speech API wrapper
- `src/lib/codex-oauth.ts` — PKCE flow + declarativeNetRequest rule management
- `src/lib/pi-ai-bridge.ts` — `resolveModel()`, `getSecurityReviewModels()`, `mapUsage()`, token refresh wrapper with mutex
- `src/entrypoints/sidepanel/stores/recording-store.ts` — zustand recording state
- `src/entrypoints/oauth-callback.html` + `oauth-callback.js` — redirect landing page
- `src/types/recording.ts` — RecordingStep, RecordingSession, RawRecordingAction types

### Modified Files

- `src/entrypoints/content.ts` — add element selector overlay handlers
- `src/entrypoints/background.ts` — recording message routing, screenshot capture, OAuth handlers, adaptive rule lifecycle
- `src/entrypoints/sidepanel/pages/ChatPage.tsx` — recording toolbar, live step list, refinement chat
- `src/entrypoints/sidepanel/pages/SettingsPage.tsx` — OAuth login button, connected state
- `src/entrypoints/sidepanel/stores/chat-store.ts` — recording-to-chat transition, migrate from `LLMClient.stream()` to pi-ai `stream(model, context)`
- `src/entrypoints/sidepanel/stores/wizard-store.ts` — migrate from `LLMClient.chat()` to pi-ai `complete(model, context)`
- `src/lib/llm-client.ts` — **delete** (replaced by `pi-ai-bridge.ts` + direct pi-ai calls)
- `src/lib/explorer.ts` — migrate to pi-ai `complete()`, update `ChatMessage` → pi-ai `Context`
- `src/lib/security/security-review.ts` — migrate dual-model review to `getSecurityReviewModels()` + pi-ai `complete()`
- `src/lib/self-healing.ts` — load recording context for `generatedBy === 'recording'` scripts, migrate to pi-ai
- `src/lib/db.ts` — add `recordings`, `recording_steps`, `recording_page_snapshots` stores; bump `DB_VERSION` to 2
- `src/lib/messages.ts` — add `ContentScriptEvent` union, `START_RECORDING`/`STOP_RECORDING`, OAuth messages
- `src/types/storage.ts` — add `codexOAuthTokens?: EncryptedCodexOAuth` to `StorageLocal`
- `src/types/script.ts` — add `'recording'` to `generatedBy` union, add `recordingId?: string`
- `src/constants.ts` — bump `DB_VERSION` to 2
- `wxt.config.ts` — add `declarativeNetRequest` + `webNavigation` permissions, `oauth-callback` page entrypoint
- `vitest.config.ts` — add `@mariozechner/pi-ai` to `ssr.noExternal`
- `package.json` — add `@mariozechner/pi-ai`, remove direct `openai`

### Dependencies

- **Add:** `@mariozechner/pi-ai` — unified LLM library (includes TypeBox, handles all provider APIs)
- **Remove (direct):** `openai@^6.27.0` — becomes a transitive dep via pi-ai (already bundles fine in MV3)
- **No change:** Web Speech API, declarativeNetRequest, crypto.subtle remain browser-native

### Build Configuration

- `vitest.config.ts` — add `@mariozechner/pi-ai` to `ssr.noExternal` (ESM-only package, prevents `ERR_REQUIRE_ESM` in tests)
- `wxt.config.ts` — add `declarativeNetRequest` + `webNavigation` permissions, `oauth-callback` page entrypoint
