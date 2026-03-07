# Cohand — Chrome Extension Design

**Date:** 2026-03-07
**Status:** Design approved
**Repo:** ~/repos/cohand (standalone, open source)
**Relationship to Sohand:** Independent project. Sohand connects via Remote mode as a client.

---

## 1. Product Overview

Cohand ("code hand") is an open-source Chrome extension that turns natural language
into deterministic, self-healing browser automation scripts. Unlike LLM-driven browser
agents that interpret web content on every action (and are vulnerable to prompt injection),
Cohand generates scripts once, security-reviews them, then runs them deterministically.
The LLM is only involved at generation time.

**Tagline:** *Prompt once, automate forever.*

### Three Modes

| Mode | Name | Trigger | Description |
|---|---|---|---|
| 1 | **Tasks** | Manual or scheduled | Repetitive automations from natural language. Versioned scripts with persistent JSON state. Domain-locked. Self-healing on breakage. |
| 2 | **Chat** | User conversation | Interactive bot that fulfills requests by generating scripts on demand or invoking existing tasks. Session-level domain permissions. |
| 3 | **Remote** | External WebSocket | Authenticated CDP relay. External apps (Sohand, custom tools) connect and get Playwright API access to enabled tabs. Token auth, domain allowlist, input lock. |

### Key Differentiator

Scripts are immune to prompt injection at runtime. A malicious page cannot manipulate
a deterministic script the way it can manipulate an LLM interpreting the page live.

---

## 2. Component Architecture

```
+-----------------------------------------------------------+
|                    CHROME BROWSER                          |
|                                                           |
|  +----------+  +----------+  +----------+                |
|  |  Tab A   |  |  Tab B   |  |  Tab C   |  (any page)   |
|  | content  |  | content  |  | content  |                |
|  | script   |  | script   |  | script   |                |
|  +----+-----+  +----+-----+  +----+-----+                |
|       +------ a11y tree --------+                         |
|                      |                                    |
|  +-------------------v-----------------------------+      |
|  |              Service Worker                     |      |
|  |  - Central message router                       |      |
|  |  - chrome.debugger attach/detach/sendCommand    |      |
|  |  - chrome.alarms for scheduled tasks            |      |
|  |  - WebSocket relay for Remote mode              |      |
|  |  - Batched humanization (Bezier, typing)        |      |
|  |  - Token vault (decrypt on request)             |      |
|  +------+------------------+----------------+-----+      |
|         |                  |                |             |
|  +------v------+  +-------v--------+  +----v-------+    |
|  |  Side Panel |  |   Offscreen    |  |  Scheduled |    |
|  |  (React)    |  |   Document     |  | Task Window|    |
|  |             |  |                |  |  (popup)   |    |
|  | - Chat tab  |  | +------------+ |  |            |    |
|  | - Tasks tab |  | | Sandboxed  | |  | sidepanel  |    |
|  | - LLM calls |  | | iframe     | |  | instance   |    |
|  | - Settings  |  | |            | |  | for LLM    |    |
|  |             |  | | QuickJS    | |  +------------+    |
|  |             |  | | WASM       | |                     |
|  |             |  | | sandbox    | |                     |
|  +-------------+  | +------------+ |                     |
|                   +----------------+                     |
+-----------------------------------------------------------+
         ^
         | WebSocket (localhost, token auth)
    External apps (Sohand, custom tools)
```

### Six Components

| Component | Runs In | Responsibility |
|---|---|---|
| **Content Script** | Every page | A11y tree generation (with Shadow DOM traversal), visual execution indicators. Zero CDP footprint. |
| **Service Worker** | Background | Message router, `chrome.debugger` CDP commands, batched humanization, `chrome.alarms`, WebSocket relay for Remote mode. Stateless. No LLM calls. |
| **Side Panel** | User-opened | React app with Chat + Tasks tabs. Handles all LLM API calls. Settings, notifications feed, execution logs. |
| **Offscreen Document** | Hidden page | Hosts sandboxed iframe containing QuickJS WASM runtime. Bridges script execution to service worker CDP commands via `postMessage`. Persists via `WORKERS` reason. |
| **Sandboxed Iframe** | Inside offscreen | QuickJS WASM executes scripts in complete isolation. Zero `chrome.*` access. CWS-compliant sandbox. |
| **Scheduled Task Window** | On-demand popup | Alarm fires -> service worker opens `sidepanel.html` in popup window -> runs task including LLM -> closes. |

