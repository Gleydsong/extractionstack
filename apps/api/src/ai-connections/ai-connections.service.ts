import { createHash, randomBytes } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  AiConnectionSchema,
  GeminiOAuthStartResponseSchema,
  type AiConnection,
  type Auth0User,
  type CredentialMode,
  type GeminiOAuthStartResponse,
  type LlmProvider,
} from '@extractionstack/shared';
import { z } from 'zod';
import { CredentialVault, type CredentialEnvelope } from './credential-vault.js';
import {
  IDEMPOTENCY_STORE,
  type IdempotencyStorePort,
  type OAuthStateStorePort,
} from './oauth-state.service.js';

export const AI_CONNECTIONS_REPOSITORY = Symbol('AI_CONNECTIONS_REPOSITORY');
export const PROVIDER_CREDENTIAL_VERIFIER = Symbol('PROVIDER_CREDENTIAL_VERIFIER');
export const OAUTH_STATE_STORE = Symbol('OAUTH_STATE_STORE');
export const GEMINI_OAUTH_CLIENT = Symbol('GEMINI_OAUTH_CLIENT');
export const AI_CONNECTIONS_CONFIG = Symbol('AI_CONNECTIONS_CONFIG');

export type StoredAiConnection = Omit<
  AiConnection,
  'createdAt' | 'updatedAt' | 'expiresAt' | 'validatedAt' | 'lastUsedAt'
> &
  Readonly<{
    ownerId: string;
    createdAt: Date;
    updatedAt: Date;
    expiresAt: Date | null;
    validatedAt: Date | null;
    lastUsedAt: Date | null;
  }>;

export type CredentialReference = Readonly<{
  connectionId: string;
  ownerId: string;
  provider: LlmProvider;
  credentialMode: CredentialMode;
}>;

export type DurableMutationInput = Readonly<{
  operation: string;
  keyHash: string;
  requestHash: string;
}>;

export type DurableConnectionOutcome = Readonly<{
  result: AiConnection;
  replayed: boolean;
}>;

export type CredentialValidation = Readonly<{
  valid: boolean;
  scopes: readonly string[];
  expiresAt: string | null;
}>;

export interface ProviderCredentialVerifierPort {
  verify(
    provider: 'OPENAI' | 'GEMINI',
    mode: 'API_KEY' | 'OAUTH',
    credential: string,
  ): Promise<CredentialValidation>;
}

export type OAuthTokens = Readonly<{
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string;
  scopes: readonly string[];
}>;

export interface OAuthTokenClientPort {
  exchangeGeminiCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<OAuthTokens>;
  revokeGemini(accessToken: string): Promise<void>;
}

export interface AiConnectionsRepositoryPort {
  listOwned(actor: Auth0User): Promise<readonly StoredAiConnection[]>;
  createApiKey(
    actor: Auth0User,
    input: {
      provider: 'OPENAI' | 'GEMINI';
      displayLabel: string;
      maskedCredential: string;
      envelope: CredentialEnvelope;
      scopes: readonly string[];
      expiresAt: Date | null;
      validatedAt: Date;
      idempotency: DurableMutationInput;
    },
  ): Promise<DurableConnectionOutcome>;
  createOAuth(
    ownerSub: string,
    input: {
      displayLabel: string;
      maskedCredential: string;
      envelope: CredentialEnvelope;
      scopes: readonly string[];
      expiresAt: Date;
      validatedAt: Date;
    },
  ): Promise<StoredAiConnection>;
  findOwnedCredential(
    actor: Auth0User,
    id: string,
  ): Promise<{ connection: StoredAiConnection; envelope: CredentialEnvelope | null } | null>;
  updateValidation(
    actor: Auth0User,
    id: string,
    validation: {
      state: 'ACTIVE' | 'INVALID';
      scopes: readonly string[];
      expiresAt: Date | null;
      validatedAt: Date;
      idempotency: DurableMutationInput;
    },
  ): Promise<DurableConnectionOutcome | null>;
  revokeOwned(
    actor: Auth0User,
    id: string,
    idempotency: DurableMutationInput,
  ): Promise<DurableConnectionOutcome | null>;
  ensureOwner(actor: Auth0User): Promise<void>;
}

