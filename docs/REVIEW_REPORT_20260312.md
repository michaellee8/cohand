# Cohand Chrome Extension — Full-Spectrum Code Review Report

**Date:** 2026-03-12
**Codebase:** cohand (WXT/React/TypeScript Chrome Extension)
**Review Agents:** 5 parallel reviewers (3x Claude internal, 1x Codex CLI, 1x Claude replacing failed Gemini CLI)

## Executive Summary

5 parallel review agents analyzed ~90 source files across security, code quality, bug detection, and architecture dimensions. **32 unique findings** identified after deduplication, with strong cross-agent agreement on the top issues.

| Source | Critical | High | Important | Total |
|--------|----------|------|-----------|-------|
| Claude Security Agent | 5 | 5 | - | 10 |
| Claude Code Quality Agent | 2 | - | 8 | 10 |
| Claude Bug Detection Agent | 3 | 5 | 1 | 9 |
| Claude Architecture Agent | 4 | 6 | - | 10 |
| Codex CLI Security Audit | 1 | 4 | - | 5 |
| **Deduplicated Total** | **6** | **13** | **13** | **32** |

---

## CRITICAL FINDINGS

### C1. `new Function` executes LLM-generated scripts without QuickJS WASM isolation
**Files:** `src/entrypoints/sandbox/main.ts:60-65`, `src/lib/script-executor.ts:29-31`
**Found by:** Security, Architecture, Code Quality agents (3/4 agreement)

The sandbox page executes untrusted, LLM-generated code via `new Function('page', 'context', source)`. The intended QuickJS WASM replacement is not implemented. The sandbox page's CSP (`'wasm-unsafe-eval'`) doesn't cover `new Function` (that requires `'unsafe-eval'`). Scripts that bypass the AST validator can execute with full JS capabilities and send arbitrary RPC calls back through `window.parent.postMessage`.

**Recommended fix:** Replace `new Function` with QuickJS WASM execution. Add a runtime check at initialization: if `typeof WebAssembly === 'undefined'`, log a prominent warning. Document the QuickJS WASM integration point with a `// TODO(Task 6.2)` comment.

---

### C2. AST validator can be bypassed via prototype chain / string concatenation
**File:** `src/lib/security/ast-validator.ts:10-61`
**Found by:** Security agent

`BLOCKED_MEMBERS` includes `'constructor'`, but computed member access is only blocked for `globalThis/window/self/this` objects. Bypass example:

```js
const key = 'constr' + 'uctor';
const F = page.goto[key]('return fetch')();
```

Computed, non-literal access on a non-global object passes validation. String concatenation bypasses are acknowledged in `review-prompts.ts:43` but not blocked.

**Recommended fix:** Apply computed member access blocking to all objects, not just global-like ones. Block non-literal computed access (`node.computed && node.property.type !== 'Literal'`) on any function-valued expression.

---

### C3. `postMessage` uses `'*'` target origin in both directions (sandbox <-> offscreen)
**Files:** `src/lib/sandbox-bridge.ts:103`, `src/entrypoints/sandbox/main.ts:32`
**Found by:** Security agent

Both the sandbox bridge and sandbox main send `postMessage` with `targetOrigin: '*'`, broadcasting RPC requests (containing method names, CSS selectors, typed text) and responses to any document in the window hierarchy.

**Recommended fix:** Replace `'*'` with the sandbox page's specific origin: `new URL(chrome.runtime.getURL('sandbox.html')).origin`.

---

### C4. Sandbox iframe can be navigated by malicious task code — origin trust bypassed
**Files:** `src/entrypoints/sandbox/main.ts:60`, `src/lib/sandbox-bridge.ts:50,103`, `src/entrypoints/offscreen/main.ts:20`
**Found by:** Codex CLI

Since untrusted code runs with full browser globals via `new Function`, it can navigate the sandbox iframe to attacker-controlled content. The offscreen bridge trusts messages only by `event.source === iframe.contentWindow` — the `WindowProxy` persists across navigations, so the parent continues exchanging privileged RPC traffic with the now-attacker-controlled page.

**Recommended fix:** HTML-sandbox the iframe, verify `event.origin`, use a fixed `targetOrigin`, and recreate or reject the iframe if its origin changes.

---

### C5. Recording session ID diverges between store and service worker
**File:** `src/entrypoints/sidepanel/stores/recording-store.ts:30-46`
**Found by:** Architecture agent

The recording store generates its own `sessionId` client-side (`rec-${Date.now()}-...`), but the service worker generates a separate one in the `START_RECORDING` handler. The store never reads the service worker's response ID. DB records use the service worker's ID while the UI uses the store's — queries by recording ID from the store will find nothing.

