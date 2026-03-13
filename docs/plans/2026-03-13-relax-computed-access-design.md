# Relax Computed Member Access AST Restriction

## Problem

The AST validator blocks ALL non-literal computed member access (`obj[variable]`), which prevents legitimate patterns like array indexing (`arr[i]`), dynamic state access (`context.state[key]`), and general object traversal. This causes the LLM to generate workaround code or fail AST validation unnecessarily.

## Context

The runtime sandbox (QuickJS) provides strong defense-in-depth:
- Only `__hostCall` and `__stateJson` globals are exposed
- The `page` object is a hardcoded proxy with explicit methods — no prototype chain
- No dangerous globals (`Function`, `eval`, `Proxy`, `Reflect`) exist in the sandbox
- RPC dispatch is whitelist-based, not reflective

Given this, the blanket ban on variable-key computed access is security overkill that significantly hurts usability.

## Changes

### 1. AST Validator (`src/lib/security/ast-validator.ts`)

Remove the blanket non-literal computed access block (lines 67-71). Keep:
- Computed access on dangerous receivers (`globalThis`, `window`, `self`, `this`) — still blocked
- Literal computed access to blocked members (`obj["constructor"]`) — still blocked
- Template literal checks — still blocked

### 2. Tests (`src/lib/security/ast-validator.test.ts`)

- Update `'blocks non-literal computed access on any object'` to expect valid
- Add tests for: array indexing with variables, dynamic state access, computed access on globalThis/window with variables still blocked

### 3. LLM Prompt (`src/lib/explorer-prompts.ts`)

Replace the blanket computed access warning with the narrower rule:
- Computed access on globals (`globalThis[key]`, `window[key]`, etc.) is blocked
- Literal access to blocked properties (`obj["constructor"]`) is blocked
- Array indexing and dynamic property access on regular objects is allowed