export type AiConnectionsConfig = Readonly<{
  geminiClientId: string;
  geminiAuthorizationUrl: string;
  allowedRedirectUris: readonly string[];
  oauthEnabled?: boolean;
  now?: () => Date;
}>;

const ApiKeyCommandSchema = z
  .object({
    provider: z.enum(['OPENAI', 'GEMINI']),
    displayLabel: z.string().trim().min(1).max(120),
    apiKey: z.string().min(8).max(16_384),
  })
  .strict();

const OAuthTokenPayloadSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384).nullable(),
  })
  .strict();
@Injectable()
export class AiConnectionsService {
  constructor(
    @Inject(AI_CONNECTIONS_REPOSITORY) private readonly repository: AiConnectionsRepositoryPort,
    @Inject(CredentialVault) private readonly vault: CredentialVault,
    @Inject(PROVIDER_CREDENTIAL_VERIFIER) private readonly verifier: ProviderCredentialVerifierPort,
    @Inject(OAUTH_STATE_STORE) private readonly oauthStates: OAuthStateStorePort,
    @Inject(GEMINI_OAUTH_CLIENT) private readonly oauthClient: OAuthTokenClientPort,
    @Inject(AI_CONNECTIONS_CONFIG) private readonly config: AiConnectionsConfig,
    @Inject(IDEMPOTENCY_STORE) private readonly idempotency: IdempotencyStorePort,
  ) {}

  async list(actor: Auth0User): Promise<AiConnection[]> {
    return Promise.all((await this.repository.listOwned(actor)).map(toPublicConnection));
  }

  async addApiKey(
    actor: Auth0User,
    rawCommand: unknown,
    idempotencyKey: string,
  ): Promise<AiConnection> {
    const command = ApiKeyCommandSchema.parse(rawCommand);
    const requestHash = fingerprint({
      provider: command.provider,
      displayLabel: command.displayLabel,
      apiKeyHash: secretHash(command.apiKey),
    });
    return this.idempotency.execute({
      ownerSub: actor.sub,
      operation: 'add-api-key',
      key: idempotencyKey,
      fingerprint: requestHash,
      parse: (value) => AiConnectionSchema.parse(value),
      run: async () => {
        const validation = await this.verifyOrThrow(command.provider, 'API_KEY', command.apiKey);
        const envelope = await this.vault.encrypt(actor.sub, command.provider, command.apiKey);
        const connection = await this.repository.createApiKey(actor, {
          provider: command.provider,
          displayLabel: command.displayLabel,
          maskedCredential: maskCredential(command.apiKey),
          envelope,
          scopes: validation.scopes,
          expiresAt: validation.expiresAt ? new Date(validation.expiresAt) : null,
          validatedAt: this.now(),
          idempotency: {
            operation: 'add-api-key',
            keyHash: secretHash(idempotencyKey),
            requestHash,
          },
        });
        return connection.result;
      },
    });
  }

