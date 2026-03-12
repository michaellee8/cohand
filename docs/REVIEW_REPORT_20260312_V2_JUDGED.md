# Cohand Chrome Extension -- Judged Code Review Report

**Date:** 2026-03-12
**Original Report:** `REVIEW_REPORT_20260312_V2.md`
**Judgement Method:** Each of the 89 findings was independently investigated by a dedicated subagent that examined the actual codebase to determine if the finding is real.

---

## Judgement Summary

| Verdict | Count | Percentage |
|---------|-------|------------|
| **REAL** | 72 | 80.9% |
| **PARTIALLY_REAL** | 11 | 12.4% |
| **FALSE_POSITIVE** | 6 | 6.7% |
| **Total** | **89** | 100% |

### By Severity

| Severity | Total | Real | Partially Real | False Positive |
|----------|-------|------|----------------|----------------|
| Critical | 3 | 1 | 1 | 1 (severity overstated) |
| High | 20 | 17 | 2 | 1 |
| Medium | 51 | 41 | 8 | 2 |
| Low | 15 | 13 | 0 | 2 |

---

## False Positives (6)

### [H1] `new Function()` Fallback in `script-executor.ts` -- Sandbox Escape
**Original Severity:** High | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** `script-executor.ts` uses `new Function()` but is dead code -- never imported by production code. The actual execution path uses QuickJS WASM (`createQuickJSExecutor`). All user scripts are validated by AST validator that blocks `Function` as an identifier before execution, and execution is constrained to a sandboxed iframe.

---

### [M10] `setInterval` Timer Leak in OAuth Adaptive Monitor
**Original Severity:** Medium | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** The setInterval exists but has three built-in exit paths: successful OAuth callback triggers `removeOAuthRedirectRule()` immediately; the interval self-terminates on max lifetime/tab navigation/tab closure; startup cleanup via `cleanupStaleOAuthState()` removes any stale rules on worker restart. No actual leak since it's properly cleaned in all normal paths and stale rules are cleaned on initialization.

---

### [M12] Recording Step ID Collision from `Date.now()` in Rapid Actions
**Original Severity:** Medium | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** Step IDs use format `step-{millisecond}-{6charRandom}` with ~2.2B random combinations. While same-millisecond collisions are theoretically possible, actual ID collision would require both the timestamp AND 6-char random to match (probability ~1/2.2B). IndexedDB `put()` does silently overwrite on duplicate keys, but the mathematical probability is negligible in practice.

---

### [M28] `getTabUrl` Has No Error Handling for Closed Tabs
**Original Severity:** Medium | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** While `getTabUrl` itself lacks internal error handling, all call sites wrap it in try/catch: `humanized-page-handler.ts` wraps it in try/catch (lines 85-134), and `remote-relay.ts` wraps it inside `executeRemoteCommand`'s try/catch (lines 125-213). Errors are properly caught at the call site level.

---

### [M49] Content Script Message Types Not Part of Typed Union
**Original Severity:** Medium | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** `GET_A11Y_TREE` IS properly typed in the `Message` union (line 21 of messages.ts) with corresponding response type (line 58). Lines 80-82 reference a different message type (`ContentScriptEvent`) used for recording events, not for `GET_A11Y_TREE`. The finding incorrectly conflated two separate type unions.

---

### [L12] Duplicate `putNotificationRecord` in `notifications.ts`
**Original Severity:** Low | **Verdict:** FALSE_POSITIVE | **Confidence:** HIGH
**Evidence:** `putNotificationRecord` in notifications.ts is a private function (not exported) used locally, while `putNotification` in db-helpers.ts is an exported public function. They are separate implementations with different visibility scopes. While they accomplish similar work, the private function is not a duplicate export of the public one.

---

## Partially Real Findings (11)