### Manifest Requirements

```json
{
  "manifest_version": 3,
  "minimum_chrome_version": "125",
  "permissions": [
    "debugger", "sidePanel", "storage", "activeTab", "scripting",
    "tabs", "tabGroups", "alarms", "notifications", "offscreen",
    "unlimitedStorage"
  ],
  "host_permissions": ["<all_urls>"],
  "content_security_policy": {
    "extension_pages": "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
  },
  "sandbox": {
    "pages": ["sandbox.html"]
  }
}
```

Key notes:
- `minimum_chrome_version: 125` for flat debugger sessions and improved lifecycle
- `wasm-unsafe-eval` required for QuickJS WASM instantiation
- `sandbox.pages` declares the sandboxed iframe page for CWS compliance
- `<all_urls>` required for `chrome.debugger` and content script injection; domain
  restrictions enforced at the application layer

---

## 3. Security Pipeline

Security is the core differentiator. Every script passes through a multi-layer pipeline
before it can touch a page.

### Layer 1: Explorer Agent Constraints

The Explorer observes pages to understand structure before script generation.

Hard constraints:
- Reads a11y tree via content script (zero CDP)
- Screenshots via `chrome.tabs.captureVisibleTab()` (zero CDP)
- Navigation clicks via CDP require user confirmation (with "don't ask again" opt-out)
- CANNOT: type into fields, execute JS, submit forms, access network
- Navigation clicks domain-locked to the task's allowed domains
- Prefers reading `href`/form metadata from the a11y tree over clicking

"Don't ask again" guardrails:
- Per-domain, not global
- Expires after 30 days or N navigations
- Navigation rate limit: max 5 per minute
- All navigations logged to user-visible audit log
- Sensitive-page blocklist for known settings/security URLs within allowed domains

### Layer 2: Static Analysis (AST Validation)

Deterministic pre-filter before any LLM review. Whitelist approach:
- Parse script AST
- Only allow calls to known HumanizedPage methods and standard control flow
- Block all computed member access on `globalThis`/`window`/`self`/`this`
- Block `.constructor` and `.__proto__` access on all objects
- Block `Proxy`, `Reflect`, `eval()`, `Function()`, `import()`, `require()`,
  `fetch()`, `XMLHttpRequest`, `WebSocket`
- Block tagged template literals on non-literal callees
- Block unicode escapes in identifiers that resolve to blocked names
- Zero LLM cost, instant

This is a fast pre-filter, not a security boundary. Sophisticated obfuscation can
bypass it. The real security gates are Layers 3 and 4.

### Layer 3: Dual-Model Security Review

Two independent LLM calls with fresh context:
- ChatGPT subscription: gpt-5.4 + gpt-5.3-codex (different model families)
- API key mode: two calls with user's model (same model, fresh contexts)
- Both must return `approved: true`. Either rejecting = script rejected.
- Fail-closed on error (timeout, malformed response = rejection)

Review prompts are differentiated:
- Model 1: focuses on data flow (where does scraped data go?)
- Model 2: focuses on capability access (what APIs/constructors does the script reach?)

For repaired scripts, prompts include a structural diff against the previous approved
version: "Evaluate ONLY the delta."

Adversarial few-shot examples included in prompt (e.g., `[].filter.constructor`
accessing `Function`).

### Layer 4: QuickJS WASM Sandbox (Runtime)

Even if a script passes review with malicious intent:
- Runs in a sandboxed iframe declared in `manifest.json` `sandbox.pages`
- Iframe uses `sandbox="allow-scripts"` without `allow-same-origin`
- CSP on sandboxed page: `script-src 'wasm-unsafe-eval'; default-src 'none'`
- Zero `chrome.*` access, zero `fetch`, zero DOM access
- Only exposed functions: HumanizedPage methods, `state.get()`, `state.set()`, `notify()`
- Memory cap: 32MB via `setMemoryLimit()`
- CPU interrupt handler: 5-minute timeout
- One async context per task execution (Asyncify constraint)

