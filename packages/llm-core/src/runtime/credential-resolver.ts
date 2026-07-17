import type { CredentialMode, LlmProvider } from '@extractionstack/shared';
import type { ResolvedProviderCredential } from '../providers/provider-adapter';
import { ProviderFailure } from '../providers/provider-errors';
import type { ProviderRegistry } from '../providers/provider-registry';
import { z } from 'zod';

export type CredentialResolutionRequest = Readonly<{
  ownerId: string;
  provider: LlmProvider;
  mode: CredentialMode;
  connectionId: string | null;
}>;

export type StoredProviderCredential = Readonly<{
  ownerId: string;
  encryptionOwnerId: string;
  provider: LlmProvider;
  credentialMode: Exclude<CredentialMode, 'PLATFORM_CREDITS'>;
  state: 'ACTIVE' | 'PENDING' | 'EXPIRED' | 'REVOKED' | 'INVALID';
  encryptedCredential: unknown;
  credentialVersion: number;
  expiresAt: Date | null;
}>;

export interface CredentialStorePort {
  load(connectionId: string): Promise<StoredProviderCredential | null>;
}

export interface CredentialDecryptorPort {
  decrypt(ownerId: string, provider: LlmProvider, encryptedCredential: unknown): Promise<string>;
}

export interface PlatformCredentialPort {
  resolve(provider: Exclude<LlmProvider, 'FAKE'>): Promise<string>;
}

export interface OAuthCredentialRefreshPort {
  refresh(
    connectionId: string,
    stored: StoredProviderCredential,
    serializedCredential: string,
  ): Promise<string>;
}

const OAuthCredentialSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/;

export class CredentialResolver {
  constructor(
    private readonly registry: ProviderRegistry,
    private readonly store: CredentialStorePort,
    private readonly decryptor: CredentialDecryptorPort,
    private readonly platformCredentials: PlatformCredentialPort,
    private readonly oauthRefresh?: OAuthCredentialRefreshPort,
  ) {}

  async resolve(request: CredentialResolutionRequest): Promise<ResolvedProviderCredential> {
    this.assertRequest(request);
    const capabilities = this.registry.get(request.provider);
    if (
      !capabilities.enabled ||
      capabilities.circuitBreakerOpen ||
      !capabilities.credentialModes.includes(request.mode)
    ) {
      throw new ProviderFailure('AUTHORIZATION_FAILED');
    }

    if (request.mode === 'PLATFORM_CREDITS') {
      if (request.connectionId !== null || request.provider === 'FAKE') {
        throw new ProviderFailure('AUTHORIZATION_FAILED');
      }
      return credential(request.mode, await this.platformCredentials.resolve(request.provider));
    }

    if (!request.connectionId) throw new ProviderFailure('AUTHORIZATION_FAILED');
    const stored = await this.store.load(request.connectionId);
    if (
      !stored ||
      stored.ownerId !== request.ownerId ||
      stored.provider !== request.provider ||
      stored.credentialMode !== request.mode ||
      stored.state !== 'ACTIVE'
    ) {
      throw new ProviderFailure('AUTHORIZATION_FAILED');
    }

    const plaintext = await this.decryptor.decrypt(
      stored.encryptionOwnerId,
      stored.provider,
      stored.encryptedCredential,
    );
    if (request.mode === 'OAUTH') {
      const oauth = parseOauthCredential(plaintext);
      if (stored.expiresAt !== null && stored.expiresAt.getTime() <= Date.now()) {
        if (!this.oauthRefresh || !oauth.refreshToken)
          throw new ProviderFailure('AUTHENTICATION_FAILED');
        return credential(
          request.mode,
          await this.oauthRefresh.refresh(request.connectionId, stored, plaintext),
        );
      }
      return credential(request.mode, oauth.accessToken);
    }
    if (stored.expiresAt !== null && stored.expiresAt.getTime() <= Date.now()) {
      throw new ProviderFailure('AUTHENTICATION_FAILED');
    }
    return credential(request.mode, plaintext);
  }

  private assertRequest(request: CredentialResolutionRequest): void {
    if (
      !ID_PATTERN.test(request.ownerId) ||
      (request.connectionId && !ID_PATTERN.test(request.connectionId))
    ) {
      throw new ProviderFailure('INPUT_INVALID');
    }
    this.registry.get(request.provider);
  }
}

function parseOauthCredential(value: string) {
  try {
    return OAuthCredentialSchema.parse(JSON.parse(value));
  } catch {
    throw new ProviderFailure('AUTHENTICATION_FAILED');
  }
}

function credential(mode: CredentialMode, value: string): ResolvedProviderCredential {
  if (value.length < 1 || value.length > 16_384) throw new ProviderFailure('AUTHENTICATION_FAILED');
  return Object.freeze({ mode, value });
}
