# Cohand — Full Runnable Plan

**Date:** 2026-03-11
**Goal:** Make cohand fully runnable with all features working, with comprehensive Playwright E2E test suite
**LLM Auth:** Use existing codex auth from `~/.codex/auth.json`

---

## Current State

- **Build:** Passes cleanly (WXT + Vite, 17.6s)
- **Unit Tests:** 639/639 passing across 31 test files
- **E2E Tests:** Exist using Puppeteer (to be migrated to Playwright)
- **Codex Auth:** Available at `~/.codex/auth.json` with valid tokens
- **Chrome:** Available at `/usr/bin/google-chrome`
- **Xvfb:** Available for headless extension testing
- **Playwright:** v1.58.2 available

---

## Team Structure

| Role | Agent | Scope | Worktree Branch |
|------|-------|-------|-----------------|
| Code Architect | architect | Playwright infrastructure, test helpers, mock LLM server | `feat/playwright-infra` |
| Developer 1 | dev-auth | Auth/LLM pipeline, codex integration | `feat/auth-pipeline` |
| Developer 2 | dev-tasks | Task lifecycle, execution, scheduling, self-healing | `feat/task-lifecycle` |
| Developer 3 | dev-ui | Chat, recording, settings, notifications | `feat/ui-features` |
| E2E Tester 1 | tester-core | Core flow tests (loading, settings, CRUD, execution) | `feat/e2e-core` |
| E2E Tester 2 | tester-advanced | Advanced tests (chat, recording, notifications, security) | `feat/e2e-advanced` |
| Code Reviewer | reviewer | Review all merged changes | N/A |

---

## Phase 1: Infrastructure + Fixes (Parallel)

### Architect: Playwright Infrastructure
- Add `@playwright/test` to devDependencies
- Create `playwright.config.ts` for Chrome extension testing
- Create `e2e/playwright/fixtures/` with extension loading fixture
- Create `e2e/playwright/helpers/` with:
  - `extension.ts` — load extension, get extension ID
  - `sidepanel.ts` — open side panel, navigate tabs
  - `service-worker.ts` — message helpers (create/get/delete tasks)
  - `mock-llm-server.ts` — Express/Node HTTP server that mimics OpenAI streaming API
- Create `e2e/playwright/pages/` with page object models
- Add npm scripts: `test:pw`, `test:pw:core`, `test:pw:features`
- Configure Xvfb wrapper for headless CI

### Developer 1: Auth & LLM Pipeline
- Verify `importCodexAuth()` in settings-store works with real auth.json
- Ensure token refresh flow works (tokens in auth.json may need refresh)
- Verify pi-ai-bridge correctly resolves ChatGPT subscription provider
- Test LLM streaming with codex tokens
- Add unit tests for any fixes
- Ensure the "Import from ~/.codex/auth.json" button works in Settings UI

### Developer 2: Task Lifecycle
- Verify task creation wizard end-to-end (with mock/real LLM)
- Test task execution flow: service worker → offscreen → sandbox → CDP
- Verify self-healing loop triggers correctly on failure
- Test scheduling via chrome.alarms
- Verify export/import works correctly
- Add unit tests for any fixes

### Developer 3: UI Features
- Verify chat mode sends messages and receives streaming responses
- Test recording workflow: start → capture clicks/keystrokes → stop → refine → create task
- Verify settings page saves/loads all options correctly
- Test notification system (creation, display, mark-as-read)
- Verify usage stats display
- Add unit tests for any fixes

---

## Phase 2: E2E Test Suite (Parallel, after Phase 1 merge)

### Tester 1: Core Flow Tests
Files: `e2e/playwright/tests/`

1. **extension-loading.spec.ts**
   - Service worker starts without errors
   - Side panel loads with Chat/Tasks tabs
   - Content script injects on pages
   - Offscreen document creates successfully

2. **settings.spec.ts**
   - LLM provider dropdown works
   - API key input saves/loads correctly
   - Codex auth import works
   - Domain permissions CRUD
   - YOLO mode toggle
   - Language setting

3. **task-crud.spec.ts**
   - Create task via wizard (with mock LLM)
   - Task appears in list
   - Task detail view shows correct info
   - Edit task settings
   - Delete task
   - Multiple tasks management

4. **task-execution.spec.ts**
   - Manual "Run Now" execution
   - Script runs in sandbox correctly
   - Run history records success/failure
   - State persistence between runs
   - Domain restriction enforcement

5. **task-scheduling.spec.ts**
   - Set interval schedule
   - Alarm fires and triggers execution
   - Disable/enable scheduled task

### Tester 2: Advanced Feature Tests

6. **chat-mode.spec.ts**
   - Send message and receive response
   - Domain approval prompt appears
   - Script generation from chat
   - Error handling (network failure, invalid response)
   - Cancel in-progress request

7. **recording.spec.ts**
   - Start recording session
   - Capture click events
   - Capture keystroke events
   - Capture navigation events
   - Stop recording
   - Recording refinement (LLM step)
   - Create task from recording

8. **notifications.spec.ts**
   - Notification creation on task events
   - Notification feed display
   - Mark as read
   - Rate limiting

9. **export-import.spec.ts**
   - Export task bundle
   - Import task bundle
   - Validation of imported data
   - Merge vs replace behavior

10. **security.spec.ts**
    - AST validation rejects dangerous scripts
    - Domain guard blocks disallowed domains
    - Injection scanner detects malicious output
    - QuickJS sandbox isolation

---

## Phase 3: Code Review

- Review all changes against this plan
- Check for:
  - Test coverage completeness
  - Security implications
  - Code quality and consistency
  - Performance concerns
  - Chrome extension best practices

---

## Mock LLM Server Design

For tests that need LLM responses without real API calls:

```typescript
// Intercepts OpenAI-compatible API calls
// Returns canned responses for:
// - Script generation (returns valid script source)
// - Security review (returns approved: true)
// - Page observation (returns structured observation)
// - Chat responses (returns streaming text)
// Configurable per-test via server.setResponse(type, response)
```

---

## Test Environment

```bash
# Build extension
npx wxt build

# Start Xvfb (for headless)
Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

# Run Playwright tests
npx playwright test --project=chromium
```

---

## Success Criteria

1. Extension builds without errors
2. All 639+ unit tests pass
3. All Playwright E2E tests pass
4. Chat mode works with codex auth tokens
5. Task creation wizard completes end-to-end
6. Task execution works on mock site
7. Recording workflow captures and creates tasks
8. Settings persist across sessions
9. Self-healing triggers on script failure
10. Export/import round-trips correctly
