# Cohand Chrome Extension - Complete Project Overview

## Project Summary
Cohand is a Chrome extension that automates web tasks through recording, LLM-powered code generation, and secure script execution. Built with React 19, WXT framework, Zustand stores, and includes comprehensive security validation layers.

**Version:** 1.0.0  
**Type:** CommonJS/Chrome Extension (MV3)  
**Primary Tech Stack:**
- React 19.2.4 + React DOM
- WXT 0.20.18 (Chrome extension framework)
- Zustand 5.0.11 (state management)
- Tailwind CSS 4.2.1 + @tailwindcss/vite
- TypeScript 5.9.3
- Vitest 4.0.18 (unit tests)
- Puppeteer 24.38.0 + Playwright 1.58.2 (E2E tests)
- acorn/acorn-walk (AST validation)
- quickjs-emscripten (sandboxed script execution)
- @mariozechner/pi-ai (LLM integration)
- openai (LLM API)

---

## 1. PROJECT STRUCTURE

### Top-Level Directories
```
/home/sb1/repos/cohand/
├── src/                    # Main source code
├── e2e/                    # End-to-end tests
├── docs/                   # Documentation
├── references/             # Reference materials
├── .wxt/                   # WXT generated files
├── .output/                # Build output (chrome-mv3)
├── package.json            # NPM dependencies and scripts
├── tsconfig.json           # TypeScript configuration
├── wxt.config.ts           # WXT extension configuration
├── vitest.config.ts        # Vitest test runner config
└── .gitignore
```

### Configuration Files
- **wxt.config.ts** - Extension manifest, permissions, plugins (Tailwind), sidebar setup
- **tsconfig.json** - Strict TypeScript, JSX React, ESNext target, bundler module resolution
- **vitest.config.ts** - happy-dom environment, test file patterns, SSR config for pi-ai
- **package.json** - Scripts: test, test:watch, test:e2e, test:e2e:flow, test:e2e:all

---

## 2. SRC/ DIRECTORY STRUCTURE

```
src/
├── constants.ts                              # Global constants
├── types/                                    # Type definitions
│   ├── state.ts, task.ts, script.ts, storage.ts, rpc.ts, recording.ts, notification.ts
│
├── entrypoints/                              # Extension entry points
│   ├── background.ts                        # Service worker (main)
│   ├── content.ts                           # Content script
│   ├── sidepanel/                           # React UI
│   │   ├── App.tsx, pages/, components/, stores/
│   │   └── stores: chat-store, tasks-store, settings-store, recording-store, wizard-store
│   ├── offscreen/                           # Script execution sandbox
│   ├── sandbox/                             # QuickJS sandbox iframe
│   └── oauth-callback/                      # OAuth callback
│
└── lib/                                      # Core business logic
    ├── Database: db.ts, db-helpers.ts, storage.ts
    ├── Security: security/
    │   ├── ast-validator.ts (blocks dangerous globals/functions)
    │   ├── domain-guard.ts (whitelist + sensitive pages)
    │   ├── injection-scanner.ts (prompt injection + PII detection)
    │   └── security-review.ts (LLM-based review)
    ├── Execution: script-executor.ts, sandbox-bridge.ts, quickjs-pool.ts, rpc-handler.ts, rpc-client.ts
    ├── Recording: a11y-tree.ts, selector-resolver.ts, humanize.ts, recording/
    ├── Task: scheduler.ts, execution-flow.test.ts, task-creation-pipeline.test.ts
    ├── Notifications: notifications.ts, llm-usage.ts
    ├── Remote: cdp.ts, codex-oauth.ts, remote/
    ├── LLM: pi-ai-bridge.ts, crypto.ts, prng.ts
    └── Utilities: message-router.ts, messages.ts, explorer.ts, self-healing.ts, export-import.ts
```

---

## 3. TYPE DEFINITIONS

### Core Models
- **Task**: id, name, description, allowedDomains[], schedule, activeScriptVersion, disabled, timestamps
- **ScriptVersion**: source, checksum, generatedBy, astValidationPassed, securityReviewPassed, reviewDetails[]
- **ScriptRun**: result, error, success, durationMs, stateHash, ranAt
- **TaskState**: taskId, state dict (max 1MB), updatedAt
- **StateSnapshot**: id (runId), taskId, state, createdAt

### Recording
- **RecordingSession**: steps[], pageSnapshots (A11yNode map), activeTabId, trackedTabs[], generatedTaskId
- **RecordingStep**: status (raw|enriched|described), action (click|type|navigate|narration), selector, a11ySubtree, description, screenshot, speechTranscript
- **A11yNode**: role, name, children[] (tree)

