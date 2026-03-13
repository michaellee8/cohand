# Cohand

**Prompt once, automate forever.**

Cohand is a Chrome extension that turns natural language descriptions into repeatable browser automation tasks. Describe what you want to monitor or extract, and Cohand generates, validates, and safely executes scripts — all within your browser.

## Features

- **Chat-based task creation** — Describe a task in plain English. Cohand uses an LLM to generate a browser automation script from the current page's accessibility tree and screenshot.
- **Recording mode** — Record clicks, keystrokes, and navigation in the browser. Cohand captures each step with element metadata, then refines the recording into a reusable script via LLM.
- **Multi-layer security** — Every generated script passes through AST validation (blocked APIs, no eval/fetch/import), dual-model security review, domain allowlisting, and injection scanning before it can run.
- **Sandboxed execution** — Scripts execute inside a QuickJS WebAssembly sandbox with no direct DOM access. All browser interactions go through a controlled RPC bridge to Chrome DevTools Protocol.
- **Scheduling & notifications** — Run tasks manually or on an interval. Get notified when a task completes, fails, or detects a change.
- **Task management** — View, edit, disable, delete, and export/import tasks. Each task tracks script versions, run history, and persistent state.
- **Remote control** — Optional authenticated remote API for triggering tasks and relaying CDP commands from external tools.
- **Usage tracking** — Per-task LLM token usage and cost tracking across providers.

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Chrome Browser                     │
│                                                      │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────┐ │
│  │  Side Panel   │  │   Content    │  │  Offscreen  │ │
│  │  (React UI)   │  │   Script     │  │  Document   │ │
│  │              │  │              │  │             │ │
│  │ Chat Page    │  │ Recording    │  │  Sandbox    │ │
│  │ Tasks Page   │  │ A11y Tree    │  │  (iframe)   │ │
│  │ Settings     │  │ Element Meta │  │     │       │ │
│  └──────┬───────┘  └──────┬───────┘  │  QuickJS   │ │
│         │                  │          │  (WASM)    │ │
│         │                  │          └─────┬──────┘ │
│         │                  │                │        │
│  ┌──────▼──────────────────▼────────────────▼──────┐ │
│  │            Service Worker (Background)           │ │
│  │                                                  │ │
│  │  Message Router · IndexedDB · Scheduler          │ │
│  │  CDP Manager · Execution Orchestrator            │ │
│  │  Remote Server · Notifications                   │ │
│  └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

**Side Panel** — React + Zustand UI with Chat, Tasks, and Settings pages. Handles LLM calls, recording UI, and task management.

**Content Script** — Injected into web pages to generate accessibility trees, capture recording events (clicks, keystrokes, navigation), and resolve element selectors.

**Service Worker** — Central hub managing message routing, IndexedDB persistence, Chrome alarms for scheduling, CDP session management, and the execution orchestrator.

**Offscreen Document + Sandbox** — An offscreen document hosts a sandboxed iframe running QuickJS WASM. Generated scripts execute here with no direct browser API access — all interactions go through a postMessage RPC bridge to CDP commands.

## Security Model

Cohand runs LLM-generated code in the browser, so security is defense-in-depth:

1. **AST Validation** — Static analysis via acorn blocks dangerous constructs: `eval`, `Function`, `fetch`, `import()`, `XMLHttpRequest`, `WebSocket`, `__proto__`, `constructor`, reflection APIs (`getPrototypeOf`, `defineProperty`, etc.), and more.

2. **Dual-Model Security Review** — Two independent LLM reviews (data flow analysis + capability analysis) must both approve a script. Fail-closed on any error or malformed response.

3. **QuickJS Sandbox** — Scripts run in a WebAssembly QuickJS VM with no access to browser globals. The only way to interact with the page is through explicitly exposed RPC methods (`goto`, `click`, `fill`, `waitForSelector`, etc.).

4. **Domain Guard** — Tasks declare allowed domains. Navigation to unapproved domains or sensitive pages (login, settings, admin, payment) is blocked.

5. **Injection Scanner** — Page content passed to the LLM is scanned for prompt injection patterns and sensitive data (emails, credit cards, SSNs, API keys) before inclusion.

6. **Origin-Validated PostMessage** — All sandbox ↔ extension communication uses strict origin checking. No wildcard origins.

