# Cohand Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the Cohand Chrome extension from design doc to working MVP.

**Architecture:** Chrome MV3 extension with WXT build system, React side panel, QuickJS WASM sandbox in offscreen/sandboxed-iframe, service worker message router with CDP humanization, content script a11y tree.

**Tech Stack:** TypeScript, WXT, React 19, Tailwind CSS v4, zustand, quickjs-emscripten, OpenAI SDK, Vitest, IndexedDB

---

## Milestone 1: Project Foundation

### Task 1.1: Initialize WXT project with TypeScript

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `wxt.config.ts`
- Create: `.gitignore`
- Create: `tailwind.config.ts`
- Create: `postcss.config.ts`

**Step 1: Initialize project**

```bash
cd /home/sb1/repos/cohand
npm init -y
npm install wxt react react-dom zustand @anthropic-ai/sdk openai
npm install -D typescript @types/react @types/react-dom @types/chrome tailwindcss @tailwindcss/vite postcss vitest
```

**Step 2: Create wxt.config.ts**

```typescript
import { defineConfig } from 'wxt';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  srcDir: 'src',
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Cohand',
    description: 'Prompt once, automate forever.',
    minimum_chrome_version: '125',
    permissions: [
      'debugger', 'sidePanel', 'storage', 'activeTab', 'scripting',
      'tabs', 'tabGroups', 'alarms', 'notifications', 'offscreen',
      'unlimitedStorage',
    ],
    host_permissions: ['<all_urls>'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'",
    },
    sandbox: {
      pages: ['sandbox.html'],
    },
  },
  vite: () => ({
    plugins: [tailwindcss()],
  }),
});
```

**Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "types": ["chrome"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules"]
}
```

**Step 4: Create .gitignore**

```
node_modules/
.output/
dist/
.wxt/
*.tsbuildinfo
```

**Step 5: Verify build**

Run: `npx wxt build`
Expected: Build succeeds (may warn about missing entrypoints)

**Step 6: Commit**

```bash
git add -A && git commit -m "feat: initialize WXT project with TypeScript and React"
```

---

### Task 1.2: Create extension entrypoint shells

**Files:**
- Create: `src/entrypoints/background.ts`
- Create: `src/entrypoints/sidepanel/index.html`
- Create: `src/entrypoints/sidepanel/index.tsx`
- Create: `src/entrypoints/sidepanel/App.tsx`
- Create: `src/entrypoints/sidepanel/main.css`
- Create: `src/entrypoints/content.ts`
- Create: `src/entrypoints/offscreen.html`
- Create: `src/entrypoints/offscreen.ts`
- Create: `src/sandbox.html`
- Create: `src/sandbox.ts`

**Step 1: Create service worker shell**

```typescript
// src/entrypoints/background.ts
export default defineBackground(() => {
  console.log('[Cohand] Service worker started');

  // Register side panel
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
});
```

**Step 2: Create side panel shell**

```tsx
// src/entrypoints/sidepanel/App.tsx
export function App() {
  return <div className="p-4"><h1 className="text-lg font-bold">Cohand</h1></div>;
}
```

With standard React 19 index.tsx mounting and index.html with Tailwind import.

**Step 3: Create content script shell**

```typescript
// src/entrypoints/content.ts
export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    console.log('[Cohand] Content script loaded');
  },
});
```

**Step 4: Create offscreen document shell**

Minimal HTML + TS that creates the sandboxed iframe.

**Step 5: Create sandbox shell**

Minimal HTML with `<script src="sandbox.ts">` — this will host QuickJS later.

**Step 6: Verify build and load in Chrome**

Run: `npx wxt build`
Load unpacked from `.output/chrome-mv3/`. Verify side panel opens, service worker runs, content script injects.

**Step 7: Commit**

```bash
git add -A && git commit -m "feat: add extension entrypoint shells"
```

---

### Task 1.3: Set up shared types and constants

**Files:**
- Create: `src/types/task.ts`
- Create: `src/types/script.ts`
- Create: `src/types/rpc.ts`
- Create: `src/types/storage.ts`
- Create: `src/types/notification.ts`
- Create: `src/constants.ts`

**Step 1: Define core TypeScript interfaces**

All interfaces from design doc Section 6 (Data Model): `Task`, `TaskSchedule`, `ScriptVersion`, `ReviewDetail`, `ScriptRun`, `TaskState`, `StateSnapshot`, `TaskNotification`, `LlmUsageRecord`.

RPC types from Section 4: `ScriptRPC`, `ScriptRPCResult`, `ScriptRPCErrorType`.

Storage types from Section 6: `StorageLocal`, `DomainPermission`.

**Step 2: Define constants**

```typescript
// src/constants.ts
export const DB_NAME = 'cohand';
export const DB_VERSION = 1;
export const MAX_STATE_SIZE = 1024 * 1024; // 1MB
export const MAX_TEXT_CONTENT_LENGTH = 500;
export const MAX_CUMULATIVE_READS = 50 * 1024; // 50KB
export const MAX_NOTIFICATIONS_PER_TASK_PER_HOUR = 10;
export const MAX_SCRIPT_VERSIONS = 10;
export const MAX_RUNS_PER_TASK = 100;
export const QUICKJS_MEMORY_LIMIT = 32 * 1024 * 1024; // 32MB
export const QUICKJS_TIMEOUT_MS = 5 * 60 * 1000; // 5 min
export const QUICKJS_MODULE_POOL_SIZE = 3;
export const RPC_TIMEOUT_MS = 60_000; // 60s per RPC
export const HUMANIZE_ACTIONS_PER_HOUR = 15;
export const REPAIR_BUDGET = 2;
export const WEBSOCKET_PORT = 19988;
```

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add shared types and constants"
```