### [C1] Undefined Token Authenticates Fresh Install (Remote Mode Auth Bypass)
**Original Severity:** Critical | **Verdict:** PARTIALLY_REAL | **Confidence:** MEDIUM
**Evidence:** `onMessageExternal` is unconditionally registered and `validateToken` uses raw equality (both confirmed). However, the undefined-equals-undefined bypass is theoretically prevented because token generation occurs during `init()` before external messages are processed. The lack of `externally_connectable` in manifest.json limits attack surface to other extensions only. The real risk is the raw equality check -- if token generation were ever removed or skipped, the vulnerability would become critical.

---

### [H14] `Runtime.evaluate` Used in Local `title` Handler
**Original Severity:** High | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** The title RPC handler at lines 302-306 does use `Runtime.evaluate` with the hardcoded expression `'document.title'`. The expression is safe and hardcoded (not user-controlled), so while the finding is technically accurate about `Runtime.evaluate` being used, the "dangerous pattern" concern is overstated since this is a legitimate, safe usage.

---

### [H20] Screenshot Captured on Every Recording Action
**Original Severity:** High | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `chrome.tabs.captureVisibleTab()` IS called for every single `RECORDING_ACTION` with NO debouncing or throttling. However, recording actions themselves are deduplicated at the content script level: `onClick()` deduplicates rapid clicks on the same element within `CLICK_DEDUP_MS` (300ms). The core issue is valid but the frequency of actions is reduced by click deduplication.

---

### [M6] `goto` Handler Lacks Sensitive URL Scheme Check (Local Path)
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** The goto handler only validates domain via `isDomainAllowed()`, which relies on URL constructor hostname extraction. Standard malicious schemes (`javascript:`, `file:`, `about:`, `data:`) are implicitly blocked because they extract empty hostname. However, no explicit scheme validation exists, and edge cases like `intent://` could bypass. The blocking is accidental/implicit rather than intentional.

---

### [M16] Concurrent `sendMessage` Calls Share Single Abort Controller
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** Each `sendMessage` call creates a new `AbortController`, but concurrent calls share the single `isStreaming` boolean flag and overwrite the stored `abortController` reference in state. If two calls occur concurrently, the second one orphans the first stream's controller, causing `cancelStream()` to abort only the newest stream.

---

### [M21] Whole-Store Zustand Subscriptions in Multiple Components
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `CreateTaskWizard.tsx` clearly uses `useWizardStore()` without any selector, causing full-store subscription. Other files destructure multiple properties from their stores without using Zustand selector functions, which while more selective than CreateTaskWizard's approach, still causes broader subscriptions than ideal. Only `TasksPage.tsx` line 13 properly uses a selector function.

---

### [M37] `getUsageSummary` Loads All Records Into Memory
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `getUsageSummary` uses `index.getAll(range)` which loads all matching records into memory, then iterates for aggregation. However, it filters by a date range (lowerBound `since` parameter) rather than loading all database records. The memory issue is valid but scoped to the filtered range (default 30 days), not all records ever.

---

### [M39] `getComputedStyle` Called for Every Element in A11y Tree
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `getComputedStyle` is called on every `HTMLElement` that passes initial visibility checks (`element.hidden` and `aria-hidden`), not on EVERY element. There IS a fast-path check before `getComputedStyle`. However, on large pages with many visible elements, `getComputedStyle` is still called frequently and forces style recalculation.

---

### [M47] Heavy `as any` Usage in CDP Response Handling
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `selector-resolver.ts` contains 8 legitimate `as any` casts of CDP responses, confirming the CDP response handling concern. However, the finding incorrectly attributes `as any` casts in `message-router.ts` (2 occurrences) and `chat-store.ts` (2 occurrences) to CDP response handling when they are actually type workarounds for message handlers and LLM API calls.

---

### [M48] `pi-ai-bridge.ts` is a Cross-Layer Hub
**Original Severity:** Medium | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `pi-ai-bridge.ts` combines 4+ distinct concerns: model resolution, token refresh, credential handling, and usage mapping. It IS imported from UI stores AND backend flows. However, backend imports are primarily type imports and utility functions rather than core orchestration logic. The file acts as a utility hub rather than a central orchestrator.

---

