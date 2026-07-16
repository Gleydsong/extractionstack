import { Injectable, Module, ServiceUnavailableException } from '@nestjs/common';
import { z } from 'zod';
import { ProviderRegistry } from '@extractionstack/llm-core';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import { AiConnectionsController, AiProvidersController } from './ai-connections.controller.js';
import { AiConnectionsRepository } from './ai-connections.repository.js';
import {
  AI_CONNECTIONS_CONFIG,
  AI_CONNECTIONS_REPOSITORY,
  AiConnectionsService,
  GEMINI_OAUTH_CLIENT,
  OAUTH_STATE_STORE,
  PROVIDER_CREDENTIAL_VERIFIER,
  type OAuthTokenClientPort,
  type OAuthTokens,
  type ProviderCredentialVerifierPort,
} from './ai-connections.service.js';
import { CredentialVault } from './credential-vault.js';
import {
  createOAuthRedis,
  IDEMPOTENCY_STORE,
  OAUTH_STATE_REDIS,
  OAuthStateService,
  RedisIdempotencyService,
} from './oauth-state.service.js';

const MAX_PROVIDER_BODY_BYTES = 64 * 1024;

const TokenResponseSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384).optional(),
    expires_in: z.number().int().positive().max(31_536_000),
    scope: z.string().max(8_192).default(''),
  })
  .passthrough();

@Injectable()
export class HttpProviderCredentialVerifier implements ProviderCredentialVerifierPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async verify(provider: 'OPENAI' | 'GEMINI', mode: 'API_KEY' | 'OAUTH', credential: string) {
    const runtime = loadRuntimeEnv(this.env);
    const endpoint =
      provider === 'OPENAI'
        ? new URL('models?limit=1', ensureTrailingSlash(runtime.LLM_OPENAI_BASE_URL))
        : new URL('models?pageSize=1', ensureTrailingSlash(runtime.LLM_GEMINI_BASE_URL));
    const headers: Record<string, string> = { accept: 'application/json' };
    if (provider === 'OPENAI' || mode === 'OAUTH') headers.authorization = `Bearer ${credential}`;
    else headers['x-goog-api-key'] = credential;
    if (provider === 'GEMINI' && mode === 'OAUTH') {
      headers['x-goog-user-project'] = oauthEnvironment(this.env).projectId;
    }
    const response = await this.fetchImpl(endpoint, {
      method: 'GET',
      headers,
      redirect: 'error',
      signal: AbortSignal.timeout(runtime.LLM_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) {
      return Object.freeze({ valid: false, scopes: Object.freeze([]), expiresAt: null });
    }
    if (!response.ok) throw new Error('provider verification unavailable');
    return Object.freeze({ valid: true, scopes: Object.freeze([]), expiresAt: null });
  }
}

@Injectable()
export class GeminiOAuthClient implements OAuthTokenClientPort {
  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  async exchangeGeminiCode(input: {
    code: string;
    redirectUri: string;
    verifier: string;
  }): Promise<OAuthTokens> {
    const config = oauthEnvironment(this.env);
    const response = await this.fetchImpl(config.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code,
        code_verifier: input.verifier,
        redirect_uri: input.redirectUri,
      }),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    const body = await readBoundedJson(response);
    if (!response.ok) throw new Error('OAuth exchange failed');
    const tokens = TokenResponseSchema.parse(body);
    return Object.freeze({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? null,
      expiresAt: new Date(Date.now() + tokens.expires_in * 1_000).toISOString(),
      scopes: Object.freeze(tokens.scope.split(/\s+/).filter(Boolean).slice(0, 30)),
    });
  }

  async revokeGemini(accessToken: string): Promise<void> {
    const config = oauthEnvironment(this.env);
    const response = await this.fetchImpl(config.revokeUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: accessToken }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    await response.body?.cancel().catch(() => undefined);
    if (!response.ok) throw new Error('OAuth revocation failed');
  }
}

@Module({
  controllers: [AiConnectionsController, AiProvidersController],
  providers: [
    AiConnectionsService,
    AiConnectionsRepository,
    {
      provide: ProviderRegistry,
      useFactory: () => createProviderRegistry(process.env),
    },
    { provide: AI_CONNECTIONS_REPOSITORY, useExisting: AiConnectionsRepository },
    {
      provide: CredentialVault,
      useFactory: () => {
        const env = loadRuntimeEnv(process.env);
        if (!env.LLM_CREDENTIAL_MASTER_KEY) {
          const unavailable = async (): Promise<never> => {
            throw new ServiceUnavailableException({
              code: 'DEPENDENCY_UNAVAILABLE',
              message: 'LLM credential vault is not configured',
            });
          };
          return { encrypt: unavailable, decrypt: unavailable } as unknown as CredentialVault;
        }
        return new CredentialVault(env.LLM_CREDENTIAL_MASTER_KEY, env.LLM_CREDENTIAL_KEY_VERSION);
      },
    },
    {
      provide: HttpProviderCredentialVerifier,
      useFactory: () => new HttpProviderCredentialVerifier(fetch, process.env),
    },
    { provide: PROVIDER_CREDENTIAL_VERIFIER, useExisting: HttpProviderCredentialVerifier },
    {
      provide: GeminiOAuthClient,
      useFactory: () => new GeminiOAuthClient(fetch, process.env),
    },
    { provide: GEMINI_OAUTH_CLIENT, useExisting: GeminiOAuthClient },
    {
      provide: OAUTH_STATE_REDIS,
      useFactory: () => createOAuthRedis(loadRuntimeEnv(process.env).REDIS_URL),
    },
    {
      provide: OAuthStateService,
      useFactory: (redis: ReturnType<typeof createOAuthRedis>) => new OAuthStateService(redis),
      inject: [OAUTH_STATE_REDIS],
    },
    { provide: OAUTH_STATE_STORE, useExisting: OAuthStateService },
    {
      provide: RedisIdempotencyService,
      useFactory: (redis: ReturnType<typeof createOAuthRedis>) =>
        new RedisIdempotencyService(redis),
      inject: [OAUTH_STATE_REDIS],
    },
    { provide: IDEMPOTENCY_STORE, useExisting: RedisIdempotencyService },
    {
      provide: AI_CONNECTIONS_CONFIG,
      useFactory: () => {
        const config = oauthEnvironment(process.env);
        return {
          geminiClientId: config.clientId,
          geminiAuthorizationUrl: config.authorizationUrl,
          allowedRedirectUris: config.redirectUris,
          oauthEnabled: config.enabled,
        };
      },
    },
  ],
  exports: [AiConnectionsService],
})
export class AiConnectionsModule {}