---

## Milestone 2: Storage Layer

### Task 2.1: IndexedDB database module

**Files:**
- Create: `src/lib/db.ts`
- Create: `src/lib/db.test.ts`

**Step 1: Write failing test**

```typescript
// src/lib/db.test.ts
import { describe, it, expect } from 'vitest';
import { openDB, DB_STORES } from './db';

// Use fake-indexeddb for tests
import 'fake-indexeddb/auto';

describe('openDB', () => {
  it('creates all v1 stores and indexes', async () => {
    const db = await openDB();
    expect(db.objectStoreNames).toContain('tasks');
    expect(db.objectStoreNames).toContain('script_versions');
    expect(db.objectStoreNames).toContain('script_runs');
    expect(db.objectStoreNames).toContain('task_state');
    expect(db.objectStoreNames).toContain('state_snapshots');
    expect(db.objectStoreNames).toContain('notifications');
    expect(db.objectStoreNames).toContain('llm_usage');
    db.close();
  });
});
```

Run: `npx vitest run src/lib/db.test.ts`
Expected: FAIL

**Step 2: Implement openDB**

```typescript
// src/lib/db.ts
import { DB_NAME, DB_VERSION } from '../constants';

export function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = request.result;
      const old = event.oldVersion;
      if (old < 1) {
        // tasks
        const tasks = db.createObjectStore('tasks', { keyPath: 'id' });
        tasks.createIndex('by_updated', 'updatedAt');

        // script_versions
        const sv = db.createObjectStore('script_versions', { keyPath: 'id' });
        sv.createIndex('by_task_version', ['taskId', 'version'], { unique: true });
        sv.createIndex('by_task', 'taskId');

        // script_runs
        const sr = db.createObjectStore('script_runs', { keyPath: 'id' });
        sr.createIndex('by_task_time', ['taskId', 'ranAt']);
        sr.createIndex('by_task_success_time', ['taskId', 'success', 'ranAt']);

        // task_state
        db.createObjectStore('task_state', { keyPath: 'taskId' });

        // state_snapshots
        const ss = db.createObjectStore('state_snapshots', { keyPath: 'id' });
        ss.createIndex('by_task', 'taskId');

        // notifications
        const notif = db.createObjectStore('notifications', { keyPath: 'id' });
        notif.createIndex('by_task_time', ['taskId', 'createdAt']);
        notif.createIndex('by_created', 'createdAt');
        notif.createIndex('by_read_status', 'isRead');

        // llm_usage
        const llm = db.createObjectStore('llm_usage', { keyPath: 'id' });
        llm.createIndex('by_created', 'createdAt');
        llm.createIndex('by_task', ['taskId', 'createdAt']);
      }
    };
  });
}
```

**Step 3: Run tests**

Run: `npx vitest run src/lib/db.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add IndexedDB schema with v1 stores and indexes"
```

---

### Task 2.2: IndexedDB CRUD helpers

**Files:**
- Create: `src/lib/db-helpers.ts`
- Create: `src/lib/db-helpers.test.ts`

**Step 1: Write failing tests for task CRUD**

Tests for: `putTask`, `getTask`, `getAllTasks`, `deleteTask`.

**Step 2: Implement task CRUD**

Generic helpers: `putRecord(db, store, record)`, `getRecord(db, store, key)`, `getAllByIndex(db, store, index, query)`, `deleteRecord(db, store, key)`. Then task-specific wrappers.

**Step 3: Write failing tests for script version CRUD**