QuickJS C-level hardening before WASM compilation:
- Strip `AsyncFunction`, `GeneratorFunction`, `AsyncGeneratorFunction` constructors
- Strip `Proxy`, `Reflect`
- Strip `eval`, `Function` constructors

### Layer 5: Output Scanning

Everything a script returns or stores passes through the injection scanner:
- Script return values scanned before display
- State JSON changes scanned before persistence
- Notifications scanned before delivery
- **Fail-closed** — scanner error = content blocked
- Size limits: 1MB hard cap on state, 128-256KB soft target
- Content classification: flag state values containing emails, phone numbers,
  auth tokens, credit card patterns

### Layer 6: Domain Restrictions

Application-level enforcement (not Chrome permissions):
- **Task level:** Each task declares allowed domains at creation. Enforced at the
  service worker CDP routing layer — commands targeting disallowed domains rejected
  before reaching `chrome.debugger.sendCommand()`.
- **Session level (Chat mode):** Each new domain requires user approval. YOLO mode
  toggle auto-approves with warning dialog.
- YOLO mode does NOT bypass security review — domain permissions and security
  review are independent concerns.

### HumanizedPage Exposed API (Exhaustive)

```
goto(url)              click(selector)         fill(selector, text)
type(selector, text)   scroll(distance)        waitForSelector(selector, opts)
waitForLoadState(st)   url()                   title()
getByRole(role, opts)  getByText(text)         getByLabel(text)
locator(selector)  ->  proxy with:
  click, fill, type, textContent (capped 500 chars),
  getAttribute (whitelist: href, aria-label, role, title, alt, data-testid),
  boundingBox, isVisible, count, all
```

**NOT exposed:** `evaluate`, `$`, `$$`, `content()`, `mouse`, `keyboard`, `route`,
`exposeFunction`, `addInitScript`, event listeners, or any raw CDP access.

Cumulative bytes read via `textContent`/`getAttribute` tracked per execution.
Alert if threshold exceeded (50KB total reads per run).

---

## 4. Script Execution Flow

### Message Flow

```
Script in QuickJS WASM sandbox
  |  await page.click('[aria-label="Like"]')
  |  QuickJS suspends via Asyncify
  v
Sandboxed iframe  ->  postMessage  ->  Offscreen Document (bridge)
  |  Wraps as RPC: {id: 7, method: 'click', args: {...}, deadline: ...}
  v
Offscreen Document  ->  chrome.runtime.connect (long-lived port)  ->  Service Worker
  |  1. Validate domain allowlist
  |  2. Resolve selector via DOM-first pipeline:
  |     DOM.getDocument({pierce:true}) -> DOM.querySelector ->
  |     DOM.scrollIntoViewIfNeeded -> DOM.getContentQuads
  |     (AX methods only for role/name selectors via queryAXTree)
  |  3. Execute full humanized sequence:
  |     Bezier mouse curve, random offset, hover delay,
  |     mousePressed -> pause -> mouseReleased
  |  4. Return result
  v
chrome.debugger.sendCommand (multiple CDP calls)  ->  Chrome Tab
  |
  v  response flows back up the chain, QuickJS resumes
```

### RPC Protocol

Offscreen document communicates with service worker via `chrome.runtime.connect()`
(long-lived port). Benefits: `Port.onDisconnect` detection, duplex streaming,
multiplexing multiple in-flight RPCs, keeps service worker alive while messages flow.

```typescript
// Request (offscreen -> service worker)
interface ScriptRPC {
  id: number              // monotonic, for matching responses
  taskId: string          // which task owns this execution
  method: string          // 'click' | 'fill' | 'goto' | ...
  args: Record<string, unknown>
  deadline: number        // timestamp, rejected if exceeded
}

// Response (service worker -> offscreen)
interface ScriptRPCResult {
  id: number
  ok: boolean
  value?: unknown
  error?: {
    type: 'NavigationChanged' | 'TargetDetached' | 'SelectorNotFound'
        | 'DeadlineExceeded' | 'OwnerDisconnected' | 'DomainDisallowed'
    message: string
  }
}
```

