import { describe, expect, it, vi } from 'vitest';
import {
  createProviderRegistry,
  GeminiOAuthClient,
  HttpProviderCredentialVerifier,
} from './ai-connections.module.js';
import { CredentialVault } from './credential-vault.js';
import { OAuthStateService, RedisIdempotencyService } from './oauth-state.service.js';

const oauthEnv = {
  NODE_ENV: 'test',
  LLM_GEMINI_OAUTH_CLIENT_ID: 'client-id.apps.googleusercontent.com',
  LLM_GEMINI_OAUTH_CLIENT_SECRET: 'client-secret',
  LLM_GEMINI_OAUTH_PROJECT_ID: 'gemini-project-123',
  LLM_GEMINI_OAUTH_REDIRECT_URIS:
    'https://api.example.test/api/ai/connections/GEMINI/oauth/callback',
} as NodeJS.ProcessEnv;

describe('provider credential HTTP clients', () => {
  it('verifies API keys with a metadata GET and never performs paid generation', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response('{"data":[]}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const verifier = new HttpProviderCredentialVerifier(fetchImpl, oauthEnv);

    await expect(verifier.verify('OPENAI', 'API_KEY', 'sk-provider-secret')).resolves.toMatchObject(
      {
        valid: true,
      },
    );

    const [url, init] = fetchImpl.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe('/v1/models');
    expect(init.method).toBe('GET');
    expect(init.body).toBeUndefined();
    expect(JSON.stringify(init)).not.toContain('generate');
  });

  it('exchanges Gemini authorization code with exact redirect and PKCE using bounded JSON', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: 'access-secret',
          refresh_token: 'refresh-secret',
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/cloud-platform',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    const client = new GeminiOAuthClient(fetchImpl, oauthEnv);
    const redirectUri = oauthEnv.LLM_GEMINI_OAUTH_REDIRECT_URIS as string;

    const tokens = await client.exchangeGeminiCode({
      code: 'authorization-code',
      redirectUri,
      verifier: 'pkce-verifier',
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = new URLSearchParams(String(init.body));
    expect(body.get('redirect_uri')).toBe(redirectUri);
    expect(body.get('code_verifier')).toBe('pkce-verifier');
    expect(body.get('client_secret')).toBe('client-secret');
    expect(tokens.accessToken).toBe('access-secret');
    expect(JSON.stringify(tokens)).not.toContain('authorization-code');
  });

  it('rejects an oversized OAuth response without exposing its body', async () => {
    const secretMarker = 'provider-body-secret';
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ access_token: secretMarker, padding: 'x'.repeat(70_000) }), {
        status: 200,
      }),
    );
    const client = new GeminiOAuthClient(fetchImpl, oauthEnv);

    const failure = await client
      .exchangeGeminiCode({
        code: 'authorization-code',
        redirectUri: oauthEnv.LLM_GEMINI_OAUTH_REDIRECT_URIS as string,
        verifier: 'pkce-verifier',
      })
      .catch((error: unknown) => error);

    expect(String(failure)).not.toContain(secretMarker);
  });

  it('cancels the provider body stream when the bounded reader rejects oversized content', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
      },
      cancel,
    });
    const client = new GeminiOAuthClient(
      vi.fn().mockResolvedValue(new Response(stream, { status: 200 })),
      oauthEnv,
    );

    await expect(
      client.exchangeGeminiCode({
        code: 'authorization-code',
        redirectUri: oauthEnv.LLM_GEMINI_OAUTH_REDIRECT_URIS as string,
        verifier: 'pkce-verifier',
      }),
    ).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });
});

describe('provider registry configuration', () => {
  it('omits Gemini OAuth when OAuth configuration is absent', () => {
    const gemini = createProviderRegistry({
      NODE_ENV: 'production',
      AUTH0_DOMAIN: 'tenant.eu.auth0.com',
      AUTH0_AUDIENCE: 'https://api.example.test',
      CORS_ORIGIN: 'https://app.example.test',
      DATABASE_URL: 'postgresql://app:secret@postgres:5432/extractionstack',
      REDIS_URL: 'redis://redis:6379',
      LLM_CREDENTIAL_MASTER_KEY: Buffer.alloc(32, 7).toString('base64'),
      LLM_CREDENTIAL_KEY_VERSION: 'production-v1',
    }).get('GEMINI');
    expect(gemini.credentialModes).toEqual(['API_KEY', 'PLATFORM_CREDITS']);
    expect(gemini.oauthScopes).toEqual([]);
  });

  it('advertises Gemini OAuth only when the complete configuration is present', () => {
    const gemini = createProviderRegistry(oauthEnv).get('GEMINI');
    expect(gemini.credentialModes).toContain('OAUTH');
    expect(createProviderRegistry(oauthEnv).get('OPENAI').credentialModes).not.toContain('OAUTH');
  });
});

