import { HttpException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Auth0User } from '@extractionstack/shared';
import { CredentialVault } from './credential-vault.js';
import {
  AiConnectionsService,
  type AiConnectionsRepositoryPort,
  type OAuthTokenClientPort,
  type ProviderCredentialVerifierPort,
  type StoredAiConnection,
} from './ai-connections.service.js';
import { InMemoryOAuthStateStore } from './oauth-state.service.js';

const actor: Auth0User = { sub: 'auth0|owner', roles: ['user'] };
const otherActor: Auth0User = { sub: 'auth0|other', roles: ['user'] };
const callbackUrl = 'https://app.example.test/settings/ai-connections/callback';
const now = new Date('2026-07-16T12:00:00.000Z');

function connection(overrides: Partial<StoredAiConnection> = {}): StoredAiConnection {
  return {
    id: 'cm1234567890',
    ownerId: 'owner-id',
    provider: 'OPENAI',
    displayLabel: 'Minha chave',
    credentialMode: 'API_KEY',
    state: 'ACTIVE',
    maskedCredential: '…cret',
    scopes: [],
    expiresAt: null,
    validatedAt: now,
    lastUsedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function setup(options: { oauthExpiresAt?: string } = {}) {
  const stored = connection();
  const repository: AiConnectionsRepositoryPort = {
    listOwned: vi.fn().mockResolvedValue([stored]),
    createApiKey: vi.fn().mockResolvedValue(stored),
    createOAuth: vi.fn().mockImplementation(async (_actor, input) =>
      connection({
        provider: 'GEMINI',
        credentialMode: 'OAUTH',
        displayLabel: input.displayLabel,
        maskedCredential: input.maskedCredential,
        scopes: input.scopes,
        expiresAt: input.expiresAt,
      }),
    ),
    findOwnedCredential: vi.fn().mockImplementation(async (requestedActor, id) =>
      requestedActor.sub === actor.sub && id === stored.id
        ? { connection: stored, envelope: null }
        : null,
    ),
    updateValidation: vi.fn().mockResolvedValue(stored),
    revokeOwned: vi.fn().mockImplementation(async (requestedActor, id) =>
      requestedActor.sub === actor.sub && id === stored.id ? stored : null,
    ),
    ensureOwner: vi.fn().mockResolvedValue(undefined),
  };
  const verifier: ProviderCredentialVerifierPort = {
    verify: vi.fn().mockResolvedValue({ valid: true, scopes: [], expiresAt: null }),
  };
  const oauth: OAuthTokenClientPort = {
    exchangeGeminiCode: vi.fn().mockResolvedValue({
      accessToken: 'oauth-access-secret',
      refreshToken: 'oauth-refresh-secret',
      expiresAt: options.oauthExpiresAt ?? '2026-07-16T13:00:00.000Z',
      scopes: ['https://www.googleapis.com/auth/generative-language'],
    }),
    revokeGemini: vi.fn().mockResolvedValue(undefined),
  };
  const stateStore = new InMemoryOAuthStateStore({ now: () => now.getTime() });
  const vault = new CredentialVault(Buffer.alloc(32, 7).toString('base64'), 'test-v1');
  const service = new AiConnectionsService(repository, vault, verifier, stateStore, oauth, {
    geminiClientId: 'client-id',
    geminiAuthorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    allowedRedirectUris: [callbackUrl],
    now: () => now,
  }, {
    execute: async (input) => input.run(),
  });
  return { service, repository, verifier, oauth, stateStore };
}

describe('AiConnectionsService', () => {
  it('returns shared connection metadata but never the submitted API key', async () => {
    const { service, verifier, repository } = setup();

    const result = await service.addApiKey(actor, {
      provider: 'OPENAI',
      displayLabel: 'Minha chave',
      apiKey: 'sk-test-secret',
    }, 'add-key:0001');

    expect(result.maskedCredential).toBe('…cret');
    expect(JSON.stringify(result)).not.toContain('sk-test-secret');
    expect(verifier.verify).toHaveBeenCalledWith('OPENAI', 'API_KEY', 'sk-test-secret');
    const persisted = vi.mocked(repository.createApiKey).mock.calls[0]?.[1];
    expect(JSON.stringify(persisted)).not.toContain('sk-test-secret');
    expect(persisted?.envelope.ciphertext).not.toBe('sk-test-secret');
  });

  it('does not activate an API key rejected by remote verification', async () => {
    const { service, verifier, repository } = setup();
    vi.mocked(verifier.verify).mockResolvedValue({ valid: false, scopes: [], expiresAt: null });

    await expect(
      service.addApiKey(actor, {
        provider: 'GEMINI',
        displayLabel: 'Gemini',
        apiKey: 'bad-secret',
      }, 'add-key:0002'),
    ).rejects.toMatchObject({ response: { code: 'CONNECTION_INVALID' } });
    expect(repository.createApiKey).not.toHaveBeenCalled();
  });

  it('rejects a second use of the same OAuth state', async () => {
    const { service } = setup();
    const started = await service.startOAuth(actor, 'GEMINI', callbackUrl, 'oauth:0001');

    await service.finishOAuth('GEMINI', started.state, 'authorization-code');

    await expect(
      service.finishOAuth('GEMINI', started.state, 'authorization-code'),
    ).rejects.toMatchObject({ response: { code: 'OAUTH_STATE_INVALID' } });
  });

  it('rejects expired OAuth state without exchanging the code', async () => {
    const { service, oauth, stateStore } = setup();
    const started = await service.startOAuth(actor, 'GEMINI', callbackUrl, 'oauth:0002');
    stateStore.advanceBy(10 * 60 * 1000);

    await expect(
      service.finishOAuth('GEMINI', started.state, 'authorization-code'),
    ).rejects.toMatchObject({ response: { code: 'OAUTH_STATE_INVALID' } });
    expect(oauth.exchangeGeminiCode).not.toHaveBeenCalled();
  });

  it('keeps the PKCE verifier, nonce, owner and redirect server-side', async () => {
    const { service, verifier } = setup();
    const started = await service.startOAuth(actor, 'GEMINI', callbackUrl, 'oauth:0003');

    expect(started.authorizationUrl).toContain('code_challenge=');
    expect(started.authorizationUrl).toContain('nonce=');
    expect(JSON.stringify(started)).not.toMatch(/verifier|auth0\|owner/i);

    await service.finishOAuth('GEMINI', started.state, 'authorization-code');
    expect(verifier.verify).toHaveBeenCalledWith('GEMINI', 'OAUTH', 'oauth-access-secret');
  });

  it('persists the authenticated owner before OAuth and resolves only by sub at callback', async () => {
    const { service, repository } = setup();
    const started = await service.startOAuth(
      { ...actor, roles: ['admin'] },
      'GEMINI',
      callbackUrl,
      'oauth:0004',
    );

    await service.finishOAuth('GEMINI', started.state, 'authorization-code');

    expect(repository.ensureOwner).toHaveBeenCalledWith({ ...actor, roles: ['admin'] });
    expect(vi.mocked(repository.createOAuth).mock.calls[0]?.[0]).toBe(actor.sub);
  });

  it('rejects redirect URIs outside the exact configured allowlist', async () => {
    const { service } = setup();

    await expect(
      service.startOAuth(actor, 'GEMINI', `${callbackUrl}/evil`, 'oauth:0005'),
    ).rejects.toMatchObject({ response: { code: 'OAUTH_REDIRECT_INVALID' } });
  });

  it('returns not found for another owner connection', async () => {
    const { service } = setup();

    await expect(service.remove(otherActor, 'cm1234567890', 'remove:0001')).rejects.toMatchObject({ status: 404 });
  });

  it('revokes locally before best-effort remote revocation and stays revoked on remote failure', async () => {
    const { service, repository, oauth } = setup();
    vi.mocked(oauth.revokeGemini).mockRejectedValue(new Error('body-with-token-secret'));
    vi.mocked(repository.revokeOwned).mockResolvedValue(
      connection({ provider: 'GEMINI', credentialMode: 'OAUTH', state: 'REVOKED' }),
    );

    const result = await service.remove(actor, 'cm1234567890', 'remove:0002');

    expect(result.state).toBe('REVOKED');
    expect(vi.mocked(repository.revokeOwned).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(oauth.revokeGemini).mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER,
    );
    expect(repository.updateValidation).not.toHaveBeenCalled();
  });

  it('uses sanitized public OAuth exchange errors', async () => {
    const { service, oauth } = setup();
    const started = await service.startOAuth(actor, 'GEMINI', callbackUrl, 'oauth:0006');
    vi.mocked(oauth.exchangeGeminiCode).mockRejectedValue(
      new Error('authorization-code oauth-access-secret response-body'),
    );

    const failure = await service
      .finishOAuth('GEMINI', started.state, 'authorization-code')
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(HttpException);
    if (!(failure instanceof HttpException)) throw new Error('expected HttpException');
    expect(JSON.stringify(failure.getResponse())).toBe(
      JSON.stringify({ code: 'OAUTH_EXCHANGE_FAILED', message: 'OAuth authorization failed' }),
    );
  });
});