### Batched Humanization

Humanization runs entirely in the service worker. A single `click` RPC triggers:
- Bezier mouse curve from last known position (20-50 `Input.dispatchMouseEvent` steps)
- Random offset within element bounds (30%-70% range)
- Pre-click hover delay (100-300ms)
- `mousePressed` -> random pause (50-150ms) -> `mouseReleased`

Per-tab mouse position tracked in service worker state. All randomness uses a seeded
PRNG derived from `taskId + actionIndex` for deterministic replay and debugging.

Each RPC is bounded to 30-60 seconds max. Long actions (`type` of long text, `scroll`
of long distance) are chunked by the offscreen document into multiple RPCs while
QuickJS sees a single `await`.

### Navigation Detection

`pageEpoch` counter per tab, incremented on:
- `Target.detachedFromTarget`
- `chrome.debugger.onDetach`
- Top-frame navigation
- Domain change

Every in-flight CDP command checks the epoch before sending. Stale epoch returns
`NavigationChanged` typed error.

If crash occurs between `mousePressed` and `mouseReleased`, a compensating
`mouseReleased` is sent in a `finally` block, or the tab is marked "tainted" and
the run aborted.

### Concurrency Model

- Single shared WASM module pool (3 modules via `newQuickJSAsyncWASMModule()`)
- One async context per task execution (Asyncify: one suspension per module at a time)
- Grab module from pool per task, return on completion
- Different tabs can have scripts running concurrently (separate CDP sessions)
- Same tab: sequential execution only

### Service Worker Keepalive During Execution

- Active `chrome.debugger` sessions keep the worker alive (Chrome 125+)
- Long-lived port messages reset the 30-second idle timer
- The RPC stream naturally prevents idle timeout
- If service worker restarts mid-execution: offscreen detects broken port via
  `Port.onDisconnect`, fails the script, self-healing loop retries

### Script Format

```javascript
async function run(page, context) {
  await page.goto(context.url)
  await page.waitForLoadState('domcontentloaded')

  const price = await page.locator('.price-display').textContent()
  const prev = context.state.lastPrice

  if (prev && price !== prev) {
    await context.notify('Price changed: ' + prev + ' -> ' + price)
  }

  context.state.lastPrice = price
  return { price }
}
```

No `module.exports`, no `require`, no imports. Plain `run` function.
Host evaluates the script and calls `run()` directly.

---

## 5. Self-Healing & Script Lifecycle

### Script Lifecycle

```
Explorer Agent inspects page
  |
  v
Script generated -> AST validation -> Dual-model security review -> Save as v1
  |
  v
Execution (manual or scheduled)
  |
  +- SUCCESS -> validate output (schema, non-empty, not degraded)
  |   +- Valid -> mark as last_known_good, log run, done
  |   +- Invalid -> SOFT FAILURE
  |
  +- ERROR (throw, timeout, selector not found) -> HARD FAILURE
         |
         v
   Self-Healing Loop
     |
     +- Step 1: Try last_known_good version
     |   Success? -> promote back to active, done
     |
     +- Step 2: Try up to 2 previous successful versions
     |   Success? -> promote, done
     |
     +- Step 3: LLM Repair
           |
           +- Build repair context:
           |   - Failing script source
           |   - Error message + stack trace
           |   - Current page a11y tree snapshot
           |   - Current page screenshot
           |   - Expected output schema
           |   - Last successful output sample
           |   - Structural diff against previous approved version
           |
           +- LLM generates repaired script
           |
           +- Full security pipeline:
           |   AST validation -> dual-model review -> sandbox test run
           |
           +- Tiered approval:
           |   - Scraping scripts: auto-promote with notification
           |     "Task 'Price Monitor' self-healed (v1->v2). [Review] [Revert]"
           |   - Action scripts: ALWAYS require user approval
           |     Shows diff, repair rationale, "Test on this page" button
           |
           +- Fail after 2 repair attempts -> disable task, notify user:
               "Task 'Price Monitor' paused. Open the page and click
                'Reinspect' to regenerate."
```

