import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { generatePKCE, buildAuthUrl, exchangeCodeForToken } from './codex-oauth';

// ---------------------------------------------------------------------------
// generatePKCE
// ---------------------------------------------------------------------------

describe('generatePKCE', () => {
  it('returns a verifier of 43 characters', async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).toHaveLength(43);
  });

  it('verifier contains only base64url characters', async () => {
    const { verifier } = await generatePKCE();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('challenge differs from verifier', async () => {
    const { verifier, challenge } = await generatePKCE();
    expect(challenge).not.toBe(verifier);
  });

  it('challenge contains only base64url characters', async () => {
    const { challenge } = await generatePKCE();
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('produces different verifiers on successive calls', async () => {
    const a = await generatePKCE();
    const b = await generatePKCE();
    expect(a.verifier).not.toBe(b.verifier);
  });
});

// ---------------------------------------------------------------------------
// buildAuthUrl
// ---------------------------------------------------------------------------

describe('buildAuthUrl', () => {
  it('returns a URL starting with the auth base', () => {
    const url = buildAuthUrl('test-challenge', 'test-state');
    expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/);
  });

  it('contains all required parameters', () => {
    const url = buildAuthUrl('my-challenge', 'my-state');
    const params = new URL(url).searchParams;

    expect(params.get('response_type')).toBe('code');
    expect(params.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(params.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(params.get('scope')).toBe('openid profile email offline_access');
    expect(params.get('code_challenge')).toBe('my-challenge');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('state')).toBe('my-state');
    expect(params.get('codex_cli_simplified_flow')).toBe('true');
  });

  it('properly encodes the challenge and state', () => {
    const url = buildAuthUrl('a+b/c=d', 'x&y=z');
    const params = new URL(url).searchParams;
    expect(params.get('code_challenge')).toBe('a+b/c=d');
    expect(params.get('state')).toBe('x&y=z');
  });
});

// ---------------------------------------------------------------------------
// exchangeCodeForToken
// ---------------------------------------------------------------------------

describe('exchangeCodeForToken', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends correct POST body', async () => {
    const payload = { chatgpt_account_id: 'acct_oauth_test' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeAccess = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: fakeAccess,
        refresh_token: 'rt_new',
        expires_in: 7200,
      }),
    });

    await exchangeCodeForToken('auth-code-123', 'verifier-abc');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://auth.openai.com/oauth/token',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }),
    );

    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body: string = callArgs[1].body;
    expect(body).toContain('grant_type=authorization_code');
    expect(body).toContain('client_id=app_EMoamEEZ73f0CkXaXp7hrann');
    expect(body).toContain('code=auth-code-123');
    expect(body).toContain('code_verifier=verifier-abc');
    expect(body).toContain('redirect_uri=');
  });

  it('returns OAuthCredentials with correct shape', async () => {
    const payload = { chatgpt_account_id: 'acct_shape_test' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeAccess = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: fakeAccess,
        refresh_token: 'rt_shape',
        expires_in: 3600,
      }),
    });

    const result = await exchangeCodeForToken('code', 'verifier');

    expect(result.access).toBe(fakeAccess);
    expect(result.refresh).toBe('rt_shape');
    expect(result.accountId).toBe('acct_shape_test');
    expect(typeof result.expires).toBe('number');
    expect(result.expires).toBeGreaterThan(Date.now());
  });

  it('throws on non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      text: vi.fn().mockResolvedValue('invalid_grant'),
    });

    await expect(exchangeCodeForToken('bad-code', 'verifier')).rejects.toThrow(
      /Token exchange failed \(400\)/,
    );
  });

  it('returns empty accountId when JWT has no chatgpt_account_id', async () => {
    const payload = { sub: 'user_only' };
    const base64Payload = btoa(JSON.stringify(payload));
    const fakeAccess = `eyJhbGciOiJSUzI1NiJ9.${base64Payload}.fakesig`;

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        access_token: fakeAccess,
        refresh_token: 'rt_no_account',
        expires_in: 3600,
      }),
    });

    const result = await exchangeCodeForToken('code', 'verifier');
    expect(result.accountId).toBe('');
  });
});