### [L8] Dead Code: `observePage`, `classifyFlags`, `UsageStats` Component
**Original Severity:** Low | **Verdict:** PARTIALLY_REAL | **Confidence:** HIGH
**Evidence:** `observePage` and `classifyFlags` ARE used in test files (imported and called in test cases) but have ZERO production code imports. `UsageStats` is exported but never imported anywhere. All three are genuinely dead code in production, but two serve a testing purpose.

---

## Real Findings (72)

### Critical (2 Real)

#### [C2] Page.navigate Bypasses Domain Boundary via `javascript:` / `data:` Schemes
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `Page.navigate` target URL validation at lines 190-199 only checks `isSensitiveScheme()`, never validates against `allowedDomains`. `SENSITIVE_SCHEMES` at line 69 omits `javascript:` and `data:` schemes (only includes `chrome:`, `chrome-extension:`, `about:`, `file:`, `devtools:`). A remote client authenticated for `example.com` can navigate to `javascript:` or `data:` URLs while the tab is on an allowed domain.

#### [C3] AST Validator Bypass via `Object.getPrototypeOf` to Reach `Function` Constructor
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The validator blocks `constructor`, `__proto__`, `prototype` as member names but does not block reflection APIs like `getPrototypeOf` or `getOwnPropertyDescriptor`. An attacker can use `Object.getOwnPropertyDescriptor(Object.getPrototypeOf(async function(){}), 'constructor').value` to obtain the constructor function. The string `'constructor'` passed as an argument is allowed since member-name blocking only applies to dot-access patterns.

---

### High (17 Real)

#### [H2] Sandbox Execution Has No Timeout or Abort
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** All four claims verified: (1) `SANDBOX_EXECUTE` `sendMessage` at line 112 has no timeout wrapper; (2) offscreen Promise at lines 46-64 is unguarded; (3) `onExecutionResult` at line 94 adds a message listener with no timeout; (4) `AbortController` check at line 120 occurs AFTER `sendMessage` completes.

#### [H3] `postMessage` Target Origin Falls Back to `'*'` Wildcard
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Both files contain explicit fallbacks to `'*'` wildcard: `sandbox-bridge.ts` line 106-111 `getTargetOrigin()` method catches exceptions and returns `'*'`; `sandbox/main.ts` line 8-10 `PARENT_ORIGIN` is assigned `'*'` as fallback.

#### [H4] Sandbox `main.ts` Does Not Validate `event.origin` on Incoming Messages
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The message listener on lines 25-66 does not validate `event.origin` before processing. While `PARENT_ORIGIN` is defined for outgoing `postMessage` calls, the incoming listener never checks if `event.origin` matches.

#### [H5] Recording `value` Attribute Captures Passwords from Autofilled Fields
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `ALLOWED_ATTRIBUTES` includes `'value'` (line 185). `collectElementMeta()` captures all `ALLOWED_ATTRIBUTES` without sensitivity checks. `onClick` handler calls `collectElementMeta(target)` on line 239 without checking `isSensitiveInput()`. While `isSensitiveInput()` exists and is used to redact keystroke text, it is NOT applied to click events.

#### [H6] Remote `disconnect` Does Not Release Claimed Tabs
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The disconnect handler (remote-server.ts:94-97) only removes the session from `activeSessions` but never iterates through `tabOwnership` to release tabs claimed by that session. `releaseTab()` works properly when called explicitly, but the disconnect handler never invokes it.

#### [H7] Remote Tab Claim Before Validation -- Leaked Claims on Denied Commands
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The function claims the tab at line 137 before performing domain validation (line 157), sensitive scheme checks (line 149), method allowlist validation (line 166), and input blocking checks (line 182). All validation failure paths return early without calling `releaseTab()`.

#### [H8] Token Rotation Does Not Revoke Active Sessions
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `regenerateToken()` at remote-auth.ts:25-28 only updates storage and does not clear `activeSessions`. Commands after line 70 of remote-server.ts are authorized solely by presence in `activeSessions` without re-validating the token. `clearActiveSessions()` exists but is never called by `regenerateToken()`.