Tests for: `putScriptVersion`, `getScriptVersionsForTask`, `getLatestVersion`.

**Step 4: Implement script version CRUD**

**Step 5: Write failing tests for script runs**

Tests for: `addScriptRun`, `getRunsForTask(taskId, limit)`, `capRuns(taskId, max)`.

**Step 6: Implement script runs with capping**

**Step 7: Repeat for task_state, notifications, llm_usage**

**Step 8: Run all tests**

Run: `npx vitest run src/lib/db-helpers.test.ts`
Expected: ALL PASS

**Step 9: Commit**

```bash
git add -A && git commit -m "feat: add IndexedDB CRUD helpers with capping"
```

---

### Task 2.3: chrome.storage.local wrapper

**Files:**
- Create: `src/lib/storage.ts`
- Create: `src/lib/storage.test.ts`

**Step 1: Write failing tests**

Test `getSettings`, `setSettings`, `getDomainPermissions`, `addDomainPermission`, `getStorageSchemaVersion`, `migrateStorage`.

**Step 2: Implement typed wrappers**

```typescript
// src/lib/storage.ts
import type { StorageLocal, DomainPermission } from '../types/storage';

export async function getSettings(): Promise<StorageLocal['settings']> {
  const result = await chrome.storage.local.get('settings');
  return result.settings ?? DEFAULT_SETTINGS;
}
```

**Step 3: Implement token encryption/decryption**

Use Web Crypto API (`crypto.subtle.encrypt/decrypt` with AES-GCM). Derive key from a random salt stored alongside. This is defense-in-depth (not against extension compromise, but against raw file access).

**Step 4: Run tests, commit**

```bash
git add -A && git commit -m "feat: add chrome.storage.local typed wrapper with encryption"
```

---

## Milestone 3: Message Router & RPC

### Task 3.1: Service worker message router

**Files:**
- Create: `src/lib/messages.ts` (message type definitions)
- Modify: `src/entrypoints/background.ts`
- Create: `src/lib/message-router.ts`
- Create: `src/lib/message-router.test.ts`

**Step 1: Define message types**

```typescript
// src/lib/messages.ts
export type Message =
  | { type: 'EXECUTE_SCRIPT'; taskId: string; tabId: number }
  | { type: 'CANCEL_EXECUTION'; taskId: string }
  | { type: 'GET_A11Y_TREE'; tabId: number }
  | { type: 'ATTACH_DEBUGGER'; tabId: number }
  | { type: 'DETACH_DEBUGGER'; tabId: number }
  | { type: 'CDP_COMMAND'; tabId: number; method: string; params?: unknown }
  | { type: 'SCREENSHOT'; tabId: number }
  | { type: 'CREATE_TASK'; task: Task }
  | { type: 'UPDATE_TASK'; task: Task }
  | { type: 'DELETE_TASK'; taskId: string }
  // ... more as needed

export type MessageResponse<T extends Message['type']> = /* mapped type */
```

**Step 2: Implement router in background.ts**

```typescript
chrome.runtime.onMessage.addListener((message: Message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse);
  return true; // async response
});
```

**Step 3: Test with mock chrome API, commit**

```bash
git add -A && git commit -m "feat: add service worker message router"
```

---

### Task 3.2: Offscreen-to-service-worker RPC port

**Files:**
- Create: `src/lib/rpc-port.ts`
- Create: `src/lib/rpc-port.test.ts`
- Modify: `src/entrypoints/background.ts`
- Modify: `src/entrypoints/offscreen.ts`

**Step 1: Write failing test for RPC request/response matching**

**Step 2: Implement RPC client (offscreen side)**

```typescript
// src/lib/rpc-port.ts
export class RPCClient {
  private port: chrome.runtime.Port;
  private pending = new Map<number, { resolve: Function; reject: Function; timer: number }>();
  private nextId = 1;

  connect() {
    this.port = chrome.runtime.connect({ name: 'script-rpc' });
    this.port.onMessage.addListener((msg: ScriptRPCResult) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      clearTimeout(entry.timer);
      this.pending.delete(msg.id);
      if (msg.ok) entry.resolve(msg.value);
      else entry.reject(new RPCError(msg.error!));
    });
    this.port.onDisconnect.addListener(() => {
      // Reject all pending
      for (const [id, entry] of this.pending) {
        clearTimeout(entry.timer);
        entry.reject(new RPCError({ type: 'OwnerDisconnected', message: 'Port disconnected' }));
      }
      this.pending.clear();
    });
  }

  call(rpc: Omit<ScriptRPC, 'id'>): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RPCError({ type: 'DeadlineExceeded', message: 'RPC timeout' }));
      }, rpc.deadline ? rpc.deadline - Date.now() : RPC_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.port.postMessage({ ...rpc, id });
    });
  }
}
```