### Degradation Detection

Track rolling success rate over last 10 runs. If a script that averaged 8+ items
per run now returns 0-2, flag as degraded even though it did not error.

### Repair Budget

Max 2 LLM repair attempts per failure event. Prevents runaway LLM costs.

### Version Cap

Keep last 10 versions per task. Older versions pruned from IndexedDB.
Run history capped at 100 runs per task.

### Behavioral Verification for Action Scripts

After an action script executes (e.g., `executeFollow`), re-read the a11y tree
to verify the expected state change (e.g., button now says "Following" instead
of "Follow"). If mismatch, mark run as failed.

First execution of any action script (or after repair) runs in dry-run mode:
execute up to the final action, screenshot the target element, show user
"This script will click [element]. Proceed?"

---

## 6. Data Model & Storage

### Three Storage Layers

| Layer | What | Why |
|---|---|---|
| `chrome.storage.local` | Settings, LLM config, encrypted tokens, domain permissions, `_storageSchemaVersion` | Simple KV, change events, all contexts |
| `chrome.storage.session` | In-flight execution state, decrypted short-lived tokens | Ephemeral, cleared on restart, trusted contexts only |
| IndexedDB | Tasks, script versions, execution logs, task state, notifications, LLM usage | Structured queries, large data, transactions |

`chrome.storage.local` access level set to `TRUSTED_CONTEXTS` to block content
script access.

### chrome.storage.local Keys

```typescript
interface StorageLocal {
  _storageSchemaVersion: number
  settings: {
    llmProvider: 'chatgpt-subscription' | 'openai' | 'anthropic' | 'gemini' | 'custom'
    llmModel: string
    llmBaseUrl?: string          // custom provider only
    yoloMode: boolean
    language: string
  }
  encryptedTokens: {
    oauthToken?: string          // encrypted at rest via Web Crypto API
    apiKey?: string              // encrypted at rest
  }
  domainPermissions: DomainPermission[]
}

interface DomainPermission {
  domain: string
  grantedAt: string              // ISO-8601
  grantedBy: 'user' | 'task_creation'
}
```

### IndexedDB Schema (v1)

Database name: `cohand`, version: `1`

**`tasks` store** (primary key: `id`):

```typescript
interface Task {
  id: string
  name: string                    // "Monitor iPhone price on Amazon"
  description: string             // original natural language prompt
  allowedDomains: string[]
  schedule: TaskSchedule
  activeScriptVersion: number
  lastKnownGoodVersion?: number
  disabled: boolean
  createdAt: string               // ISO-8601
  updatedAt: string
}

type TaskSchedule =
  | { type: 'manual' }
  | { type: 'interval'; intervalMinutes: number }
```

Indexes: `by_updated [updatedAt]`

**`script_versions` store** (primary key: `id`):

```typescript
interface ScriptVersion {
  id: string                      // taskId:vN
  taskId: string
  version: number
  source: string                  // JS source code
  checksum: string                // SHA-256
  generatedBy: 'explorer' | 'repair' | 'user_edit'
  astValidationPassed: boolean
  securityReviewPassed: boolean
  reviewDetails: ReviewDetail[]
  createdAt: string
}

interface ReviewDetail {
  model: string
  approved: boolean
  issues: string[]
}
```

Indexes: `by_task_version [taskId, version]` (unique), `by_task [taskId]`

**`script_runs` store** (primary key: `id`):

```typescript
interface ScriptRun {
  id: string
  taskId: string
  version: number
  success: boolean
  result?: unknown                // scanned return value
  error?: string
  durationMs: number
  stateHash?: string              // hash of state after run
  stateSummary?: string           // compact summary
  ranAt: string                   // millisecond-precision timestamp
}
// Full state snapshots stored only on failure runs (separate store)
// Capped at 100 runs per task
```

