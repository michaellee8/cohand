# Review Remediation Design — 32 Findings

**Date:** 2026-03-12
**Source:** `docs/REVIEW_REPORT_20260312.md`
**Approach:** Sequential by subsystem, harden-then-build, with regression tests per phase

---

## Overview

3 sequential phases addressing all 32 findings from the multi-agent code review. Each phase targets one subsystem with minimal file overlap. Within each phase: harden existing code first, then do structural work, then add regression tests. Verification gate (unit tests + build) between phases.

---

## Phase 1 — Sandbox/Execution

**Findings addressed:** C1, C2, C3, C4, H9, H12 (+ I6, I7 partial)

### Step 1: Harden AST validator (C2)

File: `src/lib/security/ast-validator.ts`

- Block ALL computed member access with non-literal keys universally, not just on global objects. Change the condition at lines 57-61 to apply to all objects.
- Add string concatenation detection: flag `BinaryExpression` nodes with `+` operator where either side is a string literal containing blocked substrings (`constructor`, `__proto__`, `prototype`).
- Add tests: bypass attempts using `page.goto['constr'+'uctor']`, `obj[variable]`, prototype chain traversal.

### Step 2: Fix postMessage origins (C3, C4)

Files: `src/lib/sandbox-bridge.ts`, `src/entrypoints/sandbox/main.ts`, `src/entrypoints/offscreen/index.html`

- Replace `'*'` with `chrome.runtime.getURL('')` origin in `sendToSandbox()` (line 103).
- Replace `'*'` in sandbox's `window.parent.postMessage` (line 32) with the extension origin.
- Add `event.origin` check in the `SandboxBridge` message listener (line 50) — reject messages not from the expected sandbox origin.
- Add `sandbox="allow-scripts"` attribute to the iframe in `offscreen/index.html` — prevents navigation away from the sandbox page.
- Add test: verify messages with wrong origin are rejected.

### Step 3: Enforce security gates at execution time (H12)

File: `src/entrypoints/background.ts`

- In `EXECUTE_TASK` handler: re-run `validateAST()` on the script source before sending to sandbox. Reject execution if validation fails.
- In `TEST_SCRIPT` handler: also run `validateAST()` before execution.
- Add tests: verify execution is blocked when AST validation fails.

### Step 4: Add per-execution IDs (H9)

Files: `sandbox/main.ts`, `sandbox-bridge.ts`, `offscreen/main.ts`

- Add `executionId: string` to `execute-script` and `execute-script-result` message payloads.
- Generate `executionId` via `crypto.randomUUID()` in the bridge before sending.
- Match `executionId` in the result listener before resolving.
- Add test: two overlapping executions return correct results to correct callers.

### Step 5: Integrate QuickJS WASM (C1, C4)

Files: `sandbox/main.ts`, `script-executor.ts`, new `src/lib/quickjs-runner.ts`

- Add `quickjs-emscripten` (or similar) as dependency.
- Create `quickjs-runner.ts`: initializes QuickJS runtime, exposes `executeInQuickJS(source, pageProxy, context)` that runs source in an isolated WASM heap.
- The `page` object is exposed as a host-callback proxy — each method (`click`, `goto`, `type`, etc.) calls back to the parent via postMessage RPC, same as today but the script itself can't access browser globals.
- Replace `new Function` in `sandbox/main.ts` with `executeInQuickJS()`.
- Update CSP in `sandbox/index.html` to remove any eval-related directives, keep `'wasm-unsafe-eval'`.
- Add tests: verify scripts cannot access `window`, `document`, `fetch`, or `Function.constructor`.

### Phase 1 Tests

- `ast-validator.test.ts`: Bypass attempt cases — `page.goto['constr'+'uctor']`, `obj[variable]`, `[].fill.constructor`, prototype chain. All must fail.
- `sandbox-bridge.test.ts`: Origin rejection test + `executionId` mismatch test.
- `quickjs-runner.test.ts` (new): Scripts cannot access browser globals. Page proxy only exposes whitelisted methods.
- Background handler tests: `EXECUTE_TASK` and `TEST_SCRIPT` reject when `validateAST()` fails.

**Verification gate:** `npm test` + `npx wxt build`

---

## Phase 2 — Background/Remote

**Findings addressed:** C6, H1, H2, H4, H5, H7, H8, H10, H11, I10

### Step 1: Extract execution orchestrator (C6)

New file: `src/lib/execution-orchestrator.ts`

- Move `executeTaskAsync` (lines 279-387) into new module.
- Accept dependencies as context: `{ db, cdp, taskTabMap, executionAbortControllers, claimTab, releaseTab }`.
- Fix `releaseTab` bug: track `let claimed = false`, set `true` only after `claimTab` succeeds, only release in `finally` if `claimed`.
- Add concurrent execution guard: check `executionAbortControllers.has(taskId)` at entry, return early or abort previous.
- Background.ts becomes thin registration file.

### Step 2: Unify message listeners (H8)

Files: `src/entrypoints/background.ts`, `src/lib/messages.ts`

- Add `RECORDING_ACTION` to the `Message` discriminated union in `messages.ts`.
- Register via `router.on('RECORDING_ACTION', ...)`.
- Remove duplicate `chrome.runtime.onMessage.addListener` (lines 581-622).

### Step 3: Fix async remote handler (H1)

File: `src/lib/remote/remote-server.ts`

- Return synchronous function with internal async IIFE:
```ts
return (message, sender, sendResponse) => {
  (async () => { /* existing logic */ })()
    .then(result => sendResponse(result))
    .catch(err => sendResponse({ error: err.message }));
  return true;
};
```

