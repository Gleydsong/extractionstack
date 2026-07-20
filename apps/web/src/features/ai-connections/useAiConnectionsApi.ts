import { useMemo } from 'react';
import {
  AiConnectionSchema,
  ErrorResponseSchema,
  GeminiOAuthStartResponseSchema,
  PublicProviderCapabilitiesListSchema,
  type AiConnection,
  type ErrorResponse,
  type GeminiOAuthStartResponse,
  type LlmProvider,
  type PublicProviderCapabilities,
} from '@extractionstack/shared';
import { z } from 'zod';
import { useAppAuth } from '../auth/WebAuthProvider';

const DEFAULT_GEMINI_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

const AiConnectionsListSchema = z.array(AiConnectionSchema).max(100);

type PublicErrorCode = ErrorResponse['code'];
export type AiConnectionsClientErrorCode =
  PublicErrorCode | 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR' | 'CONFIGURATION_ERROR';

export class AiConnectionsClientError extends Error {
  constructor(public readonly code: AiConnectionsClientErrorCode) {
    super(code);
    this.name = 'AiConnectionsClientError';
  }
}

export type { GeminiOAuthStartResponse, PublicProviderCapabilities };

export interface ApiKeyCommand {
  provider: Extract<LlmProvider, 'OPENAI' | 'GEMINI'>;
  displayLabel: string;
  apiKey: string;
}

export interface AiConnectionsApi {
  listProviders(): Promise<readonly PublicProviderCapabilities[]>;
  listConnections(): Promise<AiConnection[]>;
  addApiKey(command: ApiKeyCommand, idempotencyKey: string): Promise<AiConnection>;
  startGeminiOAuth(idempotencyKey: string): Promise<GeminiOAuthStartResponse>;
  validateConnection(id: string, idempotencyKey: string): Promise<AiConnection>;
  revokeConnection(id: string, idempotencyKey: string): Promise<AiConnection>;
}

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class AiConnectionsClient implements AiConnectionsApi {
  private readonly baseUrl: string;
  private readonly oauthRedirectUri: string;
  private readonly trustedAuthorizationUrl: URL;

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
    oauthRedirectUri = import.meta.env.VITE_GEMINI_OAUTH_REDIRECT_URI as string | undefined,
    authorizationUrl = (import.meta.env.VITE_GEMINI_OAUTH_AUTHORIZATION_URL as
      string | undefined) ?? DEFAULT_GEMINI_AUTHORIZATION_URL,
  ) {
    const effectiveApiUrl = parseHttpUrl(baseUrl || window.location.origin);
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.oauthRedirectUri = parseOAuthRedirectUri(
      oauthRedirectUri ?? `${effectiveApiUrl.origin}/api/ai/connections/GEMINI/oauth/callback`,
    );
    this.trustedAuthorizationUrl = parseHttpsUrl(authorizationUrl);
  }

  listProviders(): Promise<readonly PublicProviderCapabilities[]> {
    return this.request('/api/ai/providers', PublicProviderCapabilitiesListSchema);
  }

  listConnections(): Promise<AiConnection[]> {
    return this.request('/api/ai/connections', AiConnectionsListSchema);
  }

  addApiKey(command: ApiKeyCommand, idempotencyKey: string): Promise<AiConnection> {
    return this.request('/api/ai/connections/api-key', AiConnectionSchema, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify(command),
    });
  }

  async startGeminiOAuth(idempotencyKey: string): Promise<GeminiOAuthStartResponse> {
    const result = await this.request(
      '/api/ai/connections/GEMINI/oauth/start',
      GeminiOAuthStartResponseSchema,
      {
        method: 'POST',
        headers: { 'idempotency-key': idempotencyKey },
        body: JSON.stringify({ redirectUri: this.oauthRedirectUri }),
      },
    );
    const authorizationUrl = new URL(result.authorizationUrl);
    if (
      authorizationUrl.origin !== this.trustedAuthorizationUrl.origin ||
      authorizationUrl.pathname !== this.trustedAuthorizationUrl.pathname
    ) {
      throw new AiConnectionsClientError('INVALID_RESPONSE');
    }
    return result;
  }

  validateConnection(id: string, idempotencyKey: string): Promise<AiConnection> {
    return this.request(
      `/api/ai/connections/${encodeURIComponent(id)}/validate`,
      AiConnectionSchema,
      { method: 'POST', headers: { 'idempotency-key': idempotencyKey } },
    );
  }

  revokeConnection(id: string, idempotencyKey: string): Promise<AiConnection> {
    return this.request(`/api/ai/connections/${encodeURIComponent(id)}`, AiConnectionSchema, {
      method: 'DELETE',
      headers: { 'idempotency-key': idempotencyKey },
    });
  }

  private async request<T>(
    path: string,
    schema: RuntimeSchema<T>,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      const token = await this.getAccessToken();
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });
    } catch (cause) {
      if (cause instanceof DOMException && cause.name === 'AbortError') throw cause;
      throw new AiConnectionsClientError('NETWORK_ERROR');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new AiConnectionsClientError('INVALID_RESPONSE');
    }

    if (!response.ok) {
      const parsedError = ErrorResponseSchema.safeParse(body);
      throw new AiConnectionsClientError(
        parsedError.success ? parsedError.data.code : 'HTTP_ERROR',
      );
    }

    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new AiConnectionsClientError('INVALID_RESPONSE');
    return parsed.data;
  }
}