Indexes: `by_task_time [taskId, ranAt]`, `by_task_success_time [taskId, success, ranAt]`

**`task_state` store** (primary key: `taskId`):

```typescript
interface TaskState {
  taskId: string
  state: Record<string, unknown>  // max 1MB, enforced at write layer
  updatedAt: string
}
```

**`state_snapshots` store** (primary key: `id`):

```typescript
interface StateSnapshot {
  id: string                      // runId
  taskId: string
  state: Record<string, unknown>
  createdAt: string
}
// Only written on failure runs. Capped at 10 per task. Deduplicated by checksum.
```

Indexes: `by_task [taskId]`

**`notifications` store** (primary key: `id`):

```typescript
interface TaskNotification {
  id: string
  taskId: string
  message: string                 // scanned, prefixed "[Cohand: taskname]"
  isRead: number                  // 0 or 1 (IndexedDB cannot index null)
  createdAt: string               // millisecond precision
}
// Rate limited: 10 per task per hour (derived from store, not in-memory counter)
```

Indexes: `by_task_time [taskId, createdAt]`, `by_created [createdAt]`,
`by_read_status [isRead]`

**`llm_usage` store** (primary key: `id`):

```typescript
interface LlmUsageRecord {
  id: string
  taskId: string
  purpose: 'explore' | 'generate' | 'repair' | 'security_review' | 'injection_scan'
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cachedTokens?: number
  costUsd?: number
  createdAt: string
}
// Capped at 90 days. Older records aggregated into daily summaries.
```

Indexes: `by_created [createdAt]`, `by_task [taskId, createdAt]`

### IndexedDB Concurrency

- Service worker is the primary writer for mutating stores
- Side panel reads directly from IndexedDB for display
- Side panel sends write requests to service worker via messaging
- All contexts implement `db.onversionchange` to close cleanly during upgrades
- Short-lived transactions only (no holding across async boundaries)

### IndexedDB Migrations

Version-gated switch in `onupgradeneeded`:

```typescript
request.onupgradeneeded = (event) => {
  const db = request.result
  const old = event.oldVersion
  if (old < 1) { /* create all v1 stores and indexes */ }
  if (old < 2) { /* v2 additions */ }
}
```

All indexes defined in v1 to avoid retroactive remediation.

### chrome.storage.local Migrations

`_storageSchemaVersion` key tracks version. On startup, migration functions
run if behind current version.

---

## 7. LLM Provider Configuration

### Provider Options

| Provider | Auth | Models |
|---|---|---|
| ChatGPT Subscription (default) | OAuth | gpt-5.4, gpt-5.3-codex, gpt-5.1-codex-mini |
| OpenAI API | API key | user's choice |
| Anthropic Claude | API key | user's choice |
| Google Gemini | API key | user's choice |
| Custom (OpenAI-compatible) | API key + base URL | user's choice |

### Model Allocation

| Role | ChatGPT Subscription | API Key Mode |
|---|---|---|
| Explorer / Script Gen / Repair | gpt-5.4 | user's model |
| Security Review #1 | gpt-5.4 | user's model |
| Security Review #2 | gpt-5.3-codex | user's model |
| Injection Scanner | gpt-5.1-codex-mini | user's model |

### Where LLM Calls Happen

**Side panel makes ALL LLM calls.** Service worker makes zero.

This matches Claude Code Chrome's production architecture:
- Side panel creates the OpenAI SDK client with `dangerouslyAllowBrowser: true`
- Calls `.stream()` directly for real-time token display
- `AbortController` handles panel closure gracefully
- Conversation state persisted to storage after each complete turn

**Token handling:**
- Encrypted tokens stored in `chrome.storage.local`
- Side panel reads and decrypts on initialization (not per-call)
- No per-call token request to service worker (adds latency, no real security gain)
- Token lives in side panel memory for session duration

**For scheduled tasks (no side panel open):**
- Alarm fires
- Service worker opens `sidepanel.html` in a popup window:
  `chrome.windows.create({type: "popup", width: 500, height: 768})`