**Recommended fix:** The service worker should be the single source of truth. `recording-store.ts`'s `startRecording` should await the `START_RECORDING` response and use the returned `sessionId`.

---

### C6. `background.ts` is a 700-line god file with a `releaseTab` logic bug
**File:** `src/entrypoints/background.ts:279-387`
**Found by:** Architecture, Bug Detection agents

`executeTaskAsync` calls `releaseTab(tabId)` in `finally` unconditionally, even if `claimTab` returned `false` or was never reached. A throw before `claimTab` on line 288 means `releaseTab` is called when no claim was made. Also: no guard against concurrent executions of the same task — a second `EXECUTE_TASK` overwrites the first abort controller, making the first execution unabortable.

**Recommended fix:** Extract `executeTaskAsync` into a dedicated `execution-orchestrator.ts`. Check `executionAbortControllers.has(taskId)` before starting. Track `claimTab` success and only release if claimed.

---

## HIGH SEVERITY

### H1. `remoteHandler` is `async` — breaks Chrome's `onMessageExternal` contract
**File:** `src/lib/remote/remote-server.ts:32-108`
**Found by:** Architecture agent

`createRemoteHandler` returns an `async` function. Chrome's `onMessageExternal` needs synchronous `return true` to keep the channel open. An async function returns `Promise<true>` which Chrome treats as falsy, closing the channel before `sendResponse` runs.

**Recommended fix:** Restructure to return a synchronous function with an internal async IIFE:
```ts
return (message, sender, sendResponse) => {
  (async () => { /* ... */ sendResponse(result); })();
  return true;
};
```

---

### H2. Untrusted `msg.action` spread overwrites recording step fields
**File:** `src/entrypoints/background.ts:600-606`
**Found by:** Security agent

```js
const step: RecordingStep = {
  id: `step-${Date.now()}-...`,
  recordingId: '',
  sequenceIndex: 0,
  status: 'enriched',
  ...msg.action,   // <-- untrusted spread from content script
  screenshot,
};
```

`msg.action` comes from the content script running in an arbitrary web page. The spread can override `id`, `recordingId`, `sequenceIndex`, and `status` with attacker-controlled values.

**Recommended fix:** Destructure only known, expected fields from `msg.action`. Validate `msg.action.action` is one of the allowed action types.

---

### H3. Wizard closes on task creation failure
**File:** `src/entrypoints/sidepanel/components/CreateTaskWizard.tsx:398-400`
**Found by:** Code Quality agent

`createTask()` catches errors internally and sets `store.error`, returning normally. `onComplete()` runs unconditionally after, closing the wizard before the user sees the error.

**Recommended fix:** Check `store.error` or make `createTask()` return a boolean success indicator.

---

### H4. `notify` RPC handler fails when page navigates away from allowed domain
**File:** `src/lib/humanized-page-handler.ts:470-481`
**Found by:** Bug Detection agent

`notify` is wrapped in `makeHandler` which validates tab URL domain. Notifications are service-worker-side and tab-agnostic — they shouldn't fail with `DomainDisallowed` when the monitored page redirects.

**Recommended fix:** Register `notify` using a raw handler (not `makeHandler`) that doesn't perform tab/domain validation.

---

### H5. Wrong error type for unknown RPC methods
**File:** `src/lib/rpc-handler.ts:31-35`
**Found by:** Bug Detection agent

Unknown methods return `type: 'SelectorNotFound'` instead of `type: 'Unknown'` (which exists in `ScriptRPCErrorType`), causing callers to misinterpret the error and potentially trigger incorrect retry logic.

**Recommended fix:** Use `type: 'Unknown'` for unknown methods.

---

### H6. Speech recognition double-start race condition
**File:** `src/lib/recording/speech.ts:187-198`
**Found by:** Bug Detection agent

Rapid `stop/start` can leave a stale `rec` reference in the `onend` closure, causing `rec.start()` on the old instance while a new one is also active.

**Recommended fix:** Use an `isActive` flag to gate all callbacks. In `stopSpeechRecognition`, null out all event handlers.

---

### H7. `tab.windowId!` non-null assertion in SCREENSHOT handler
**File:** `src/entrypoints/background.ts:483`
**Found by:** Bug Detection agent

No try/catch around `captureVisibleTab(tab.windowId!)` — crashes for devtools pages or tabs in closed windows.

**Recommended fix:** Guard with `if (!tab.windowId) throw new Error('Tab has no window')` or wrap in try/catch.

---