#### [H9] Execution Abort Race -- Old Run's Finally Block Clears New Run's State
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The finally block at lines 174-175 unconditionally deletes `taskTabMap` and `executionAbortControllers` entries without checking if they still belong to the current execution. When a new execution aborts an old one and replaces its controller, the old execution's finally block will delete the new execution's controller.

#### [H10] Local Tab Claim Overwrite -- Two Local Tasks on Same Tab
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `claimTab` allows multiple local tasks to claim the same tab because it only checks if `current.owner !== mode`. For local mode, there is no `sessionId` differentiation like there is for remote mode. The second task's claim unconditionally overwrites the first.

#### [H11] Recording Steps Persisted with Empty `recordingId` and Zero `sequenceIndex`
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Recording steps are created in background.ts with `recordingId: ''` and `sequenceIndex: 0`, then persisted to IndexedDB via `putRecordingStep()` BEFORE being sent to the sidepanel. The sidepanel's `appendStep()` simply appends the step without modifying these fields. No code updates the IndexedDB records with correct values.

#### [H12] No React Error Boundary -- Any Render Error Blanks the Sidepanel
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The sidepanel App renders with no Error Boundary wrapper. Confirmed that no `ErrorBoundary`, `componentDidCatch`, or `getDerivedStateFromError` implementations exist anywhere in the `src` directory. Any unhandled render error would blank the entire sidepanel.

#### [H13] Background `init()` Swallows Fatal Startup Errors
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `init()` wraps `openDB()` in a try/catch that only logs errors without rethrowing. If `openDB()` fails, `db` remains `undefined` (declared at line 88). The `initPromise` resolves the gate anyway, allowing the router to open and execute handlers that all call db-dependent functions, crashing with `TypeError`.

#### [H15] Message Router Errors Not Handled by Stores
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `MessageRouter` catches errors and resolves with `{error: String(err)}` (line 39) instead of rejecting. Stores use try/catch expecting rejection but never check resolved responses for error property. They directly access response properties without validation, silently treating failures as empty data.

#### [H16] Streaming Chat Causes Full Message Array Reconstruction Per Token
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `chat-store.ts` lines 110-116 reconstruct the entire messages array on every `text_delta` event using `state.messages.map()`. `ChatPage.tsx` line 10 uses an unselective destructure from `useChatStore`, subscribing to all store properties. Both conditions confirmed.

#### [H17] MV3 Service Worker In-Memory State Lost on Termination
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** All three Maps (`taskTabMap`, `executionAbortControllers`, `testDomainOverrides`) are declared as local variables at lines 79-83 and are completely in-memory. They are never persisted to IndexedDB or `chrome.storage`. The `init()` function does not recover these Maps from any persistent storage.

#### [H18] Recording Port Lifecycle Tied to ChatPage Mount
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The `recording-stream` port is created in ChatPage's `useEffect` (lines 24-36). The cleanup function calls `port.disconnect()` when ChatPage unmounts. App.tsx conditionally renders ChatPage based on `activeTab` state, so switching tabs disconnects the port regardless of recording status.

#### [H19] `buildWrapperScript()` Does Not `await` Async `run()`
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 126 calls `run(page, context)` without `await`, despite the wrapper being an async IIFE and the JSDoc explicitly stating the script should define an async function. Without `await`, if `run()` is async, `result` will be a Promise object instead of the resolved value.

---

### Medium (41 Real)

#### [M1] Remote Token Timing Attack
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 22 uses strict equality operator (`===`) for token comparison: `return stored[TOKEN_STORAGE_KEY] === token;`. This is vulnerable to timing side-channel attacks.

#### [M2] No Remote Session Expiry / Idle Timeout
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `authenticatedAt` is stored at line 65 but never referenced anywhere. No timeout checks, idle cleanup, or session expiration logic exists. Sessions persist indefinitely until explicit disconnect.

#### [M3] No Rate Limiting on Remote Auth Attempts
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The auth handler at lines 49-53 in remote-server.ts performs unlimited token validation attempts with no tracking, throttling, delays, or rate limiting.