7. **Remote Auth** — Token-based authentication with timing-safe comparison, rate limiting, session expiry, and idle timeout.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Extension Framework | [WXT](https://wxt.dev) (Chrome MV3) |
| UI | React 19, Zustand 5, Tailwind CSS 4 |
| LLM Integration | [pi-ai](https://github.com/nicepkg/pi-ai) (multi-provider: OpenAI, Anthropic, Gemini, ChatGPT subscription) |
| Script Sandbox | [QuickJS](https://bellard.org/quickjs/) via quickjs-emscripten (WASM) |
| AST Analysis | acorn + acorn-walk |
| Browser Automation | Chrome DevTools Protocol (CDP) |
| Database | IndexedDB (raw, no ORM) |
| Unit Tests | Vitest + happy-dom + fake-indexeddb |
| E2E Tests | Playwright, Puppeteer |

## Getting Started

### Prerequisites

- Node.js 20+
- npm

### Install

```bash
git clone https://github.com/michaellee8/cohand.git
cd cohand
npm install
```

### Develop

```bash
npx wxt dev
```

Opens Chrome with the extension loaded in development mode with hot reload.

### Build

```bash
npx wxt build
```

Outputs the built extension to `.output/chrome-mv3/`.

### Load in Chrome

1. Go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `.output/chrome-mv3` directory

## Testing

```bash
# Unit tests (686 tests)
npm test

# Unit tests in watch mode
npm run test:watch

# Playwright e2e tests (155 tests) — requires built extension
npx wxt build
npm run test:pw

# Playwright core tests only
npm run test:pw:core

# Playwright feature tests only
npm run test:pw:features

# Node e2e tests (28 tests) — requires built extension + xvfb
xvfb-run --auto-servernum npm run test:e2e:all
```

## Project Structure

```
src/
├── constants.ts                  # Shared constants
├── types/                        # TypeScript type definitions
├── entrypoints/
│   ├── background.ts             # Service worker (message routing, DB, scheduling)
│   ├── content.ts                # Content script (recording, a11y tree)
│   ├── sidepanel/                # Side panel UI
│   │   ├── App.tsx               # Root component with ErrorBoundary
│   │   ├── pages/                # ChatPage, TasksPage, SettingsPage
│   │   ├── components/           # UI components
│   │   └── stores/               # Zustand stores (chat, tasks, wizard, recording, settings)
│   ├── sandbox/                  # Sandboxed QuickJS execution environment
│   ├── offscreen/                # Offscreen document (hosts sandbox iframe)
│   └── oauth-callback/           # OAuth callback page for ChatGPT auth
└── lib/
    ├── security/                 # AST validator, domain guard, injection scanner, security review
    ├── remote/                   # Remote control server, auth, relay
    ├── recording/                # Element selector, speech recognition
    ├── cdp.ts                    # Chrome DevTools Protocol manager
    ├── execution-orchestrator.ts # Script execution lifecycle
    ├── quickjs-runner.ts         # QuickJS VM setup and script wrapping
    ├── sandbox-bridge.ts         # PostMessage RPC bridge to sandbox
    ├── humanized-page-handler.ts # Page interaction handlers (goto, click, fill, etc.)
    ├── explorer.ts               # LLM-based script generation
    ├── message-router.ts         # Typed message routing
    ├── db.ts / db-helpers.ts     # IndexedDB schema and helpers
    ├── scheduler.ts              # Chrome alarms scheduling
    ├── notifications.ts          # Notification system
    ├── export-import.ts          # Task export/import with checksum verification
    ├── storage.ts                # Chrome storage helpers
    ├── crypto.ts                 # AES-GCM encryption for API keys
    ├── codex-oauth.ts            # ChatGPT PKCE OAuth flow
    └── pi-ai-bridge.ts          # Multi-provider LLM abstraction
```

## LLM Provider Setup

Cohand supports multiple LLM providers. Configure in the Settings page:

| Provider | Setup |
|----------|-------|
| **ChatGPT Subscription** | Import OAuth tokens from your ChatGPT Plus/Pro account |
| **OpenAI API** | Enter your OpenAI API key |
| **Anthropic** | Enter your Anthropic API key |
| **Google Gemini** | Enter your Gemini API key |
| **Custom** | Any OpenAI-compatible endpoint with base URL + API key |

## License

ISC
