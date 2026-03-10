# Workflow Recording & ChatGPT OAuth — Design Document

## 1. Overview

Workflow Recording is a demonstration-based task creation flow for non-technical users. The user performs actions on a web page while the system captures rich contextual data per step. An LLM then generates a proper script informed by the recording, the user's refinement instructions, and full page context — not a literal replay of clicks.

The recording is **teaching material**, not a script template. The LLM may produce a script that looks nothing like the literal recording — adding state management, loops, conditionals, error handling — based on the user's intent expressed through demonstration + refinement instructions.

This design also fixes the currently non-functional "ChatGPT Subscription" provider to use real OpenAI Codex OAuth and the Codex Responses API (`chatgpt.com/backend-api/codex/responses`).

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

When recording starts, a new content script module is injected into the active tab via `chrome.scripting.executeScript()` from the service worker on `START_RECORDING` message. Removed on `STOP_RECORDING`.

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

### Navigation Capture

- URL, page title, tab ID
- Auto-detected via `chrome.webNavigation.onCompleted` listener in service worker

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
  pageSnapshots: Record<string, A11yNode>  // keyed by URL, captured once per unique URL
  steps: RecordingStep[]
  generatedTaskId?: string      // set after script generation
}
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
  removeStep: (stepId: string) => void
  appendStep: (step: RecordingStep) => void
  updateStepDescription: (stepId: string, description: string) => void
}
```

### Communication Architecture

Long-lived port (`chrome.runtime.connect()`) from sidepanel to service worker when recording starts. Service worker acknowledges content script events immediately via `sendResponse({ ok: true })`, enriches asynchronously (screenshot via `captureVisibleTab()`), and forwards enriched steps via the port. Buffered in `chrome.storage.session` if port disconnects.

```
Content script
  → chrome.runtime.sendMessage({ type: 'RECORDING_ACTION', ... })
      → Service worker acknowledges immediately
      → Async: captureVisibleTab() for screenshot
      → Forward enriched step via long-lived port to sidepanel
          → Recording store appends step
          → Triggers LLM description enhancement
```

### Message Types

Separate `ContentScriptEvent` union from existing command messages, with explicit direction documentation:

```typescript
// Content script → Service worker (events, not commands)
type ContentScriptEvent =
  | { type: 'RECORDING_ACTION'; action: RawRecordingAction }
  | { type: 'KEYSTROKE_UPDATE'; text: string; element: ElementInfo; isFinal: boolean }
  | { type: 'ELEMENT_SELECTION'; elementInfo: ElementInfo; url: string; cancelled?: boolean }

// Service worker → Sidepanel (via long-lived port)
type RecordingPortMessage =
  | { type: 'RECORDING_STEP'; step: RecordingStep }
  | { type: 'PAGE_SNAPSHOT'; url: string; tree: A11yNode }
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
```

## 4. Voice Narration

Speech-to-text runs in the sidepanel via the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`). Captures user voice narration in real-time and attaches transcripts to recording steps.

### How It Works

- When recording starts with voice enabled, `SpeechRecognition` initialized with `continuous: true` and `interimResults: true`
- Interim transcripts shown in recording UI as live subtitle
- Final transcripts attached to the most recent step's `speechTranscript` field
- If user speaks without performing an action, a standalone `narration` step is created with `description: 'Note: "..."'`

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

Uses dynamic `declarativeNetRequest` rules to intercept the localhost OAuth redirect at the network level. The rule redirects `http://localhost:1455/auth/callback?*` to `chrome-extension://<id>/oauth-callback.html?*` before any connection attempt — user never sees a connection error.

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
  2. Generate PKCE challenge/verifier, store in chrome.storage.session
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

Encrypt with AES-GCM (existing crypto.ts), store in `chrome.storage.local`:

```typescript
interface CodexOAuthTokens {
  accessToken: string      // encrypted
  refreshToken: string     // encrypted
  expiresAt: number        // milliseconds timestamp
  accountId: string
}
```

### Token Refresh

Before each API call, check `expiresAt`. If expired:

```
POST https://auth.openai.com/oauth/token
grant_type=refresh_token
refresh_token={token}
client_id=app_EMoamEEZ73f0CkXaXp7hrann
```

### Codex Responses API

Replace `api.openai.com/v1/chat/completions` with:

```
POST https://chatgpt.com/backend-api/codex/responses
Headers:
  Authorization: Bearer {jwt_access_token}
  chatgpt-account-id: {account_id}
  OpenAI-Beta: responses=experimental
  Content-Type: application/json

Body:
{
  "model": "gpt-5.4",
  "stream": true,
  "instructions": "system prompt",
  "input": [
    { "role": "user", "content": "..." },
    { "role": "assistant", "content": "..." }
  ],
  "tools": [],
  "reasoning": { "effort": "medium" },
  "store": false
}
```

Response: SSE stream with events `response.created`, `response.done`, `response.completed`, `response.failed`, `error`.

**Provider routing:** Only `chatgpt-subscription` uses the Codex Responses API. All other providers (OpenAI API, Anthropic, Gemini, custom) continue using the existing `LLMClient` with standard `chat.completions.create()`.

### Manifest Additions

```json
{
  "permissions": ["declarativeNetRequest"],
  "host_permissions": ["<all_urls>"]
}
```

`oauth-callback.html` registered as a web-accessible resource.

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

- Screenshots stripped before IndexedDB persistence (no accidental storage of sensitive page content)
- Voice transcripts stored only in the recording session, not in the final task
- Content script element selector overlay removed when recording stops — no persistent page modification
- Raw recording data (full element attributes) available to LLM during generation but not persisted in final ScriptVersion

### Self-Healing Integration

- Natural-language task description stored alongside script
- When self-healing triggers, LLM has both description AND original recording metadata (a11y subtrees, selectors) as repair context
- Richer context than scripts generated from text prompts alone

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
- `src/lib/codex-responses.ts` — Codex Responses API client (SSE streaming)
- `src/entrypoints/sidepanel/stores/recording-store.ts` — zustand recording state
- `src/entrypoints/oauth-callback.html` + `oauth-callback.js` — redirect landing page
- `src/types/recording.ts` — RecordingStep, RecordingSession, RawRecordingAction types

### Modified Files

- `src/entrypoints/content.ts` — add element selector overlay handlers
- `src/entrypoints/background.ts` — recording message routing, screenshot capture, OAuth handlers, adaptive rule lifecycle
- `src/entrypoints/sidepanel/pages/ChatPage.tsx` — recording toolbar, live step list, refinement chat
- `src/entrypoints/sidepanel/pages/SettingsPage.tsx` — OAuth login button, connected state
- `src/entrypoints/sidepanel/stores/chat-store.ts` — recording-to-chat transition
- `src/lib/llm-client.ts` — add CodexResponsesClient alongside existing OpenAI client
- `src/lib/db.ts` — add recordings and recording_steps IndexedDB stores
- `src/lib/messages.ts` — add ContentScriptEvent union, recording messages, OAuth messages
- `wxt.config.ts` — add declarativeNetRequest permission, oauth-callback.html entrypoint

### Dependencies

No new npm dependencies — Web Speech API, declarativeNetRequest, crypto.subtle are all browser-native.