#### [M4] `onMessageExternal` Accepts Messages from Any Extension
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `wxt.config.ts` manifest config lacks `externally_connectable` key. `background.ts` registers `chrome.runtime.onMessageExternal.addListener()` without manifest-based restriction. Security relies solely on runtime token validation.

#### [M5] Redundant `startsWith` Check Weakens CDP Method Whitelist
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The `startsWith` checks for `Input.dispatchMouseEvent` and `Input.dispatchTouchEvent` are redundant because these exact strings are already in `ALLOWED_CDP_METHODS`. The `blockedInputMethods` check is dead code since those methods aren't in the whitelist and would be rejected earlier.

#### [M7] Encryption Key Stored Adjacent to Ciphertext
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The encryption key is definitively stored in `chrome.storage.local` under `_encryptionKey` alongside encrypted tokens stored under `encryptedTokens` in the same storage. The code itself acknowledges this limitation in `crypto.ts` lines 3-6.

#### [M8] Decrypted LLM Credentials Cached in Zustand State After Logout
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `initClient()` stores plaintext API token in `useChatStore.apiKey` (line 54). `clearApiKey()` only clears storage and settings store state, never touches chat store. `logoutCodex()` similarly only updates settings store. `clearChat()` resets messages but not `apiKey`. No integration exists between logout and chat store cleanup.

#### [M9] `cleanupStaleOAuthState` Checks Wrong Storage Keys
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** OAuth flow stores state under key `_oauthPkce` containing object `{verifier, state, createdAt}` (background.ts:571), but cleanup function searches for separate keys `pkceState`, `pkceTimestamp`, `pkceVerifier` (codex-oauth.ts:218) that don't exist. Stale interrupted OAuth flows will never be cleaned up.

#### [M11] `RPC port.postMessage` After Disconnect
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `rpc-handler.ts` lines 39-48: The async handler can await indefinitely while the port may disconnect. After await completes, `port.postMessage()` is called without checking disconnection status. No `onDisconnect` handler is registered in `RPCHandler` (unlike `RPCClient` which properly registers one).

#### [M13] Concurrent `ensureOffscreen` Calls Race
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `ensureOffscreen` lacks synchronization. It checks `existingContexts.length === 0` then calls `createDocument`, with no cached promise or lock. Called from at least three locations. The second concurrent call's `createDocument` would throw. The error is caught silently, but the race condition is real.

#### [M14] Wizard `startObservation` Accesses `treeResponse.tree` Without Null Guard
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 113 accesses `treeResponse.tree` without any null/undefined check. `treeResponse` comes from `chrome.runtime.sendMessage()` which can return `undefined` if the content script is not loaded.

#### [M15] Wizard `startObservation` Has No Stale-Completion Guard
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `startObservation()` has multiple long-running async operations (`generateScript`, `securityReview`) that complete after `reset()` could be called. The final `set()` at line 148-153 executes regardless. Unlike `chat-store.ts` which uses `AbortController`, `wizard-store.ts` has no abort guard, request ID, or stale-completion check.

#### [M17] Pause Recording is UI-Only -- Steps Still Arrive
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `isPaused` and `voiceEnabled` only toggle local UI state in recording-store.ts. The content script sends `RECORDING_ACTION` messages without checking pause state. The background.ts handler has no pause filtering. Pause only affects the timer display, not step ingestion.

#### [M18] Pause Speech Recognition Immediately Restarts Due to `sessionActive`
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `pauseSpeechRecognition()` calls `recognition.stop()` but does not set `sessionActive=false`. The `onend` handler checks `if (!sessionActive) return` and auto-restarts via `rec.start()` if `sessionActive` is true. `stopSpeechRecognition()` correctly sets `sessionActive=false` before stopping.

#### [M19] `recordingPort` Singleton Disconnect Race
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 152 sets `recordingPort` to null in the `onDisconnect` callback without checking if the disconnecting port is the current `recordingPort`. A new port connection could be wiped out by an older port's delayed disconnect callback.

#### [M20] Scheduler Opens Sidepanel URL But No Bootstrap Code Handles It
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Scheduler opens `sidepanel.html?taskId=...&mode=execute` (confirmed in scheduler.ts:69), but sidepanel has zero code to read query parameters. No usage of `window.location`, `URLSearchParams`, or `location.search` found in the sidepanel directory. Sidepanel always initializes with default state.