**Step 3: Implement RPC handler (service worker side)**

Listen for `chrome.runtime.onConnect` with name `'script-rpc'`, dispatch to CDP handler.

**Step 4: Run tests, commit**

```bash
git add -A && git commit -m "feat: add RPC port protocol between offscreen and service worker"
```

---

### Task 3.3: Offscreen-to-sandbox postMessage bridge

**Files:**
- Modify: `src/entrypoints/offscreen.ts`
- Modify: `src/sandbox.ts`
- Create: `src/lib/sandbox-bridge.ts`
- Create: `src/lib/sandbox-bridge.test.ts`

**Step 1: Implement postMessage protocol between offscreen doc and sandboxed iframe**

The offscreen document hosts the iframe. Script execution requests flow: sandbox iframe -> postMessage -> offscreen -> RPC port -> service worker.

**Step 2: Implement sandbox-side host function registration**

In sandbox.ts, register host functions (`page.click`, `page.fill`, etc.) that send postMessage to parent and await response.

**Step 3: Test, commit**

```bash
git add -A && git commit -m "feat: add offscreen-to-sandbox postMessage bridge"
```

---

## Milestone 4: Content Script & Page Observation

### Task 4.1: A11y tree generator

**Files:**
- Create: `src/lib/a11y-tree.ts`
- Create: `src/lib/a11y-tree.test.ts`
- Modify: `src/entrypoints/content.ts`

**Step 1: Write failing test for tree generation**

Use jsdom or happy-dom to test DOM -> a11y tree conversion.

**Step 2: Implement `generateAccessibilityTree()`**

Walk DOM tree, extract: role (from ARIA or implicit), name (from aria-label, textContent, alt), ref_id (data-cohand-ref assigned dynamically), interactive state, bounding box.

Handle Shadow DOM via `element.shadowRoot?.children`.

**Step 3: Implement cross-frame merging via message passing**

Content script instances in iframes send their subtrees to the top-level content script.

**Step 4: Register message handler in content script**

```typescript
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'GET_A11Y_TREE') {
    sendResponse(generateAccessibilityTree());
  }
});
```

**Step 5: Test, commit**

```bash
git add -A && git commit -m "feat: add content script a11y tree generator"
```

---

### Task 4.2: Screenshot capture

**Files:**
- Create: `src/lib/screenshot.ts`

**Step 1: Implement screenshot wrapper**

```typescript
export async function captureScreenshot(tabId: number): Promise<string> {
  return chrome.tabs.captureVisibleTab(
    (await chrome.tabs.get(tabId)).windowId,
    { format: 'png' }
  );
}
```

**Step 2: Commit**

```bash
git add -A && git commit -m "feat: add screenshot capture via tabs API"
```

---

## Milestone 5: CDP & Humanization

### Task 5.1: Chrome debugger manager

**Files:**
- Create: `src/lib/cdp.ts`
- Create: `src/lib/cdp.test.ts`

**Step 1: Implement debugger attach/detach with reference counting**

```typescript
export class CDPManager {
  private attached = new Map<number, { refCount: number; epoch: number }>();

  async attach(tabId: number): Promise<void> { /* ... */ }
  async detach(tabId: number): Promise<void> { /* ... */ }
  async send(tabId: number, method: string, params?: object): Promise<unknown> { /* ... */ }
  getEpoch(tabId: number): number { /* ... */ }
}
```

**Step 2: Implement pageEpoch tracking**

Listen to `chrome.debugger.onDetach`, `chrome.debugger.onEvent` for `Target.detachedFromTarget` and frame navigations. Increment epoch.

**Step 3: Test, commit**

```bash
git add -A && git commit -m "feat: add CDP manager with pageEpoch tracking"
```

---

### Task 5.2: Selector resolution (DOM-first pipeline)

**Files:**
- Create: `src/lib/selector-resolver.ts`
- Create: `src/lib/selector-resolver.test.ts`

**Step 1: Implement DOM-first selector resolution**

```
DOM.getDocument({pierce:true})
  -> DOM.querySelector(selector)
  -> DOM.scrollIntoViewIfNeeded
  -> DOM.getContentQuads
  -> return {nodeId, centerX, centerY, bounds}
```

For role/name selectors (`getByRole`, `getByText`, `getByLabel`): use `Accessibility.queryAXTree` instead.

**Step 2: Test, commit**