  async startOAuth(
    actor: Auth0User,
    provider: 'GEMINI',
    redirectUri: string,
    idempotencyKey: string,
  ): Promise<GeminiOAuthStartResponse> {
    if (provider !== 'GEMINI') throw oauthProviderInvalid();
    if (this.config.oauthEnabled === false) {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'Gemini OAuth is not configured',
      });
    }
    if (!this.config.allowedRedirectUris.includes(redirectUri)) {
      throw new BadRequestException({
        code: 'OAUTH_REDIRECT_INVALID',
        message: 'OAuth redirect URI is not allowed',
      });
    }
    assertExactHttpsOrLocalRedirect(redirectUri);
    return this.idempotency.execute({
      ownerSub: actor.sub,
      operation: 'start-gemini-oauth',
      key: idempotencyKey,
      fingerprint: fingerprint({ provider, redirectUri }),
      run: async () => {
        await this.repository.ensureOwner(actor);
        const verifier = randomBytes(32).toString('base64url');
        const state = await this.oauthStates.create({
          ownerSub: actor.sub,
          provider,
          redirectUri,
          verifier,
        });
        const authorizationUrl = new URL(this.config.geminiAuthorizationUrl);
        authorizationUrl.search = new URLSearchParams({
          client_id: this.config.geminiClientId,
          redirect_uri: redirectUri,
          response_type: 'code',
          scope: [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/generative-language.retriever',
          ].join(' '),
          access_type: 'offline',
          prompt: 'consent',
          state,
          code_challenge: createHash('sha256').update(verifier).digest('base64url'),
          code_challenge_method: 'S256',
        }).toString();
        return GeminiOAuthStartResponseSchema.parse({
          state,
          authorizationUrl: authorizationUrl.toString(),
        });
      },
      encodeResult: (value) =>
        this.vault.encrypt(
          actor.sub,
          'GEMINI',
          JSON.stringify(GeminiOAuthStartResponseSchema.parse(value)),
        ),
      parse: async (value) => {
        const plaintext = await this.vault.decrypt(
          actor.sub,
          'GEMINI',
          value as CredentialEnvelope,
        );
        return GeminiOAuthStartResponseSchema.parse(JSON.parse(plaintext));
      },
      cacheRequired: true,
    });
  }

  async finishOAuth(provider: 'GEMINI', state: string, code: string): Promise<AiConnection> {
    if (provider !== 'GEMINI') throw oauthProviderInvalid();
    const storedState = await this.oauthStates.consume(state);
    if (
      !storedState ||
      storedState.provider !== provider ||
      !this.config.allowedRedirectUris.includes(storedState.redirectUri)
    )
      throw oauthStateInvalid();
    let tokens: OAuthTokens;
    try {
      tokens = await this.oauthClient.exchangeGeminiCode({
        code,
        redirectUri: storedState.redirectUri,
        verifier: storedState.verifier,
      });
    } catch {
      throw new BadGatewayException({
        code: 'OAUTH_EXCHANGE_FAILED',
        message: 'OAuth authorization failed',
      });
    }
    await this.verifyOrThrow('GEMINI', 'OAUTH', tokens.accessToken);
    const serialized = JSON.stringify({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    });
    const envelope = await this.vault.encrypt(storedState.ownerSub, 'GEMINI', serialized);
    const created = await this.repository.createOAuth(storedState.ownerSub, {
      displayLabel: 'Google Gemini',
      maskedCredential: maskCredential(tokens.accessToken),
      envelope,
      scopes: tokens.scopes,
      expiresAt: new Date(tokens.expiresAt),
      validatedAt: this.now(),
    });
    return toPublicConnection(created);
  }

  async validate(actor: Auth0User, id: string, idempotencyKey: string): Promise<AiConnection> {
    const requestHash = fingerprint({ id });
    return this.idempotency.execute({
      ownerSub: actor.sub,
      operation: `validate:${id}`,
      key: idempotencyKey,
      fingerprint: requestHash,
      parse: (value) => AiConnectionSchema.parse(value),
      run: () =>
        this.validateOnce(actor, id, {
          operation: `validate:${id}`,
          keyHash: secretHash(idempotencyKey),
          requestHash,
        }),
    });
  }

  private async validateOnce(
    actor: Auth0User,
    id: string,
    idempotency: DurableMutationInput,
  ): Promise<AiConnection> {
    const owned = await this.repository.findOwnedCredential(actor, id);
    if (!owned?.envelope || owned.connection.state === 'REVOKED') throw connectionNotFound();
    const plaintext = await this.vault.decrypt(
      actor.sub,
      owned.connection.provider,
      owned.envelope,
    );
    const credential = credentialValue(owned.connection.credentialMode, plaintext);
    const validation = await this.verifyOrThrow(
      owned.connection.provider as 'OPENAI' | 'GEMINI',
      owned.connection.credentialMode as 'API_KEY' | 'OAUTH',
      credential,
    );
    const updated = await this.repository.updateValidation(actor, id, {
      state: validation.valid ? 'ACTIVE' : 'INVALID',
      scopes: validation.scopes,
      expiresAt: validation.expiresAt ? new Date(validation.expiresAt) : null,
      validatedAt: this.now(),
      idempotency,
    });
    if (!updated) throw connectionNotFound();
    return updated.result;
  }

  async remove(actor: Auth0User, id: string, idempotencyKey: string): Promise<AiConnection> {
    const requestHash = fingerprint({ id });
    return this.idempotency.execute({
      ownerSub: actor.sub,
      operation: `remove:${id}`,
      key: idempotencyKey,
      fingerprint: requestHash,
      parse: (value) => AiConnectionSchema.parse(value),
      run: () =>
        this.removeOnce(actor, id, {
          operation: `remove:${id}`,
          keyHash: secretHash(idempotencyKey),
          requestHash,
        }),
    });
  }

  private async removeOnce(
    actor: Auth0User,
    id: string,
    idempotency: DurableMutationInput,
  ): Promise<AiConnection> {
    const owned = await this.repository.findOwnedCredential(actor, id);
    if (!owned) throw connectionNotFound();
    const revoked = await this.repository.revokeOwned(actor, id, idempotency);
    if (!revoked) throw connectionNotFound();

    if (
      !revoked.replayed &&
      owned.connection.provider === 'GEMINI' &&
      owned.connection.credentialMode === 'OAUTH' &&
      owned.envelope
    ) {
      try {
        const plaintext = await this.vault.decrypt(actor.sub, 'GEMINI', owned.envelope);
        const payload = OAuthTokenPayloadSchema.parse(JSON.parse(plaintext));
        await this.oauthClient.revokeGemini(payload.accessToken);
      } catch {
        // Local revocation is authoritative; remote revocation is best effort.
      }
    }
    return revoked.result;
  }

  async credentialReference(actor: Auth0User, id: string): Promise<CredentialReference> {
    const owned = await this.repository.findOwnedCredential(actor, id);
    if (!owned || owned.connection.state !== 'ACTIVE') throw connectionNotFound();
    return Object.freeze({
      connectionId: owned.connection.id,
      ownerId: owned.connection.ownerId,
      provider: owned.connection.provider,
      credentialMode: owned.connection.credentialMode,
    });
  }

  private async verifyOrThrow(
    provider: 'OPENAI' | 'GEMINI',
    mode: 'API_KEY' | 'OAUTH',
    credential: string,
  ): Promise<CredentialValidation> {
    let validation: CredentialValidation;
    try {
      validation = await this.verifier.verify(provider, mode, credential);
    } catch {
      throw new BadGatewayException({
        code: 'CONNECTION_VERIFICATION_FAILED',
        message: 'Provider credential verification failed',
      });
    }
    if (!validation.valid) {
      throw new BadRequestException({
        code: 'CONNECTION_INVALID',
        message: 'Provider credential is invalid',
      });
    }
    return validation;
  }

  private now(): Date {
    return this.config.now?.() ?? new Date();
  }
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function secretHash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function toPublicConnection(connection: StoredAiConnection): AiConnection {
  return AiConnectionSchema.parse({
    id: connection.id,
    provider: connection.provider,
    displayLabel: connection.displayLabel,
    credentialMode: connection.credentialMode,
    state: connection.state,
    maskedCredential: connection.maskedCredential,
    scopes: [...connection.scopes],
    expiresAt: connection.expiresAt?.toISOString() ?? null,
    validatedAt: connection.validatedAt?.toISOString() ?? null,
    lastUsedAt: connection.lastUsedAt?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  });
}