#### [M22] `settings-store.ts` Uses `catch (err: any)` -- Unsafe Error Handling
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `settings-store.ts` contains 7 catch blocks explicitly typed as `catch (err: any)` -- the only store file with explicit `any` typing. All catch blocks directly access `err.message` without type guards. Other stores use `catch (err: unknown)` with `instanceof Error` type guards.

#### [M23] Task Deletion Does Not Cascade to Related Records
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `DELETE_TASK` handler only calls `dbDeleteTask()` which deletes from the `tasks` store. Database schema shows multiple tables with `taskId` references (`script_versions`, `script_runs`, `task_state`, `state_snapshots`, `notifications`, `llm_usage`) that are left orphaned.

#### [M24] `GENERATE_SCRIPT` Handler Returns Wrong Type / Dead Code
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Handler returns incorrect type with `as any` cast: returns `{source, astValid, securityPassed, observation}` when expected type is `{source, astValid, securityPassed}` (line 319). The handler is dead code -- never called from production code (wizard-store uses local functions instead). Only appears in tests.

#### [M25] Self-Healing Module Not Wired Into Execution
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `selfHeal` function is implemented and tested but never imported or called from any production code. The execution-orchestrator handles failed executions by snapshotting state and recording the failure, but does not trigger any self-healing repair loop. Helper functions `isDegraded()` and `getApprovalRequirement()` are also unused in production.

#### [M26] `notify` RPC Method is a No-Op
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The `notify` RPC handler returns `{queued: true}` without calling `deliverNotification()`. The `deliverNotification` function exists and is fully implemented in notifications.ts but is never invoked from production code. The handler lacks database and task context needed to call `deliverNotification`. No queue processing mechanism exists.

#### [M27] CDP Manager Partial Enable Failures Leave Incomplete State
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The `attach` method attaches the debugger and adds the tab to the state map BEFORE attempting to enable CDP domains (lines 33-35). If any domain enable call throws, the exception propagates without detaching. The debugger remains attached with incomplete state.

#### [M29] Execution Results Not Proactively Surfaced to UI
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `EXECUTE_TASK` fires `executeTaskAsync()` with `.catch(console.error)` and returns `{ok:true}` immediately. `executeTaskAsync` saves run records to IndexedDB but sends no message back to UI. The sidepanel has no listener for execution completion and must poll `GET_RUNS` manually.

#### [M30] `tasks-store.ts` Uses `Map` for Runs (Serialization/Equality Issues)
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 7 declares `runs: Map<string, ScriptRun[]>` in `TasksState`. `fetchRunsForTask` creates a new Map via `new Map(get().runs)`, then sets to state. This creates new Map references on each fetch, violating Zustand's shallow equality checks.

#### [M31] `hostValueToHandle()` Converts Objects to JSON Strings Instead of QuickJS Values
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `hostValueToHandle()` at line 155 calls `ctx.newString(JSON.stringify(value))` for all objects/arrays, converting them to JSON string handles instead of using `ctx.newObject()`. This affects RPC results returned at line 223, making structured results appear as strings to user scripts.

#### [M32] Typed `keydown` Recording Misses Paste/IME/Autocomplete
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Code only listens to `keydown` events to reconstruct typed text. Missing event handlers for: paste events, `input` events, IME composition events, drag-drop events, and `change` events. Keystroke buffer only accumulates from keyboard input.

#### [M33] `startRecording` / `stopRecording` Race Condition
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `startRecording` sets `isRecording=true` synchronously (line 30) but `session` is set asynchronously (line 49) after handshake. `stopRecording` checks `if (!session)` at line 62 and returns early if null. A user can click stop before async handshake completes, causing `stopRecording` to be a no-op.

#### [M34] `addDomainPermission` Can Create UI Duplicates
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `addDomainPermission` in settings-store.ts unconditionally appends to local state after calling `storage.addDomainPermission`, without checking whether storage actually accepted the permission. The storage layer de-duplicates, but the store ignores the result.

