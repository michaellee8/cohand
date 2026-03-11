# Codex auth.json Import

## Problem

Users with an existing `~/.codex/auth.json` (from Codex CLI) must go through the full OAuth redirect flow to configure ChatGPT auth. This is unnecessary friction.

## Solution

Add two import options to the Settings page ChatGPT Account section:

1. **File picker** — "Import from file" button triggers a hidden `<input type="file">`. User picks `auth.json`.
2. **Paste JSON** — Expandable textarea for pasting `auth.json` contents.

Both parse the JSON, encrypt tokens, store as `EncryptedCodexOAuth`.

## auth.json Shape

```json
{
  "tokens": {
    "access_token": "eyJ...",
    "refresh_token": "rt_...",
    "account_id": "cb1406ac-..."
  }
}
```

## Changes

### settings-store.ts

New action:

```typescript
importCodexAuth: async (json: string) => void
```

- Parse JSON, validate `tokens.{access_token, refresh_token, account_id}` exist as non-empty strings
- Encrypt access + refresh via existing crypto pipeline
- Set `expires: 0` (force refresh on first use — auth.json has no expiry field)
- Call `setCodexOAuthTokens`, update store state

### SettingsPage.tsx

In the `!codexConnected` branch, below "Login with ChatGPT":

- "or" divider
- "Import from ~/.codex/auth.json" file picker button
- "Paste JSON manually" toggle → textarea + Import button
- Inline error text on parse/validation failure

## No Other Changes

No new files, message types, or background.ts modifications needed.