function maskCredential(value: string): string {
  return `…${value.slice(-4)}`;
}

function credentialValue(mode: CredentialMode, plaintext: string): string {
  if (mode === 'API_KEY') return plaintext;
  if (mode === 'OAUTH') return OAuthTokenPayloadSchema.parse(JSON.parse(plaintext)).accessToken;
  throw new Error('unsupported credential mode');
}

function connectionNotFound(): NotFoundException {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'AI connection not found' });
}

function oauthStateInvalid(): BadRequestException {
  return new BadRequestException({
    code: 'OAUTH_STATE_INVALID',
    message: 'OAuth state is invalid',
  });
}

function oauthProviderInvalid(): BadRequestException {
  return new BadRequestException({
    code: 'VALIDATION',
    message: 'OAuth is supported only for Gemini',
  });
}

function assertExactHttpsOrLocalRedirect(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new BadRequestException({
      code: 'OAUTH_REDIRECT_INVALID',
      message: 'OAuth redirect URI is not allowed',
    });
  }
  if (
    url.username ||
    url.password ||
    url.hash ||
    (url.protocol !== 'https:' && url.hostname !== 'localhost')
  ) {
    throw new BadRequestException({
      code: 'OAUTH_REDIRECT_INVALID',
      message: 'OAuth redirect URI is not allowed',
    });
  }
}