- Same LLM code path, 100% reuse
- Window can be minimized for headless behavior

### Codex CLI Credential Detection

During setup, if user selects ChatGPT subscription:
- Check for `~/.codex/auth.json` (not applicable in extension context, but relevant
  if the user previously used Codex CLI and the extension detects it via
  native messaging or manual paste)

---

## 8. Side Panel UI

### Layout

Two tabs at the top: **Chat** and **Tasks**. Settings via gear icon.

### Chat Tab

- Chat interface for interactive bot (Mode 2)
- User types natural language requests
- LLM generates scripts on demand or invokes existing tasks
- Real-time streaming responses
- Domain approval prompts inline
- Explorer Agent visual feedback (showing page observation steps)

### Tasks Tab

- Dashboard listing all tasks with status
- Per-task: last run time, success/failure indicator, next scheduled run
- Notification feed (unread count badge on tab)
- Click task to expand: run history, script versions, state inspector
- Manual "Run Now" button per task
- "Create Task" button opens guided flow:
  1. Describe what you want to automate
  2. Select target domains
  3. Explorer Agent observes the page
  4. Script generated and reviewed
  5. Test run
  6. Optional: set schedule

### Notifications

- Chrome notifications (`chrome.notifications`) for immediate push alerts
- Dashboard notification feed for persistent history
- Per-task toggle: "Notify me" vs "Silent" (log to dashboard only)
- Notifications prefixed with `[Cohand: taskname]` to prevent phishing-like messages
- Rate limited: 10 per task per hour

### Settings

- LLM provider selection and configuration
- Domain permissions list with audit trail
- YOLO mode toggle (with warning dialog)
- LLM usage stats (cost, tokens, per-task breakdown)
- Data export/import
- Language setting

---

## 9. Page Observation (Hybrid Model)

### Content Script A11y Tree (Primary)

Injected on all pages at `document_start`. Exposes
`window.__generateAccessibilityTree()` returning role, text, ref_id for
interactive elements and landmarks.

Extensions over Claude Code Chrome's implementation:
- Shadow DOM traversal via `element.shadowRoot.children`
- Cross-frame merging via message passing between content script instances
- Element tracking via `WeakRef` map for garbage collection

### Screenshots (Zero CDP)

`chrome.tabs.captureVisibleTab()` requires `activeTab` permission but does NOT
require debugger attachment. Captures visible viewport only.

### CDP (On-Demand Only)

CDP attached only when needed for script execution (mouse/keyboard actions).
Detached immediately after. The Explorer Agent uses CDP only for navigation clicks
when content script observation is insufficient.

### Fallback