export function createProviderRegistry(envInput: NodeJS.ProcessEnv): ProviderRegistry {
  const env = loadRuntimeEnv(envInput);
  const oauth = oauthEnvironment(envInput);
  const geminiCredentialModes = oauth.enabled
    ? (['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'] as const)
    : (['API_KEY', 'PLATFORM_CREDITS'] as const);
  return new ProviderRegistry([
    {
      provider: 'OPENAI',
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
      models: env.LLM_OPENAI_MODEL_ALLOWLIST,
      contextWindowTokens: env.LLM_MAX_INPUT_TOKENS,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      supportsStructuredOutput: true,
      supportsCancellation: false,
      supportsCredentialRefresh: false,
      oauthScopes: [],
      previewEligible: true,
      pricingMetadataVersion: 'configured-2026-07-16',
      enabled: true,
      circuitBreakerOpen: false,
    },
    {
      provider: 'GEMINI',
      credentialModes: geminiCredentialModes,
      models: env.LLM_GEMINI_MODEL_ALLOWLIST,
      contextWindowTokens: env.LLM_MAX_INPUT_TOKENS,
      maxOutputTokens: env.LLM_MAX_OUTPUT_TOKENS,
      supportsStructuredOutput: true,
      supportsCancellation: false,
      supportsCredentialRefresh: oauth.enabled,
      oauthScopes: oauth.enabled
        ? [
            'https://www.googleapis.com/auth/cloud-platform',
            'https://www.googleapis.com/auth/generative-language.retriever',
          ]
        : [],
      previewEligible: true,
      pricingMetadataVersion: 'configured-2026-07-16',
      enabled: true,
      circuitBreakerOpen: false,
    },
  ]);
}

function oauthEnvironment(env: NodeJS.ProcessEnv) {
  const rawClientId = env.LLM_GEMINI_OAUTH_CLIENT_ID?.trim();
  const rawClientSecret = env.LLM_GEMINI_OAUTH_CLIENT_SECRET?.trim();
  const rawProjectId = env.LLM_GEMINI_OAUTH_PROJECT_ID?.trim();
  const rawRedirectUris = (env.LLM_GEMINI_OAUTH_REDIRECT_URIS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  const enabled = Boolean(
    rawClientId && rawClientSecret && rawProjectId && rawRedirectUris.length > 0,
  );
  const clientId = enabled
    ? z.string().trim().min(1).max(512).parse(rawClientId)
    : 'oauth-not-configured';
  const clientSecret = enabled
    ? z.string().trim().min(1).max(1_024).parse(rawClientSecret)
    : 'oauth-not-configured';
  const projectId = enabled
    ? z
        .string()
        .regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/)
        .parse(rawProjectId)
    : 'oauth-not-configured';
  const authorizationUrl = exactHttpsUrl(
    env.LLM_GEMINI_OAUTH_AUTHORIZATION_URL ?? 'https://accounts.google.com/o/oauth2/v2/auth',
  );
  const tokenUrl = exactHttpsUrl(
    env.LLM_GEMINI_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
  );
  const revokeUrl = exactHttpsUrl(
    env.LLM_GEMINI_OAUTH_REVOKE_URL ?? 'https://oauth2.googleapis.com/revoke',
  );
  const redirectUris = enabled
    ? z.array(z.string().url().max(2_048)).min(1).max(10).parse(rawRedirectUris)
    : [];
  return Object.freeze({
    enabled,
    clientId,
    clientSecret,
    projectId,
    authorizationUrl,
    tokenUrl,
    revokeUrl,
    redirectUris,
  });
}

function exactHttpsUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('invalid OAuth endpoint');
  return url.toString();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith('/') ? value : `${value}/`;
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const length = response.headers.get('content-length');
  if (length && Number(length) > MAX_PROVIDER_BODY_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error('OAuth response too large');
  }
  if (!response.body) return null;
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let done = false;
  try {
    while (!done) {
      const next = await reader.read();
      done = next.done;
      if (done) break;
      const value = next.value;
      if (!value) throw new Error('OAuth response stream failed');
      total += value.byteLength;
      if (total > MAX_PROVIDER_BODY_BYTES) throw new Error('OAuth response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}