### H8. `RECORDING_ACTION` has dual `onMessage` listeners causing double responses
**File:** `src/entrypoints/background.ts:581-622, 685`
**Found by:** Architecture, Bug Detection agents (2/4 agreement)

Two separate `chrome.runtime.onMessage.addListener` calls both fire for every message. Both can call `sendResponse` for `RECORDING_ACTION`, and the router logs warnings for unhandled message types.

**Recommended fix:** Move `RECORDING_ACTION` handling into the `MessageRouter` or ensure only one listener fires.

---

### H9. Cross-run result/state mix-up between concurrent executions
**Files:** `src/entrypoints/offscreen/main.ts:46`, `src/lib/sandbox-bridge.ts:91`, `src/entrypoints/sandbox/main.ts:67`
**Found by:** Codex CLI

`execute-script-result` carries no request ID or `taskId`. Each pending `bridge.onExecutionResult` listener resolves on the first result from the iframe. If two executions overlap, one task receives another task's result and state.

**Recommended fix:** Add a per-execution ID to requests and results, match replies before resolving.

---

### H10. Remote clients can release tabs they don't own
**Files:** `src/lib/remote/remote-server.ts:92`, `src/lib/remote/remote-relay.ts:22`
**Found by:** Codex CLI

Any authenticated external extension can send `remote:release`, which unconditionally calls `releaseTab(tabId)`. Ownership is tracked only as `'local' | 'remote'`, not by session/extension ID.

**Recommended fix:** Track lock ownership by authenticated session/extension ID and only allow release by the current owner.

---

### H11. Remote mode bypasses sensitive-page protections
**Files:** `src/lib/remote/remote-relay.ts:107,148`, `src/lib/humanized-page-handler.ts:97`, `src/lib/security/domain-guard.ts:68`
**Found by:** Codex CLI

Local automation blocks `/login`, `/account`, `/billing`, `/security`, `/2fa` paths, but remote execution only checks domain membership. Authenticated external extensions can navigate to and inspect sensitive pages.

**Recommended fix:** Apply `isSensitivePage()` to the remote path as well.

---

### H12. AST/security-review gates not enforced at execution time
**Files:** `src/entrypoints/background.ts:187,318,422`, `src/lib/security/ast-validator.ts:24`, `src/entrypoints/sandbox/main.ts:49`
**Found by:** Codex CLI

`astValidationPassed` and `securityReviewPassed` are stored but never re-checked before execution. `TEST_SCRIPT` sends arbitrary source directly to the sandbox with no validation.

**Recommended fix:** Recompute AST validation before every execution, refuse execution unless checks pass, gate `TEST_SCRIPT` behind developer-only behavior.

---

### H13. File upload `importCodexAuth` is fire-and-forget — unhandled rejection
**File:** `src/entrypoints/sidepanel/pages/SettingsPage.tsx:151-154`
**Found by:** Code Quality agent

```ts
file.text().then(importCodexAuth);  // unhandled rejection
```

No `.catch()` handler. Failed reads are completely silent. The `saving` state can get stuck at `true`.

**Recommended fix:** Use async/await with try/catch.

---

## IMPORTANT FINDINGS

### I1. Encryption key stored adjacent to ciphertext
**File:** `src/lib/storage.ts:67-73`
**Found by:** Security agent

AES-GCM key in `chrome.storage.local` alongside the encrypted tokens. Any read access to storage obtains both key and ciphertext.

---

### I2. `collectElementMeta` sends ALL element attributes to service worker
**File:** `src/lib/recording/element-selector.ts:180-194`
**Found by:** Security agent

All HTML attributes (including potentially sensitive `data-*`, `src` with auth tokens) are collected during recording and persisted to IndexedDB.

**Recommended fix:** Limit to a safe allowlist (`id`, `class`, `role`, `aria-label`, `data-testid`, `href`, `type`).

---

### I3. Silent error swallowing in all stores
**Files:** `src/entrypoints/sidepanel/stores/tasks-store.ts:36-98`, all stores
**Found by:** Architecture, Code Quality agents

Every `chrome.runtime.sendMessage` has `catch { /* ignore */ }`. Failures during task operations are silently dropped — UI shows stale data with no error indication.

---

### I4. Duplicate `getRecentNotifications` / `getUnreadCount` implementations
**Files:** `src/lib/db-helpers.ts:235-246`, `src/lib/notifications.ts:94-156`
**Found by:** Code Quality agent

Two different implementations with different sorting strategies. Background imports from `notifications.ts`, tests from `db-helpers.ts`.

---