Pages where content scripts cannot run (chrome://, Web Store, restricted pages)
or pages with weak ARIA: fall back to CDP `Accessibility.queryAXTree` /
`getPartialAXTree` (not full tree scan).

---

## 10. Remote Mode (Mode 3)

Inherited from Playwriter, adapted for Cohand.

### Architecture

- Service worker maintains WebSocket server on `localhost:19988`
- External apps connect with token auth
- Commands are CDP operations relayed through `chrome.debugger`

### Security

- Token generated on install, stored in `chrome.storage.local`
- Domain allowlist sent during auth handshake
- Input lock: all text input and form submission blocked at the relay layer unless
  explicitly unlocked per-action
- Auto-lock after action completion or 30-second timeout

### Mutex with Modes 1/2

A tab is either under Cohand script control (Modes 1/2) OR Remote control (Mode 3),
never both. Single `chrome.debugger` attachment per tab. Service worker enforces
this mutex.

---

## 11. Anti-Detection

### HumanizedPage (Transparent to Scripts)

Scripts write clean Playwright-style code. All humanization happens in the service
worker's batched action handlers:

- `click()` -> Bezier mouse curves from last known position, random offset within
  element bounds, pre-click hover, variable press duration
- `fill()`/`type()` -> Variable keystroke timing (40-200ms per char), 3% typo
  chance with backspace correction, thinking pauses
- `scroll()` -> Momentum simulation, reading pauses (15% chance of 1-4s pause)
- All timing seeded from `taskId` for deterministic replay

### CDP Minimization

- Content script a11y tree: zero CDP footprint for observation
- `chrome.tabs.captureVisibleTab()`: zero CDP for screenshots
- CDP attached only during action execution (seconds)
- Detached immediately after
- Browser tab is 100% clean between actions

### Rate Limiting

Conservative daily limits enforced at the task level:
- Configurable per task
- Tracked in execution logs
- Default: 15 actions/hour per task

---

## 12. Tech Stack

| Component | Technology |
|---|---|
| Extension framework | Chrome MV3 |
| Language | TypeScript |
| Side panel UI | React |
| Script sandbox | QuickJS WASM (quickjs-emscripten) in sandboxed iframe |
| CDP control | chrome.debugger API |
| Storage | chrome.storage.local + chrome.storage.session + IndexedDB |
| LLM SDK | OpenAI SDK (dangerouslyAllowBrowser: true) |
| Build | Vite + CRXJS or WXT |
| Testing | Vitest (unit), WebDriverIO (E2E) |

---

## 13. Export/Import

### Export Format

Single JSON file per task:

```typescript
interface TaskExportBundle {
  formatVersion: 1
  exportedAt: string
  cohandVersion: string
  task: Task
  scripts: ScriptVersion[]       // with full source
  state?: TaskState              // opt-in, may contain scraped data
  // Excluded: runs, notifications, LLM usage, tokens
}
```

### Import Validation

- Check `formatVersion` compatibility
- Re-run AST validation on all imported scripts
- Require security review pass before imported scripts can execute
- Recompute checksums, reject if tampered
- Validate `allowedDomains` against user's domain permissions
- Offer merge vs replace

---

## 14. Review Findings Incorporated

This design was reviewed by 6 independent model runs (3x Codex gpt-5.4,
3x Claude Opus 4.6) covering architecture, security, execution flow, and data model.

### Critical Findings Addressed

| Finding | Source | Resolution |
|---|---|---|
| CWS policy: QuickJS in offscreen = "remote code interpreter" | Codex | Moved to sandboxed iframe (manifest sandbox.pages) |
| HumanizedPage exposes evaluate/$/$$/content() | All reviewers | Exhaustive whitelist, dangerous methods stripped |
| Injection scanner fails open | Claude, Codex | Changed to fail-closed |
| 5-min event handler limit != keepalive | Codex | Chunk RPCs to 30-60s max |
| Asyncify: one suspension per module, not per context | Codex | Module pool (3 modules) |
| Self-healed scripts auto-promote silently | Claude | Tiered: auto for scraping, user approval for actions |
| AST validation trivially bypassed | Claude | Positioned as pre-filter, not security boundary |
| textContent/getAttribute as exfiltration channel | Claude | Length caps, attribute whitelist, byte tracking |
| Task definitions split-brain with chrome.storage.local | Codex | Moved tasks to IndexedDB for atomic transactions |
| OAuth tokens in chrome.storage.session don't survive restart | All | Moved to chrome.storage.local, encrypted at rest |
| Service worker can't reliably stream LLM | Claude | Side panel makes all LLM calls (Claude Code Chrome pattern) |
| Mouse position always starts from (0,0) | Codex | Track per-tab last position in service worker |
| Selector resolution via full AX tree is expensive | Codex | DOM-first pipeline, AX only for role/name selectors |
| No behavioral correctness check for action scripts | Claude | Post-execution a11y verification, dry-run mode |

### Sources

- Chrome Extension Service Worker Lifecycle
- Chrome Offscreen API Reference
- Chrome Debugger API Reference
- Chrome Web Store MV3 Requirements
- quickjs-emscripten Documentation
- Emscripten Asyncify Documentation
- CDP Protocol Specifications (DOM, Input, Accessibility)
- OWASP Browser Extension Vulnerabilities Cheat Sheet
- CVE-2026-23830 (SandboxJS escape via AsyncFunction constructor)
- Claude Code Chrome Extension (production reference)
- Playwriter Extension (production reference)
