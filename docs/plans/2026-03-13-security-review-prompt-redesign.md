# Security Review Prompt Redesign

## Problem

The LLM security review prompts are too strict, causing false positives on legitimate scripts:
- Reading page text flagged as "sensitive data access"
- Storing data in `context.state` flagged as "exfiltration risk" (state is local IndexedDB)
- Returning data from `run()` flagged as "data leaving page context"
- `context.state.foo = bar` flagged as non-compliant (prompt incorrectly says `state.get`/`state.set`)

## Threat Model

The real threats are:
1. **Prompt injection** — malicious page content in the a11y tree tricks the code-gen LLM into generating harmful code
2. **Sandbox escapes** — prototype chain traversal, dynamic code generation, accessing blocked APIs
3. **Credential harvesting** — scripts targeting password fields, auth tokens, session cookies

What is NOT a threat:
- Reading page text (the entire purpose of automation scripts)
- Persisting data in `context.state` (local to the extension)
- Returning data from `run()` (stays within the extension)

## Changes

### 1. `src/lib/security/review-prompts.ts`

**DATA_FLOW_REVIEW_PROMPT**: Refocus on prompt injection detection and credential harvesting. Explicitly whitelist reading page text, storing in state, returning results. Change default from "reject if uncertain" to "approve unless specific concrete threat identified."

**CAPABILITY_REVIEW_PROMPT**: Fix `context.state` documentation (plain object, not `.get()`/`.set()`). Keep sandbox escape detection. Add prompt injection detection. Explicitly allow array indexing and dynamic property access on regular objects.

### 2. `src/lib/explorer-prompts.ts`

Replace informal API bullet list with TypeScript interface definitions for Page, Locator, and Context. This eliminates ambiguity about the actual API shape.

### 3. Tests

No test changes needed — new prompts preserve keyword anchors checked by existing tests.