#### [M35] Raw IndexedDB Instead of Dexie -- Missing Transaction Atomicity
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Codebase uses raw IndexedDB with transaction-per-operation architecture. `CREATE_TASK` creates task, script_version, and task_state in separate transactions. Capping functions use loops of individual deletes. The `deleteRecording` function shows multi-store transactions ARE possible but unused elsewhere.

#### [M36] Sequential Single-Transaction IDB Deletes in Cap Functions
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** All three cap functions (`capScriptVersions`, `capRuns`, `capStateSnapshots`) use a for-loop with `await deleteRecord()` calls. Each `deleteRecord` call creates a new transaction, resulting in N separate transactions for N records.

#### [M38] `refMap` in `a11y-tree.ts` Grows Unboundedly
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `nextRefId` counter increments without bound and is never reset in production. `refMap` grows with each tree generation, with stale WeakRef entries only lazily cleaned when queried. `clearRefMap()` exists but is only called in tests, never in production.

#### [M40] QuickJS Pool Exists But Is Unused
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `quickjs-pool.ts` defines a reusable pool with acquire/release methods, but `quickjs-runner.ts` line 181-182 explicitly creates fresh WASM modules on every invocation (confirmed by inline comment "Create a fresh WASM module (in production, use the pool)"). Pool is never imported in the execution flow.

#### [M41] Unused `openai` Package in Dependencies
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `openai` (version ^6.26.0) is listed as a dependency in package.json:32, but there are no actual imports of the package in the source code. Only references to `openai.com` URLs exist in comments/strings.

#### [M42] Large Bundle Size -- No Code Splitting / Lazy Loading
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `App.tsx` uses synchronous/eager imports for ChatPage, TasksPage, and SettingsPage. No `React.lazy()`, `Suspense`, or code-splitting strategies are present. All pages are bundled upfront.

#### [M43] `waitForLoadState` Uses Naive 1s Sleep
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The `waitForLoadState` handler contains only a bare 1-second `setTimeout` with no page load state monitoring. The comment explicitly states "Simple wait -- in real implementation would listen to CDP Page events".

#### [M44] `waitForSelector` Polling Has No Abort Signal Awareness
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The polling loop uses only a timeout-based condition and has no access to abort signals. The `HandlerContext` interface does not expose abort signals, and the polling loop contains no checks for execution cancellation. Will block until timeout or selector resolution.

#### [M45] Duplicate Rate-Limit Logic with Magic Number
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `db-helpers.ts` line 247 uses hardcoded `10` instead of `MAX_NOTIFICATIONS_PER_TASK_PER_HOUR` constant. The constant is defined in `constants.ts` and properly used in `notifications.ts`, but not imported in `db-helpers.ts`.

#### [M46] Significant Field Overlap Between Recording Types
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `RawRecordingAction`, `RecordingStep`, and `RecordingStepRecord` share 12 identical fields (`action`, `selector`, `elementTag`, `elementText`, `elementAttributes`, `elementRole`, `a11ySubtree`, `typedText`, `url`, `pageTitle`, `viewportDimensions`, `clickPositionHint`). All fields are copy-pasted with no abstraction.

#### [M50] Duplicate `initLLM()` Call in Wizard Store
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `initLLM()` is called twice in the `startObservation()` method: line 120 for script generation and line 140 for security review. The second call is redundant as it re-initializes settings and API key resolution when the same values are already available.

#### [M51] Settings Load Failure Causes Permanent Loading Screen
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Store's `load()` function sets error but never updates the null settings state (line 61). `SettingsPage` only checks `loading` and `!settings` (line 26) but never checks the `error` state (which isn't even destructured from the store). Permanent "Loading settings..." UI on failure.

---

### Low (13 Real)

#### [L1] `KEYSTROKE_UPDATE` Messages Sent But Never Handled
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `KEYSTROKE_UPDATE` is sent by `sendKeystrokeUpdate()` via `chrome.runtime.sendMessage()`, but it is defined in `ContentScriptEvent` type (not the main `Message` union). No handler exists in the MessageRouter. The sidepanel's recording-stream port only listens for `RECORDING_STEP` and `PAGE_SNAPSHOT`. Messages are silently dropped.