```bash
git add -A && git commit -m "feat: add DOM-first selector resolution pipeline"
```

---

### Task 5.3: Humanized action handlers

**Files:**
- Create: `src/lib/humanize.ts`
- Create: `src/lib/humanize.test.ts`
- Create: `src/lib/prng.ts`

**Step 1: Implement seeded PRNG**

```typescript
// src/lib/prng.ts
export function createPRNG(seed: string): () => number {
  // Mulberry32 seeded from string hash
}
```

**Step 2: Implement Bezier mouse curve**

Generate 20-50 points along a cubic Bezier from lastPosition to target with random control points.

**Step 3: Implement humanized click**

Bezier curve -> hover delay (100-300ms) -> mousePressed -> pause (50-150ms) -> mouseReleased.

**Step 4: Implement humanized type**

Variable keystroke timing (40-200ms), 3% typo chance with backspace correction.

**Step 5: Implement humanized scroll**

Momentum simulation with reading pauses.

**Step 6: Track per-tab mouse position**

**Step 7: Test, commit**

```bash
git add -A && git commit -m "feat: add humanized action handlers with seeded PRNG"
```

---

### Task 5.4: HumanizedPage RPC handler

**Files:**
- Create: `src/lib/humanized-page-handler.ts`
- Create: `src/lib/humanized-page-handler.test.ts`

**Step 1: Implement RPC dispatch**

Map RPC method names to humanized actions:
- `'goto'` -> `cdp.send('Page.navigate', {url})` + wait
- `'click'` -> resolve selector -> humanized click sequence
- `'fill'` -> resolve selector -> click -> select all -> humanized type
- `'type'` -> resolve selector -> humanized type (append)
- `'scroll'` -> humanized scroll
- `'waitForSelector'` -> poll via CDP
- `'waitForLoadState'` -> listen to CDP page events
- `'url'` / `'title'` -> CDP query
- `'textContent'` -> CDP DOM.querySelector + get text (capped 500 chars)
- `'getAttribute'` -> CDP DOM.querySelector + get attribute (whitelist enforced)

**Step 2: Implement domain validation**

Before every CDP command, check target tab URL against task's allowedDomains.

**Step 3: Implement cumulative byte tracking**

Track total bytes read via textContent/getAttribute per execution. Alert at 50KB.

**Step 4: Test, commit**

```bash
git add -A && git commit -m "feat: add HumanizedPage RPC handler with domain validation"
```

---

## Milestone 6: QuickJS WASM Sandbox

### Task 6.1: QuickJS module pool

**Files:**
- Create: `src/sandbox/quickjs-pool.ts`
- Create: `src/sandbox/quickjs-pool.test.ts`

**Step 1: Install quickjs-emscripten**

```bash
npm install quickjs-emscripten
```

**Step 2: Implement module pool**

```typescript
export class QuickJSPool {
  private modules: QuickJSAsyncWASMModule[] = [];
  private available: QuickJSAsyncWASMModule[] = [];

  async init(size: number = 3): Promise<void> {
    for (let i = 0; i < size; i++) {
      const mod = await newQuickJSAsyncWASMModule();
      this.modules.push(mod);
      this.available.push(mod);
    }
  }

  acquire(): QuickJSAsyncWASMModule | null {
    return this.available.pop() ?? null;
  }

  release(mod: QuickJSAsyncWASMModule): void {
    this.available.push(mod);
  }
}
```

**Step 3: Test, commit**

```bash
git add -A && git commit -m "feat: add QuickJS WASM module pool"
```

---

### Task 6.2: Script executor in sandbox

**Files:**
- Create: `src/sandbox/executor.ts`
- Modify: `src/sandbox.ts`

**Step 1: Implement script execution**

```typescript
export async function executeScript(
  pool: QuickJSPool,
  source: string,
  taskId: string,
  hostCallFn: (method: string, args: unknown) => Promise<unknown>,
  state: Record<string, unknown>,
): Promise<{ result: unknown; state: Record<string, unknown> }> {
  const mod = pool.acquire();
  if (!mod) throw new Error('No QuickJS modules available');

  try {
    const ctx = mod.newContext();
    ctx.runtime.setMemoryLimit(QUICKJS_MEMORY_LIMIT);
    ctx.runtime.setInterruptHandler(() => /* check 5-min timeout */);

    // Register host functions: page.click, page.fill, etc.
    // Each sends postMessage to parent (offscreen) and awaits response
    registerHostFunctions(ctx, hostCallFn);

    // Register state object
    registerState(ctx, state);

    // Register notify function
    registerNotify(ctx, hostCallFn);

    // Evaluate and call run()
    const result = await ctx.evalCodeAsync(`
      ${source}
      ;(async () => run(page, context))()
    `);

    // Extract result and updated state
    const jsResult = ctx.dump(result);
    result.dispose();
    ctx.dispose();

    return { result: jsResult, state };
  } finally {
    pool.release(mod);
  }
}
```