describe('OAuthStateService', () => {
  it('stores only a hash of high-entropy state and consumes it atomically once', async () => {
    const records = new Map<string, string>();
    const redis = {
      status: 'ready',
      connect: vi.fn(),
      set: vi.fn(async (key: string, value: string) => {
        records.set(key, value);
        return 'OK' as const;
      }),
      getdel: vi.fn(async (key: string) => {
        const value = records.get(key) ?? null;
        records.delete(key);
        return value;
      }),
      get: vi.fn(async (key: string) => records.get(key) ?? null),
      del: vi.fn(async (key: string) => (records.delete(key) ? 1 : 0)),
      eval: vi.fn(async (_script: string, keyCount: number, ...args: Array<string | number>) => {
        expect(keyCount).toBe(2);
        const [activeKey, usedKey, usedAt] = args as [string, string, number, number];
        const value = records.get(activeKey) ?? null;
        if (!value) return false;
        const record = JSON.parse(value) as Record<string, unknown>;
        records.set(usedKey, JSON.stringify({ ...record, usedAt }));
        records.delete(activeKey);
        return value;
      }),
      quit: vi.fn(async () => 'OK' as const),
      disconnect: vi.fn(),
    };
    const service = new OAuthStateService(redis, () => Date.parse('2026-07-16T12:00:00Z'));

    const state = await service.create({
      ownerSub: 'auth0|owner',
      provider: 'GEMINI',
      redirectUri: 'https://api.example.test/oauth/callback',
      verifier: 'v'.repeat(43),
    });

    const storedKey = [...records.keys()][0] as string;
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(storedKey).not.toContain(state);
    expect([...records.values()][0]).not.toContain(state);
    await expect(service.consume(state)).resolves.toMatchObject({ ownerSub: 'auth0|owner' });
    await expect(service.consume(state)).resolves.toBeNull();
    expect(redis.eval).toHaveBeenCalledTimes(2);
    expect([...records.values()].some((value) => value.includes('"usedAt":'))).toBe(true);
  });
});

describe('RedisIdempotencyService', () => {
  it('deduplicates a completed mutation and never stores the raw idempotency key', async () => {
    const records = new Map<string, string>();
    const redis = {
      status: 'ready',
      connect: vi.fn(),
      set: vi.fn(
        async (key: string, value: string, _mode: string, _ttl: number, condition?: string) => {
          if (condition === 'NX' && records.has(key)) return null;
          records.set(key, value);
          return 'OK' as const;
        },
      ),
      get: vi.fn(async (key: string) => records.get(key) ?? null),
      getdel: vi.fn(),
      del: vi.fn(async (key: string) => (records.delete(key) ? 1 : 0)),
      eval: vi.fn(async (script: string, _keyCount: number, ...args: Array<string | number>) => {
        const [key, expected, replacement] = args as [string, string, string?];
        if (records.get(key) !== expected) return 0;
        if (script.includes("redis.call('SET'")) records.set(key, replacement as string);
        else records.delete(key);
        return 1;
      }),
      quit: vi.fn(async () => 'OK' as const),
      disconnect: vi.fn(),
    };
    const service = new RedisIdempotencyService(redis);
    const run = vi.fn().mockResolvedValue({ id: 'cm1234567890' });
    const input = {
      ownerSub: 'auth0|owner',
      operation: 'add-api-key',
      key: 'raw-idempotency-key:0001',
      fingerprint: 'a'.repeat(64),
      run,
      parse: (value: unknown) => value as { id: string },
    };

    await expect(service.execute(input)).resolves.toEqual({ id: 'cm1234567890' });
    await expect(service.execute(input)).resolves.toEqual({ id: 'cm1234567890' });

    expect(run).toHaveBeenCalledOnce();
    expect([...records.keys()].join(' ')).not.toContain(input.key);
  });

  it('stores OAuth-start replay only as an encrypted envelope and rejects tampering', async () => {
    const records = new Map<string, string>();
    const redis = createIdempotencyRedis(records);
    const service = new RedisIdempotencyService(redis);
    const vault = new CredentialVault(Buffer.alloc(32, 4).toString('base64'), 'test-v1');
    const result = {
      state: 's'.repeat(43),
      authorizationUrl: `https://accounts.example.test/auth?state=${'s'.repeat(43)}`,
    };
    const input = {
      ownerSub: 'auth0|owner',
      operation: 'start-gemini-oauth',
      key: 'oauth-start:0001',
      fingerprint: 'b'.repeat(64),
      run: vi.fn().mockResolvedValue(result),
      encodeResult: (value: typeof result) =>
        vault.encrypt('auth0|owner', 'GEMINI', JSON.stringify(value)),
      parse: async (value: unknown) => {
        const plaintext = await vault.decrypt(
          'auth0|owner',
          'GEMINI',
          value as Parameters<CredentialVault['decrypt']>[2],
        );
        return JSON.parse(plaintext) as typeof result;
      },
      cacheRequired: true,
    };

    await expect(service.execute(input)).resolves.toEqual(result);
    const payload = [...records.values()].join(' ');
    expect(payload).not.toContain(result.state);
    expect(payload).not.toContain(result.authorizationUrl);
    await expect(service.execute(input)).resolves.toEqual(result);

    const [key, stored] = [...records.entries()][0] as [string, string];
    records.set(key, stored.replace(/"ciphertext":"[^"]+"/, '"ciphertext":"AAAA"'));
    await expect(service.execute(input)).rejects.toThrow();
  });
});

function createIdempotencyRedis(records: Map<string, string>) {
  return {
    status: 'ready',
    connect: vi.fn(),
    set: vi.fn(
      async (key: string, value: string, _mode: string, _ttl: number, condition?: string) => {
        if (condition === 'NX' && records.has(key)) return null;
        records.set(key, value);
        return 'OK' as const;
      },
    ),
    get: vi.fn(async (key: string) => records.get(key) ?? null),
    getdel: vi.fn(),
    del: vi.fn(async (key: string) => (records.delete(key) ? 1 : 0)),
    eval: vi.fn(async (script: string, _keyCount: number, ...args: Array<string | number>) => {
      const [key, expected, replacement] = args as [string, string, string?];
      if (records.get(key) !== expected) return 0;
      if (script.includes("redis.call('SET'")) records.set(key, replacement as string);
      else records.delete(key);
      return 1;
    }),
    quit: vi.fn(async () => 'OK' as const),
    disconnect: vi.fn(),
  };
}