#### [L2] CSS Selector Injection / Indirect Prompt Injection via DOM Content
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `aria-label` values are captured in `collectElementMeta()` without truncation and included in `a11ySubtree`. These are sent to the LLM via explorer-prompts.ts and recording-prompts.ts without individual length limits or content sanitization. While the overall JSON is sliced to 5000 chars, individual aria-label values remain unsanitized.

#### [L3] `markNotificationRead` Can Drift Unread Count Below Zero
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `markNotificationRead` at line 79 unconditionally decrements `unreadCount` by 1 without checking if the target notification was already read. While `Math.max(0, ...)` prevents negative values, the counter can still drift and become inaccurate.

#### [L4] `execution-orchestrator.ts` Finally Block Can Mask Original Error
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The finally block (lines 177-181) calls `await addScriptRun()` and `await capRuns()` without try/catch. Both functions can reject on IDB errors. If either throws, it replaces any original execution error caught in the outer catch block.

#### [L5] `tasks-store.ts` `runTask` Fails Silently When No Active Tab
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `runTask` silently returns without error when `tab?.id` is undefined. The message send only occurs if `tab?.id` is truthy, but if it's falsy, the function exits without setting any error state or notifying the user.

#### [L6] `RecordingStartModal` Error Swallowed Without UI Feedback
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The catch block only resets the `starting` state but does not display any error to the user. The error is silently swallowed. The store's error property is not accessed or displayed in the component.

#### [L7] `UsageStats` Swallows Fetch Failure -- Permanent "Loading..."
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 11 contains `.catch(() => {})` which silently swallows all errors. When the fetch fails, `summary` remains null and the component renders "Loading usage..." indefinitely with no fallback or error state.

#### [L9] Hardcoded `'gpt-5.4'` Default Model in Two Places
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `'gpt-5.4'` is hardcoded in both `src/lib/storage.ts:5` (as `DEFAULT_SETTINGS.llmModel`) and `src/lib/pi-ai-bridge.ts:104` (as a fallback in `resolveModel` for the `chatgpt-subscription` provider). The duplication creates a maintenance risk.

#### [L10] Hardcoded `20` as Default Run Limit
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Hardcoded value `20` found in both locations: `tasks-store.ts:50` passes `limit: 20` in message payload, and `background.ts:253` uses `msg.limit ?? 20` as fallback.

#### [L11] Welcome Message String Duplicated
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** The welcome message string `'Welcome to Cohand! Describe what you want to automate...'` appears identically in the initial state (line 38) and `clearChat()` function (line 167).

#### [L13] Startup Alarm Sync Recreates All Alarms Even When Unchanged
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** `syncSchedules` unconditionally clears ALL existing task alarms (lines 47-52) without comparison, then recreates alarms for all enabled interval tasks. No diffing mechanism exists. Called on every service worker startup.

#### [L14] Duplicated Pi-AI Context/Text Extraction Helpers
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Both `explorer.ts` and `security-review.ts` define `toContext()` and `extractText()` functions with identical purposes but different implementations. These are duplicated helper functions that should be consolidated.

#### [L15] `chrome.sidePanel.setPanelBehavior()` Not Awaited
**Verdict:** REAL | **Confidence:** HIGH
**Evidence:** Line 69 calls `chrome.sidePanel.setPanelBehavior()` without `await` or `.catch()` handling. The containing callback is synchronous (not async), and the API returns a Promise that can reject, creating an unhandled promise rejection risk.

---

## Methodology

Each of the 89 original findings was assigned to an independent investigation agent. Each agent:

1. Read the referenced source files in the actual codebase
2. Verified whether the described behavior exists
3. Checked for mitigating factors not mentioned in the original finding
4. Assigned a verdict (REAL, PARTIALLY_REAL, FALSE_POSITIVE) with confidence level and evidence

All 89 investigations were run in parallel against the current `main` branch.