**Step 2: Wire into sandbox.ts postMessage handler**

**Step 3: Test (unit test with mock host functions), commit**

```bash
git add -A && git commit -m "feat: add QuickJS script executor with host function bridge"
```

---

## Milestone 7: Security Pipeline

### Task 7.1: AST validation (Layer 2)

**Files:**
- Create: `src/lib/security/ast-validator.ts`
- Create: `src/lib/security/ast-validator.test.ts`

**Step 1: Install acorn**

```bash
npm install acorn acorn-walk
npm install -D @types/acorn
```

**Step 2: Write failing tests**

Test cases:
- Valid script passes
- `eval()` blocked
- `Function()` blocked
- `fetch()` blocked
- Computed member access on `globalThis` blocked
- `.__proto__` blocked
- `.constructor` blocked
- `import()` blocked
- Unicode escapes resolving to blocked names blocked
- `Proxy`, `Reflect` blocked

**Step 3: Implement AST validator**

Parse with acorn, walk with acorn-walk. Whitelist approach: only known HumanizedPage methods and standard control flow allowed.

**Step 4: Run tests, commit**

```bash
git add -A && git commit -m "feat: add AST validation security layer"
```

---

### Task 7.2: Dual-model security review (Layer 3)

**Files:**
- Create: `src/lib/security/security-review.ts`
- Create: `src/lib/security/security-review.test.ts`
- Create: `src/lib/security/prompts.ts`

**Step 1: Write review prompts**

Two differentiated prompts:
- Model 1: data flow focus ("Where does scraped data go?")
- Model 2: capability access focus ("What APIs/constructors does the script reach?")

Include adversarial few-shot examples.

**Step 2: Implement dual review**

```typescript
export async function securityReview(
  source: string,
  llmClient: LLMClient,
  previousApprovedSource?: string,
): Promise<{ approved: boolean; details: ReviewDetail[] }> {
  const [result1, result2] = await Promise.all([
    reviewWithModel(source, llmClient, 'data_flow', previousApprovedSource),
    reviewWithModel(source, llmClient, 'capability', previousApprovedSource),
  ]);
  return {
    approved: result1.approved && result2.approved,
    details: [result1, result2],
  };
}
```

Fail-closed: any error/timeout/malformed response = rejection.

**Step 3: Test with mocked LLM, commit**

```bash
git add -A && git commit -m "feat: add dual-model security review"
```

---

### Task 7.3: Output/injection scanner (Layer 5)

**Files:**
- Create: `src/lib/security/injection-scanner.ts`
- Create: `src/lib/security/injection-scanner.test.ts`

**Step 1: Implement scanner**

Scan script return values, state changes, and notifications before they're persisted/displayed. Fail-closed on error.

Content classification: flag emails, phone numbers, auth tokens, credit card patterns.

**Step 2: Test, commit**

```bash
git add -A && git commit -m "feat: add output injection scanner (fail-closed)"
```

---

### Task 7.4: Domain restriction enforcement (Layer 6)

**Files:**
- Create: `src/lib/security/domain-guard.ts`
- Create: `src/lib/security/domain-guard.test.ts`

**Step 1: Implement domain guard**

```typescript
export function isDomainAllowed(url: string, allowedDomains: string[]): boolean {
  const hostname = new URL(url).hostname;
  return allowedDomains.some(d =>
    hostname === d || hostname.endsWith('.' + d)
  );
}
```

Integrated into service worker RPC handler — reject CDP commands targeting disallowed domains.

**Step 2: Test, commit**

```bash
git add -A && git commit -m "feat: add domain restriction guard"
```

---

## Milestone 8: Side Panel UI

### Task 8.1: Tab navigation and layout

**Files:**
- Modify: `src/entrypoints/sidepanel/App.tsx`
- Create: `src/entrypoints/sidepanel/components/TabBar.tsx`
- Create: `src/entrypoints/sidepanel/pages/ChatPage.tsx`
- Create: `src/entrypoints/sidepanel/pages/TasksPage.tsx`
- Create: `src/entrypoints/sidepanel/pages/SettingsPage.tsx`

**Step 1: Implement tab bar with Chat and Tasks tabs, gear icon for Settings**