export function getAiConnectionErrorMessage(error: unknown): string {
  if (!(error instanceof AiConnectionsClientError)) {
    return 'Não foi possível concluir a ação. Tente novamente.';
  }

  switch (error.code) {
    case 'UNAUTHENTICATED':
      return 'Sua sessão expirou. Entre novamente para continuar.';
    case 'FORBIDDEN':
    case 'AUTHORIZATION_FAILED':
      return 'Você não tem permissão para gerenciar conexões de IA.';
    case 'RATE_LIMITED':
      return 'Muitas tentativas foram feitas. Aguarde um pouco e tente novamente.';
    case 'NETWORK_ERROR':
      return 'Não foi possível acessar o servidor. Verifique sua conexão e tente novamente.';
    case 'INVALID_RESPONSE':
      return 'O servidor retornou uma resposta inválida. Tente novamente.';
    case 'CONNECTION_INVALID':
    case 'AUTHENTICATION_FAILED':
      return 'A credencial foi recusada ou precisa ser atualizada.';
    case 'CONNECTION_VERIFICATION_FAILED':
      return 'Não foi possível verificar a credencial com o provedor. Tente novamente.';
    case 'DEPENDENCY_UNAVAILABLE':
    case 'PROVIDER_UNAVAILABLE':
    case 'QUEUE_UNAVAILABLE':
    case 'LLM_TIMEOUT':
      return 'O provedor está temporariamente indisponível. Tente mais tarde.';
    case 'OAUTH_STATE_INVALID':
      return 'A autorização expirou ou já foi utilizada. Inicie a conexão novamente.';
    case 'OAUTH_REDIRECT_INVALID':
    case 'OAUTH_EXCHANGE_FAILED':
      return 'Não foi possível concluir a autorização com o Google. Tente novamente.';
    case 'VALIDATION':
    case 'PAYLOAD_TOO_LARGE':
      return 'Os dados enviados não são válidos. Revise-os e tente novamente.';
    case 'NOT_FOUND':
      return 'A conexão não foi encontrada. Atualize a página e tente novamente.';
    case 'CONFLICT':
      return 'A conexão mudou durante esta ação. Atualize a página e tente novamente.';
    case 'MODEL_UNAVAILABLE':
    case 'LLM_OUTPUT_INVALID':
      return 'O provedor não conseguiu concluir a solicitação. Tente mais tarde.';
    case 'INSUFFICIENT_CREDITS':
    case 'COST_LIMIT_EXCEEDED':
    case 'COST_CONSENT_REQUIRED':
      return 'Os créditos da plataforma não permitem concluir esta ação.';
    case 'CRAWLER_TIMEOUT':
    case 'CRAWLER_TARGET':
    case 'CRAWLER_LIMIT':
    case 'URL_NOT_ALLOWED':
    case 'GUARDRAIL_REJECTED':
    case 'INTERNAL':
    case 'HTTP_ERROR':
    case 'CONFIGURATION_ERROR':
      return 'Não foi possível concluir a ação. Tente novamente.';
  }
}

export function isUncertainAiConnectionsError(error: unknown): boolean {
  return (
    error instanceof AiConnectionsClientError &&
    (error.code === 'NETWORK_ERROR' || error.code === 'INVALID_RESPONSE')
  );
}

export function useAiConnectionsApi(injected?: AiConnectionsApi): AiConnectionsApi {
  const { getAccessTokenSilently } = useAppAuth();
  return useMemo(
    () => injected ?? new AiConnectionsClient(getAccessTokenSilently),
    [getAccessTokenSilently, injected],
  );
}

function parseHttpUrl(value: string): URL {
  try {
    const url = new URL(value, window.location.origin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('protocol');
    return url;
  } catch {
    throw new AiConnectionsClientError('CONFIGURATION_ERROR');
  }
}

function parseHttpsUrl(value: string): URL {
  const url = parseHttpUrl(value);
  if (url.protocol !== 'https:') {
    throw new AiConnectionsClientError('CONFIGURATION_ERROR');
  }
  return url;
}

function parseOAuthRedirectUri(value: string): string {
  const url = parseHttpUrl(value);
  const isLocalHttp =
    url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1');
  if (url.protocol !== 'https:' && !isLocalHttp) {
    throw new AiConnectionsClientError('CONFIGURATION_ERROR');
  }
  return url.toString();
}