### RPC
- **ScriptRPC**: id, taskId, method, args, deadline
- **ScriptRPCResult**: id, ok, value/error
- **ScriptRPCError**: type (NavigationChanged|TargetDetached|SelectorNotFound|DeadlineExceeded|OwnerDisconnected|DomainDisallowed)

### Storage
- **Settings**: llmProvider, llmModel, llmBaseUrl, yoloMode, language
- **DomainPermission**: domain, grantedAt, grantedBy
- **EncryptedTokens**: oauthToken, apiKey (both encrypted)
- **EncryptedCodexOAuth**: access, refresh, expires, accountId

### Notifications
- **TaskNotification**: id, taskId, message, isRead (0|1), createdAt
- **LlmUsageRecord**: id, taskId, purpose (explore|generate|repair|security_review|injection_scan), provider, model, tokens, costUsd, createdAt

---

## 4. ARCHITECTURE PATTERNS

### State Management (Zustand)
- **chat-store**: Messages, isStreaming, generatedScript, pi-ai stream API
- **tasks-store**: tasks[], selectedTaskId, runs, notifications, unreadCount
- **settings-store**: settings, domains[], hasApiKey, codexConnected, codexAccountId
- **recording-store**: isRecording, isPaused, session, voiceEnabled, steps, pageSnapshots
- **wizard-store**: step navigation, generatedScript, astValid, securityPassed

### Service Worker (background.ts)
- MessageRouter: Type-safe message handling
- CDPManager: Chrome DevTools Protocol
- RPCHandler: RPC routing
- taskTabMap: Track task → tab execution
- executionAbortControllers: Cancel in-flight execution
- testDomainOverrides: Override allowed domains in test
- recordingPort: Long-lived sidepanel connection

### IndexedDB Schema (2 versions)
**Version 1** (core):
- tasks, script_versions, script_runs, task_state, state_snapshots, notifications, llm_usage

**Version 2** (recording):
- recordings, recording_steps, recording_page_snapshots

### Security Pipeline (6 Layers)
1. **AST Validation** - Blocks eval, Function, fetch, constructor, etc.
2. **Domain Guard** - Whitelist matching + sensitive page detection
3. **Injection Scanner** - Detects prompt injection + PII patterns
4. **Security Review** - LLM-based code review
5. **RPC Handler** - Validates RPC calls
6. **Chrome DevTools Protocol** - Final gate before execution

### Recording System
- **Element Selector**: Track clicks, generate CSS selectors
- **A11y Tree**: Deep accessibility tree (max depth: 5)
- **Humanization**: Random delays (CLICK_DEDUP_MS: 300ms)
- **Recording Prompts**: Convert recording → script generation via LLM

### Task Creation Wizard
1. Describe (collect description)
2. Domains (add allowed domains)
3. Observe (LLM explores page, generates actions)
4. Review (shows script, LLM security check)
5. Test (optional test execution)
6. Schedule (manual or interval)
7. Create (save to IndexedDB)

---

## 5. SECURITY COMPONENTS

### AST Validator (ast-validator.ts)
- **Blocked Globals**: eval, Function, Proxy, Reflect, fetch, XMLHttpRequest, WebSocket, require
- **Blocked Members**: constructor, __proto__, prototype, mouse, keyboard, route, exposeFunction
- **Blocked Constructs**: with statements, dynamic imports, computed global access

### Domain Guard (domain-guard.ts)
- **isDomainAllowed(url, domains)**: Whitelist matching (supports subdomains)
- **isSensitivePage(url)**: Blocks /settings, /account, /security, /password, /auth, /login, /2fa, etc.

### Injection Scanner (injection-scanner.ts)
- **Injection Patterns**: ignore instructions, act as, jailbreak, DAN
- **Sensitive Patterns**: email, phone, SSN, credit card, API key, JWT, bearer token
- **Returns**: { safe, filtered, flags[] }

### Security Review (security-review.ts)
- LLM-based script review
- Stores ReviewDetail: { model, approved, issues[] }

---

## 6. TEST INFRASTRUCTURE

### Unit Tests (Vitest)
- **Environment**: happy-dom
- **Patterns**: `src/**/*.test.{ts,tsx}`
- **Run**: npm test