### I5. `model: any` type defeats type safety across stores
**Files:** `src/entrypoints/sidepanel/stores/chat-store.ts:20`, `src/entrypoints/sidepanel/stores/wizard-store.ts:41`, `src/lib/explorer.ts:82,116`, `src/lib/security/security-review.ts:69`
**Found by:** Architecture, Code Quality agents

`model: any | null` (which is just `any`) means no compile-time shape checking for the model object passed to LLM calls.

---

### I6. Fixed 1-second sleep instead of CDP load events
**File:** `src/lib/humanized-page-handler.ts:151-153, 279-285`
**Found by:** Architecture, Code Quality agents

`goto` and `waitForLoadState` use hardcoded `setTimeout(1000)` instead of `Page.loadEventFired` or `Page.frameStoppedLoading`. Too slow for fast pages, too short for slow pages.

---

### I7. `Math.random()` for IDs instead of `crypto.randomUUID()`
**Files:** Multiple (`background.ts`, `wizard-store.ts`, `recording-store.ts`)
**Found by:** Architecture agent

`Math.random()` in a service worker uses a PRNG seeded at worker start. Rapid restarts can produce collisions. `crypto.randomUUID()` is available in all MV3 contexts.

---

### I8. `EncryptedCodexOAuth` type misplaced in `recording.ts`
**File:** `src/types/recording.ts:99-104`
**Found by:** Architecture, Code Quality agents

This OAuth credential type has no conceptual relationship to recordings. It belongs in `src/types/storage.ts` where `StorageLocal` already uses it.

---

### I9. `keystrokeTarget` left stale after `deactivate()` with empty buffer
**File:** `src/lib/recording/element-selector.ts:360-380`
**Found by:** Bug Detection agent

`flushKeystrokeBuffer()` returns early without resetting `keystrokeTarget` when the buffer is empty. A subsequent `activate()` on a new page may call `collectElementMeta` on a detached DOM node.

---

### I10. `disconnect()` doesn't reject pending RPCs
**File:** `src/lib/rpc-client.ts:81-87`
**Found by:** Bug Detection agent

Pending RPCs hang for up to 60s (`RPC_TIMEOUT_MS`) after manual disconnect. Should reject all pending RPCs before calling `port.disconnect()`.

---

### I11. Stale `useEffect` dependency arrays across UI
**Files:** `App.tsx`, `ChatPage.tsx`, `SettingsPage.tsx`, `CreateTaskWizard.tsx`
**Found by:** Code Quality agent

Empty `[]` dependency arrays capture store actions in closures. While Zustand actions are stable in practice, this bypasses `exhaustive-deps` lint rules and masks real bugs if non-stable values are captured.

---

### I12. No minimum interval guard in scheduler
**File:** `src/lib/scheduler.ts:15-19`
**Found by:** Code Quality agent

Chrome Alarms API enforces minimum 1 minute for `periodInMinutes`, silently clamping lower values. Stored task says `0` minutes while actual alarm fires at 1 minute — permanent mismatch.

---

### I13. Wrong SHA-256 test value (63 chars instead of 64)
**File:** `src/lib/export-import.test.ts:297`
**Found by:** Bug Detection agent

The hardcoded SHA-256 expected value for "hello world" is 63 hex characters (one short). Will always fail against real `crypto.subtle.digest`.

---

## Architecture Strengths (noted by Architecture agent)

- **Message-type system** (`src/lib/messages.ts`) is centralized, well-typed, and extensible
- **RPC system** (`RPCHandler`/`RPCClient`) is clean, correctly decoupled, with proper timeout and disconnect handling
- **IndexedDB layer** has good separation between schema (`db.ts`) and domain logic (`db-helpers.ts`)
- **Security model** is multi-layered with domain guards at three enforcement points
- **Store responsibilities** are well-separated with no cross-store mutation
- **Test coverage** is broad — parallel `.test.ts` files for virtually every module

---

## Priority Remediation Order

1. **Replace `new Function` with QuickJS WASM** (C1, C4) — the entire sandbox security model depends on this
2. **Fix `postMessage` origin validation** (C3, C4) — `'*'` target in both directions + iframe navigation = full RPC hijack
3. **Enforce security gates at execution time** (H12) — AST/review flags are stored but never checked
4. **Fix remote mode security gaps** (H10, H11) — tab ownership + sensitive page bypass
5. **Fix concurrent execution bugs** (C6, H9) — result mix-up, abort controller overwrite
6. **Fix recording session ID divergence** (C5) — store/service worker ID mismatch
7. **Fix `onMessageExternal` async contract** (H1) — remote handler responses silently fail
8. **Address remaining High issues** (H2-H8, H13)
9. **Clean up Important issues** (I1-I13)