**Step 2: Wire up page routing**

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add side panel tab navigation"
```

---

### Task 8.2: Settings page and LLM configuration

**Files:**
- Create: `src/entrypoints/sidepanel/pages/SettingsPage.tsx`
- Create: `src/entrypoints/sidepanel/stores/settings-store.ts`

**Step 1: Implement settings form**

- LLM provider dropdown (ChatGPT Subscription, OpenAI, Anthropic, Gemini, Custom)
- Model selection
- API key / OAuth token input
- YOLO mode toggle (with warning dialog)
- Language selection
- Domain permissions list

**Step 2: Wire to chrome.storage.local via store**

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add settings page with LLM provider configuration"
```

---

### Task 8.3: Tasks dashboard

**Files:**
- Create: `src/entrypoints/sidepanel/pages/TasksPage.tsx`
- Create: `src/entrypoints/sidepanel/components/TaskCard.tsx`
- Create: `src/entrypoints/sidepanel/components/TaskDetail.tsx`
- Create: `src/entrypoints/sidepanel/stores/tasks-store.ts`

**Step 1: Implement task list with status indicators**

Each task card shows: name, last run time, success/failure, next scheduled run, "Run Now" button.

**Step 2: Implement task detail view**

Expandable: run history, script versions, state inspector.

**Step 3: Implement notification feed with unread badge**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add tasks dashboard with run history and notifications"
```

---

### Task 8.4: Chat interface

**Files:**
- Create: `src/entrypoints/sidepanel/pages/ChatPage.tsx`
- Create: `src/entrypoints/sidepanel/components/ChatMessage.tsx`
- Create: `src/entrypoints/sidepanel/stores/chat-store.ts`

**Step 1: Implement chat UI with message bubbles, input field, streaming display**

**Step 2: Wire to LLM client for streaming responses**

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add chat interface with LLM streaming"
```

---

### Task 8.5: LLM client

**Files:**
- Create: `src/lib/llm-client.ts`
- Create: `src/lib/llm-client.test.ts`

**Step 1: Implement multi-provider LLM client**

```typescript
export class LLMClient {
  private client: OpenAI;

  constructor(settings: StorageLocal['settings'], token: string) {
    this.client = new OpenAI({
      apiKey: token,
      baseURL: settings.llmBaseUrl,
      dangerouslyAllowBrowser: true,
    });
  }

  async chat(messages: ChatMessage[], opts?: { signal?: AbortSignal }): Promise<string> { /* ... */ }
  stream(messages: ChatMessage[], opts?: { signal?: AbortSignal }): AsyncIterable<string> { /* ... */ }
}
```

**Step 2: Test with mock, commit**

```bash
git add -A && git commit -m "feat: add multi-provider LLM client"
```

---

## Milestone 9: Explorer Agent & Script Generation

### Task 9.1: Explorer agent

**Files:**
- Create: `src/lib/explorer.ts`
- Create: `src/lib/explorer.test.ts`

**Step 1: Implement explorer**

Read-only page observation: gets a11y tree + screenshot, builds context for LLM.

Navigation clicks require user confirmation (with "don't ask again" per-domain).

Constraints: no typing, no JS execution, no form submission.

**Step 2: Implement script generation prompt**

Given: user's natural language task description, a11y tree, screenshot, allowed domains.
Output: JavaScript script in the `async function run(page, context)` format.

**Step 3: Test, commit**

```bash
git add -A && git commit -m "feat: add explorer agent with read-only page observation"
```

---

### Task 9.2: Task creation flow

**Files:**
- Create: `src/entrypoints/sidepanel/components/CreateTaskWizard.tsx`

**Step 1: Implement guided wizard**

1. Describe what you want to automate (text input)
2. Select target domains (auto-detected from current tab + manual add)
3. Explorer observes the page (progress indicators)
4. Script generated and security reviewed (show progress)
5. Test run (show result)
6. Optional: set schedule