### Step 4: Sanitize recording action spread (H2)

File: `src/entrypoints/background.ts`

- Replace `...msg.action` with explicit destructuring of known fields only.
- Validate `action` is one of `'click' | 'type' | 'navigate' | 'scroll'`.
- `id`, `recordingId`, `sequenceIndex`, `status` always set by service worker.

### Step 5: Fix remaining handler issues (H4, H5, H7)

- **H4** (`humanized-page-handler.ts`): Register `notify` with raw handler, skip domain validation.
- **H5** (`rpc-handler.ts:31`): Change `type: 'SelectorNotFound'` to `type: 'Unknown'`.
- **H7** (`background.ts:483`): Wrap `captureVisibleTab` in try/catch, guard `tab.windowId`.

### Step 6: Remote security hardening (H10, H11)

- **H10**: Change tab ownership from `'local' | 'remote'` to `{ owner: 'local' | 'remote', sessionId?: string }`. Verify `sessionId` on `remote:release`.
- **H11**: Add `isSensitivePage(tabUrl)` check in remote relay CDP dispatch. Block `Page.navigate` to sensitive paths.

### Step 7: Fix RPC client disconnect (I10)

File: `src/lib/rpc-client.ts`

- In `disconnect()`: iterate `this.pending`, clear timers, reject with `RPCError({ type: 'OwnerDisconnected' })`, clear map, then `port.disconnect()`.

### Phase 2 Tests

- `execution-orchestrator.test.ts` (new): Concurrent guard, releaseTab-only-if-claimed, abort controller tracking.
- `remote-server.test.ts`: Synchronous `true` return, `sendResponse` called after async.
- `remote-relay.test.ts`: `isSensitivePage()` blocks sensitive paths, `remote:release` rejects mismatched session.
- `rpc-handler.test.ts`: Unknown method returns `type: 'Unknown'`.
- `message-router.test.ts`: `RECORDING_ACTION` routes through router.

**Verification gate:** `npm test` + `npx wxt build`

---

## Phase 3 — UI/Stores + Cleanup

**Findings addressed:** C5, H3, H6, H13, I1-I5, I8-I9, I11-I13

### Recording fixes

- **C5** (`recording-store.ts`): Remove client-side `sessionId` generation. Await `START_RECORDING` response and use returned `sessionId`.
- **H6** (`recording/speech.ts`): Add `let sessionActive = false` flag. Gate all callbacks behind `if (!sessionActive) return`. Set on start, clear on stop before `abort()`.
- **I9** (`recording/element-selector.ts`): After `flushKeystrokeBuffer()` in `deactivate()`, explicitly set `keystrokeTarget = null; keystrokeBuffer = '';`.

### Component/Store fixes

- **H3** (`CreateTaskWizard.tsx`): Make `createTask()` return `boolean`. Check before `onComplete()`.
- **H13** (`SettingsPage.tsx`): Convert `onChange` to async with try/catch around `importCodexAuth`.
- **I3** (all stores): Replace `catch { /* ignore */ }` with `catch (e) { set({ error: String(e) }); }`. Wire up existing `error` fields.
- **I5** (`chat-store.ts`, `wizard-store.ts`, `explorer.ts`, `security-review.ts`): Import concrete model type from `@mariozechner/pi-ai` or use `ReturnType<typeof resolveModel>`. Replace all `any` model references.
- **I11** (multiple components): Use `useStore.getState().action()` inside effects instead of capturing in closures.

### Type/Code cleanup

- **I8** (`types/recording.ts`): Move `EncryptedCodexOAuth` to `src/types/storage.ts`. Update import.
- **I4** (`db-helpers.ts`): Remove duplicate `getRecentNotifications`, `getUnreadCount`, `markAsRead`. Update test imports to `notifications.ts`.
- **I13** (`export-import.test.ts:297`): Delete hardcoded known-hash test.
- **I12** (`scheduler.ts`): Add `Math.max(1, task.schedule.intervalMinutes)` before `chrome.alarms.create`.
- **I7** (multiple files): Replace `${Date.now()}-${Math.random().toString(36).slice(2,8)}` with `crypto.randomUUID()`.

### Acknowledged, no code change

- **I1** (encryption key adjacent to ciphertext): Architectural trade-off in Chrome extensions — no hardware keystore API available. Document the security boundary in a code comment.
- **I2** (`element-selector.ts`): Apply attribute allowlist (`id`, `class`, `role`, `aria-label`, `data-testid`, `href`, `type`). Flag potential recording fidelity impact — test with E2E recording spec.

### Phase 3 Tests

- Recording store tests: `session.id` from service worker response.
- Speech tests: Rapid stop/start doesn't double-start.
- Update existing tests where behavior changes (wizard return value, store error propagation, scheduler min interval).
- Run full Playwright E2E suite (`npm run test:pw`) as final validation.

**Verification gate:** `npm test` + `npx wxt build` + `npm run test:pw`

---

## Summary

| Phase | Findings | Key files created/modified | Est. test additions |
|-------|----------|---------------------------|-------------------|
| 1. Sandbox/Execution | C1-C4, H9, H12 | `quickjs-runner.ts` (new), `ast-validator.ts`, `sandbox-bridge.ts`, `sandbox/main.ts` | ~15-20 test cases |
| 2. Background/Remote | C6, H1-H2, H4-H5, H7-H8, H10-H11, I10 | `execution-orchestrator.ts` (new), `background.ts`, `remote-server.ts`, `remote-relay.ts` | ~12-15 test cases |
| 3. UI/Stores + Cleanup | C5, H3, H6, H13, I1-I13 | All stores, components, type files, scheduler | ~8-10 test cases |