### Test Files
Located in src/lib/: a11y-tree.test.ts, background-handlers.test.ts, cdp.test.ts, codex-oauth.test.ts, db.test.ts, db-helpers.test.ts, execution-flow.test.ts, explorer.test.ts, export-import.test.ts, humanize.test.ts, injection-scanner.test.ts, llm-usage.test.ts, message-router.test.ts, notifications.test.ts, pi-ai-bridge.test.ts, prng.test.ts, quickjs-pool.test.ts, rpc-client.test.ts, rpc-handler.test.ts, sandbox-bridge.test.ts, scheduler.test.ts, script-executor.test.ts, security/*.test.ts, selector-resolver.test.ts, self-healing.test.ts, storage.test.ts, task-creation-pipeline.test.ts

---

## 7. E2E TEST INFRASTRUCTURE

### E2E Tests Structure
```
e2e/
├── tests/
│   ├── e2e.test.mjs              # Basic tests (Puppeteer)
│   └── task-flow.test.mjs        # Full lifecycle tests (Puppeteer)
├── playwright/
│   └── fixtures/extension.ts     # Playwright extension fixture
└── mock-site/                    # Test website (Vite)
    ├── index.html                # Homepage with price, like, items
    ├── form.html                 # Form submission
    ├── dynamic.html              # Dynamic content loading
    └── login.html                # Login (sensitive page)
```

### Puppeteer Tests

**e2e.test.mjs** (4 suites, 14 tests):
1. Extension Loading: Service worker, side panel, tab navigation, settings
2. Content Script: Injection, a11y tree generation
3. Mock Site Pages: Homepage, form, dynamic, login
4. External Sites: example.com content script injection

**task-flow.test.mjs** (7 suites, 30+ tests):
1. Wizard UI Flow: Open wizard, describe/domains steps, cancel
2. Task CRUD: Create, list, delete via service worker API
3. Task Execution: EXECUTE_TASK message, Run button, cleanup
4. Task Detail View: Click to open, shows info, close/delete
5. Wizard with Mocked LLM: Full flow with error handling
6. Multiple Tasks: All tasks appear, schedule badge

### Playwright Extension Fixture
- Custom test object with extension fixtures
- context: Launches Chromium with extension
- extensionId: Discovers service worker
- page: Default page
- openSidePanel: Helper to open sidepanel.html

---

## 8. CHROME EXTENSION MANIFEST

### Core Settings
- **name**: Cohand
- **description**: Prompt once, automate forever.
- **minimum_chrome_version**: 125
- **type**: MV3

### Permissions
- debugger, sidePanel, storage, activeTab, scripting, tabs, tabGroups, alarms, notifications, offscreen, unlimitedStorage, declarativeNetRequest, webNavigation

### Host Permissions
- &lt;all_urls&gt;

### Content Security Policy
- extension_pages: script-src 'self' 'wasm-unsafe-eval'; object-src 'self'

### Sandbox
- pages: ['sandbox.html']

### Web Accessible Resources
- oauth-callback.html: http://localhost/*

---

## 9. KEY FILES REFERENCE

| File | Purpose |
|------|---------|
| src/entrypoints/background.ts | Service worker (200+ lines) |
| src/entrypoints/content.ts | Content script (minimal) |
| src/entrypoints/sidepanel/* | React UI app |
| src/lib/security/* | 6-layer validation pipeline |
| src/lib/script-executor.ts | Script wrapping + proxies |
| src/lib/cdp.ts | CDP protocol manager |
| src/lib/db.ts | IndexedDB schema |
| src/lib/scheduler.ts | Task scheduling (alarms) |
| src/lib/a11y-tree.ts | Accessibility tree generation |
| src/types/*.ts | Type definitions |
| e2e/tests/e2e.test.mjs | Basic E2E tests |
| e2e/tests/task-flow.test.mjs | Full task lifecycle tests |
| e2e/mock-site/ | Test website |
| wxt.config.ts | Extension config |
| vitest.config.ts | Unit test config |

---

## 10. KEY CONSTANTS

```
DB_NAME = 'cohand', DB_VERSION = 2
MAX_STATE_SIZE = 1MB
QUICKJS_TIMEOUT_MS = 5 min
RPC_TIMEOUT_MS = 60s
QUICKJS_MEMORY_LIMIT = 32MB
QUICKJS_MODULE_POOL_SIZE = 3
MAX_SCRIPT_VERSIONS = 10
MAX_RUNS_PER_TASK = 100
MAX_STATE_SNAPSHOTS_PER_TASK = 10
LLM_USAGE_RETENTION_DAYS = 90
CLICK_DEDUP_MS = 300
SPEECH_ASSOCIATION_WINDOW_MS = 3000
```

---

## Summary
Cohand is a security-first Chrome extension with:
- **6-layer validation pipeline**: AST → Domain → Injection → LLM Review → RPC → CDP
- **Type-safe state**: Zustand + TypeScript throughout
- **Comprehensive testing**: Vitest (unit) + Puppeteer/Playwright (E2E)
- **Modern UI**: React 19 + Tailwind CSS
- **Sandboxed execution**: QuickJS + isolated contexts
- **Recording capability**: A11y tree + speech integration
- **Multi-provider LLM**: OpenAI, Anthropic, Gemini, custom, ChatGPT subscription
- **Full task lifecycle**: Creation, execution, scheduling, monitoring, deletion