**Step 2: Wire to explorer agent and script pipeline**

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add task creation wizard"
```

---

## Milestone 10: Self-Healing Loop

### Task 10.1: Self-healing loop

**Files:**
- Create: `src/lib/self-healing.ts`
- Create: `src/lib/self-healing.test.ts`

**Step 1: Implement version fallback**

On failure: try last_known_good -> try up to 2 previous versions -> LLM repair.

**Step 2: Implement LLM repair**

Build repair context (failing script, error, a11y tree, screenshot, expected schema, last good output, structural diff). Generate repaired script. Full security pipeline.

**Step 3: Implement tiered approval**

- Scraping scripts: auto-promote with notification + [Review] [Revert] actions
- Action scripts: require user approval with diff view

**Step 4: Implement degradation detection**

Track rolling success rate over last 10 runs. Flag if significantly degraded.

**Step 5: Implement repair budget (max 2 attempts)**

**Step 6: Test, commit**

```bash
git add -A && git commit -m "feat: add self-healing loop with tiered approval"
```

---

## Milestone 11: Scheduling & Notifications

### Task 11.1: Task scheduling via chrome.alarms

**Files:**
- Create: `src/lib/scheduler.ts`
- Modify: `src/entrypoints/background.ts`

**Step 1: Implement alarm management**

```typescript
export function scheduleTask(task: Task): void {
  if (task.schedule.type === 'interval') {
    chrome.alarms.create(`task:${task.id}`, {
      periodInMinutes: task.schedule.intervalMinutes,
    });
  }
}
```

**Step 2: Implement alarm handler in service worker**

On alarm fire -> open popup window with sidepanel.html -> execute task.

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add task scheduling via chrome.alarms"
```

---

### Task 11.2: Notification system

**Files:**
- Create: `src/lib/notifications.ts`
- Modify: `src/entrypoints/background.ts`

**Step 1: Implement chrome.notifications for push alerts**

**Step 2: Implement rate limiting (10 per task per hour, derived from IndexedDB)**

**Step 3: Implement notification feed in IndexedDB**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add notification system with rate limiting"
```

---

## Milestone 12: Remote Mode

### Task 12.1: WebSocket relay

**Files:**
- Create: `src/lib/remote/websocket-server.ts`
- Create: `src/lib/remote/auth.ts`
- Create: `src/lib/remote/relay.ts`

**Step 1: Implement WebSocket server on localhost:19988**

Note: Chrome extensions can't create raw WebSocket servers. Remote mode will use `chrome.runtime.connectNative` with a thin native messaging host, OR use a localhost HTTP server in the offscreen document. Research the best approach during implementation.

Alternative: use `chrome.runtime.onConnectExternal` for extension-to-extension, and a small native messaging host for non-extension clients.

**Step 2: Implement token auth handshake**

**Step 3: Implement CDP relay with domain allowlist**

**Step 4: Implement tab mutex (Mode 1/2 vs Mode 3)**

**Step 5: Commit**

```bash
git add -A && git commit -m "feat: add remote mode WebSocket relay"
```

---

## Milestone 13: Export/Import & Polish

### Task 13.1: Task export/import

**Files:**
- Create: `src/lib/export-import.ts`
- Create: `src/lib/export-import.test.ts`

**Step 1: Implement export**

Generate `TaskExportBundle` JSON file per task.

**Step 2: Implement import with validation**

- Check formatVersion
- Re-run AST validation
- Require security review
- Recompute checksums
- Validate domains

**Step 3: Commit**

```bash
git add -A && git commit -m "feat: add task export/import with security validation"
```

---

### Task 13.2: LLM usage tracking

**Files:**
- Create: `src/lib/llm-usage.ts`
- Create: `src/entrypoints/sidepanel/components/UsageStats.tsx`

**Step 1: Track all LLM calls in IndexedDB llm_usage store**

**Step 2: Display usage stats in Settings (cost, tokens, per-task breakdown)**

**Step 3: Implement 90-day cap with daily aggregation**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add LLM usage tracking and stats display"
```

---

### Task 13.3: Script version management UI

**Files:**
- Create: `src/entrypoints/sidepanel/components/ScriptVersions.tsx`
- Create: `src/entrypoints/sidepanel/components/ScriptDiff.tsx`

**Step 1: Show version history per task with diff view**

**Step 2: Allow revert to previous version**

**Step 3: Version cap enforcement (keep last 10)**

**Step 4: Commit**

```bash
git add -A && git commit -m "feat: add script version management UI"
```

---

## Execution Order Summary

| Milestone | Description | Dependencies |
|---|---|---|
| 1 | Project Foundation | None |
| 2 | Storage Layer | 1 |
| 3 | Message Router & RPC | 1, 2 |
| 4 | Content Script & Observation | 1 |
| 5 | CDP & Humanization | 3 |
| 6 | QuickJS WASM Sandbox | 3 |
| 7 | Security Pipeline | 1 |
| 8 | Side Panel UI | 2, 8.5 needs 7 |
| 9 | Explorer & Script Generation | 4, 5, 7, 8 |
| 10 | Self-Healing | 6, 7, 9 |
| 11 | Scheduling & Notifications | 2, 5, 6 |
| 12 | Remote Mode | 5 |
| 13 | Export/Import & Polish | All |

**Parallelizable:** Milestones 4, 6, 7 can run in parallel. Milestones 3+5 form one track, 4 another, 7 another.
