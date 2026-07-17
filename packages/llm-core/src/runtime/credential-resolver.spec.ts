import { describe, expect, it, vi } from 'vitest';
import { ProviderRegistry } from '../providers/provider-registry';
import { ProviderFailure } from '../providers/provider-errors';
import { CredentialResolver } from './credential-resolver';

const capabilities = [
  {
    provider: 'OPENAI',
    credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
    models: ['gpt-test'],
    contextWindowTokens: 8_000,
    maxOutputTokens: 1_000,
    supportsStructuredOutput: true,
    supportsCancellation: true,
    supportsCredentialRefresh: false,
    oauthScopes: [],
    previewEligible: true,
    pricingMetadataVersion: 'test-v1',
    enabled: true,
    circuitBreakerOpen: false,
  },
  {
    provider: 'GEMINI',
    credentialModes: ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'],
    models: ['gemini-test'],
    contextWindowTokens: 8_000,
    maxOutputTokens: 1_000,
    supportsStructuredOutput: true,
    supportsCancellation: true,
    supportsCredentialRefresh: true,
    oauthScopes: ['scope'],
    previewEligible: true,
    pricingMetadataVersion: 'test-v1',
    enabled: true,
    circuitBreakerOpen: false,
  },
] as const;

describe('CredentialResolver', () => {
  it('decrypts only an ACTIVE owner-scoped API key connection', async () => {
    const load = vi.fn().mockResolvedValue({
      ownerId: 'owner-1',
      encryptionOwnerId: 'auth0|owner-1',
      provider: 'OPENAI',
      credentialMode: 'API_KEY',
      state: 'ACTIVE',
      encryptedCredential: { token: 'ciphertext' },
      credentialVersion: 1,
      expiresAt: null,
    });
    const decrypt = vi.fn().mockResolvedValue('sk-sensitive');
    const resolver = new CredentialResolver(
      new ProviderRegistry(capabilities),
      { load },
      { decrypt },
      { resolve: vi.fn() },
    );

    const result = await resolver.resolve({
      ownerId: 'owner-1',
      provider: 'OPENAI',
      mode: 'API_KEY',
      connectionId: 'connection-1',
    });

    expect(result).toEqual({ mode: 'API_KEY', value: 'sk-sensitive' });
    expect(decrypt).toHaveBeenCalledWith('auth0|owner-1', 'OPENAI', { token: 'ciphertext' });
  });

  it('refuses cross-owner, inactive, and unsupported provider modes without leaking records', async () => {
    const load = vi.fn().mockResolvedValue({
      ownerId: 'other-owner',
      encryptionOwnerId: 'auth0|other',
      provider: 'GEMINI',
      credentialMode: 'OAUTH',
      state: 'ACTIVE',
      encryptedCredential: {},
      credentialVersion: 1,
      expiresAt: null,
    });
    const resolver = new CredentialResolver(
      new ProviderRegistry(capabilities),
      { load },
      { decrypt: vi.fn() },
      { resolve: vi.fn() },
    );

    await expect(
      resolver.resolve({
        ownerId: 'owner-1',
        provider: 'OPENAI',
        mode: 'API_KEY',
        connectionId: 'connection-1',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_FAILED' });
    await expect(
      resolver.resolve({
        ownerId: 'owner-1',
        provider: 'OPENAI',
        mode: 'OAUTH',
        connectionId: 'connection-1',
      }),
    ).rejects.toBeInstanceOf(ProviderFailure);
  });

  it('uses platform credential without requiring a user connection', async () => {
    const platform = { resolve: vi.fn().mockResolvedValue('platform-secret') };
    const resolver = new CredentialResolver(
      new ProviderRegistry(capabilities),
      { load: vi.fn() },
      { decrypt: vi.fn() },
      platform,
    );

    await expect(
      resolver.resolve({
        ownerId: 'owner-1',
        provider: 'GEMINI',
        mode: 'PLATFORM_CREDITS',
        connectionId: null,
      }),
    ).resolves.toEqual({ mode: 'PLATFORM_CREDITS', value: 'platform-secret' });
  });

  it('refreshes an expired Gemini OAuth token through the persistence port', async () => {
    const serialized = JSON.stringify({
      accessToken: 'expired',
      refreshToken: 'refresh-secret',
      expiresAt: '2026-01-01T00:00:00.000Z',
    });
    const stored = {
      ownerId: 'owner-1',
      encryptionOwnerId: 'auth0|owner-1',
      provider: 'GEMINI' as const,
      credentialMode: 'OAUTH' as const,
      state: 'ACTIVE' as const,
      encryptedCredential: {},
      credentialVersion: 1,
      expiresAt: new Date(0),
    };
    const refresh = vi.fn().mockResolvedValue('fresh-access-token');
    const resolver = new CredentialResolver(
      new ProviderRegistry(capabilities),
      { load: vi.fn().mockResolvedValue(stored) },
      { decrypt: vi.fn().mockResolvedValue(serialized) },
      { resolve: vi.fn() },
      { refresh },
    );
    await expect(
      resolver.resolve({
        ownerId: 'owner-1',
        provider: 'GEMINI',
        mode: 'OAUTH',
        connectionId: 'connection-1',
      }),
    ).resolves.toEqual({ mode: 'OAUTH', value: 'fresh-access-token' });
    expect(refresh).toHaveBeenCalledWith('connection-1', stored, serialized);
  });
});
