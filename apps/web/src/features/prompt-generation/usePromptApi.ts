import { useMemo } from 'react';
import {
  AiConnectionSchema,
  ErrorResponseSchema,
  PromptGenerationJobSchema,
  PromptCostEstimateSchema,
  PromptPreviewSchema,
  PromptProjectSchema,
  PromptVersionDetailSchema,
  PromptVersionCostEstimateSchema,
  PromptVersionListResponseSchema,
  PublicProviderCapabilitiesListSchema,
  type AiConnection,
  type PromptAdaptationRequest,
  type PromptCostEstimate,
  type PromptCostEstimateRequest,
  type PromptGenerationJob,
  type PromptGenerationRequest,
  type PromptPreview,
  type PromptPreviewRequest,
  type PromptProject,
  type PromptVersionDetail,
  type PromptVersionCostEstimate,
  type PromptVersionCostEstimateRequest,
  type PromptVersionEditRequest,
  type PromptVersionListResponse,
  type PromptWizardInput,
  type PublicProviderCapabilities,
} from '@extractionstack/shared';
import { z } from 'zod';
import { useAppAuth } from '../auth/WebAuthProvider';

const ConnectionsSchema = z.array(AiConnectionSchema).max(100);

type RuntimeSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};
export type PromptClientErrorCode =
  'NETWORK_ERROR' | 'INVALID_RESPONSE' | 'HTTP_ERROR' | z.infer<typeof ErrorResponseSchema>['code'];

export class PromptClientError extends Error {
  constructor(public readonly code: PromptClientErrorCode) {
    super(code);
    this.name = 'PromptClientError';
  }
}

export interface PromptApi {
  listProviders(signal?: AbortSignal): Promise<readonly PublicProviderCapabilities[]>;
  listConnections(signal?: AbortSignal): Promise<AiConnection[]>;
  estimateCost(input: PromptCostEstimateRequest, signal?: AbortSignal): Promise<PromptCostEstimate>;
  createProject(input: PromptWizardInput, key: string): Promise<PromptProject>;
  generate(
    projectId: string,
    input: PromptGenerationRequest,
    key: string,
  ): Promise<PromptGenerationJob>;
  getProject(id: string, signal?: AbortSignal): Promise<PromptProject>;
  listVersions(
    projectId: string,
    cursor?: string,
    signal?: AbortSignal,
  ): Promise<PromptVersionListResponse>;
  getVersion(id: string, signal?: AbortSignal): Promise<PromptVersionDetail>;
  estimateVersionCost(
    id: string,
    input: PromptVersionCostEstimateRequest,
    signal?: AbortSignal,
  ): Promise<PromptVersionCostEstimate>;
  editVersion(
    id: string,
    input: PromptVersionEditRequest,
    key: string,
  ): Promise<PromptVersionDetail>;
  adapt(id: string, input: PromptAdaptationRequest, key: string): Promise<PromptGenerationJob>;
  preview(id: string, input: PromptPreviewRequest, key: string): Promise<PromptGenerationJob>;
  getJob(id: string, signal?: AbortSignal): Promise<PromptGenerationJob>;
  getPreview(id: string, signal?: AbortSignal): Promise<PromptPreview>;
  cancel(id: string, key: string): Promise<PromptGenerationJob>;
}

export class PromptClient implements PromptApi {
  private readonly baseUrl: string;
  constructor(
    private readonly getToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  listProviders(signal?: AbortSignal) {
    return this.request('/api/ai/providers', PublicProviderCapabilitiesListSchema, { signal });
  }
  listConnections(signal?: AbortSignal) {
    return this.request('/api/ai/connections', ConnectionsSchema, { signal });
  }
  estimateCost(input: PromptCostEstimateRequest, signal?: AbortSignal) {
    return this.request('/api/prompt-projects/cost-estimate', PromptCostEstimateSchema, {
      method: 'POST',
      body: JSON.stringify(input),
      signal,
    });
  }
  createProject(input: PromptWizardInput, key: string) {
    return this.mutate('/api/prompt-projects', PromptProjectSchema, input, key);
  }
  generate(id: string, input: PromptGenerationRequest, key: string) {
    return this.mutate(
      `/api/prompt-projects/${encodeURIComponent(id)}/generations`,
      PromptGenerationJobSchema,
      input,
      key,
    );
  }
  getProject(id: string, signal?: AbortSignal) {
    return this.request(`/api/prompt-projects/${encodeURIComponent(id)}`, PromptProjectSchema, {
      signal,
    });
  }
  listVersions(id: string, cursor?: string, signal?: AbortSignal) {
    const query = cursor ? `?cursor=${encodeURIComponent(cursor)}` : '';
    return this.request(
      `/api/prompt-projects/${encodeURIComponent(id)}/versions${query}`,
      PromptVersionListResponseSchema,
      { signal },
    );
  }
  getVersion(id: string, signal?: AbortSignal) {
    return this.request(
      `/api/prompt-versions/${encodeURIComponent(id)}`,
      PromptVersionDetailSchema,
      { signal },
    );
  }
  estimateVersionCost(id: string, input: PromptVersionCostEstimateRequest, signal?: AbortSignal) {
    return this.request(
      `/api/prompt-versions/${encodeURIComponent(id)}/cost-estimate`,
      PromptVersionCostEstimateSchema,
      { method: 'POST', body: JSON.stringify(input), signal },
    );
  }
  editVersion(id: string, input: PromptVersionEditRequest, key: string) {
    return this.mutate(
      `/api/prompt-versions/${encodeURIComponent(id)}/edits`,
      PromptVersionDetailSchema,
      input,
      key,
    );
  }
  adapt(id: string, input: PromptAdaptationRequest, key: string) {
    return this.mutate(
      `/api/prompt-versions/${encodeURIComponent(id)}/adaptations`,
      PromptGenerationJobSchema,
      input,
      key,
    );
  }
  preview(id: string, input: PromptPreviewRequest, key: string) {
    return this.mutate(
      `/api/prompt-versions/${encodeURIComponent(id)}/previews`,
      PromptGenerationJobSchema,
      input,
      key,
    );
  }
  getJob(id: string, signal?: AbortSignal) {
    return this.request(`/api/prompt-jobs/${encodeURIComponent(id)}`, PromptGenerationJobSchema, {
      signal,
    });
  }
  getPreview(id: string, signal?: AbortSignal) {
    return this.request(`/api/prompt-jobs/${encodeURIComponent(id)}/preview`, PromptPreviewSchema, {
      signal,
    });
  }
  cancel(id: string, key: string) {
    return this.mutate(
      `/api/prompt-jobs/${encodeURIComponent(id)}/cancel`,
      PromptGenerationJobSchema,
      undefined,
      key,
    );
  }

  private mutate<T>(
    path: string,
    schema: RuntimeSchema<T>,
    body: unknown,
    key: string,
  ): Promise<T> {
    return this.request(path, schema, {
      method: 'POST',
      headers: { 'idempotency-key': key },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  }

  private async request<T>(
    path: string,
    schema: RuntimeSchema<T>,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      const token = await this.getToken();
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`,
          ...init.headers,
        },
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') throw error;
      throw new PromptClientError('NETWORK_ERROR');
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PromptClientError('INVALID_RESPONSE');
    }
    if (!response.ok) {
      const parsed = ErrorResponseSchema.safeParse(body);
      throw new PromptClientError(parsed.success ? parsed.data.code : 'HTTP_ERROR');
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new PromptClientError('INVALID_RESPONSE');
    return parsed.data;
  }
}

export async function pollPromptJob(
  api: PromptApi,
  jobId: string,
  signal: AbortSignal,
  onUpdate?: (job: PromptGenerationJob) => void,
): Promise<PromptGenerationJob> {
  const delays = [400, 700, 1_000, 1_500, 2_000] as const;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    const job = await api.getJob(jobId, signal);
    onUpdate?.(job);
    if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'AMBIGUOUS'].includes(job.status)) return job;
    await wait(delays[Math.min(attempt, delays.length - 1)]!, signal);
  }
  throw new PromptClientError('NETWORK_ERROR');
}

export function promptErrorMessage(error: unknown): string {
  if (!(error instanceof PromptClientError))
    return 'Não foi possível concluir a ação. Tente novamente.';
  if (error.code === 'NETWORK_ERROR')
    return 'Não foi possível acessar o servidor. Verifique sua conexão.';
  if (error.code === 'INVALID_RESPONSE')
    return 'O servidor retornou uma resposta inválida e segura para exibição.';
  if (error.code === 'COST_CONSENT_REQUIRED')
    return 'Confirme o teto de cobrança antes de continuar.';
  if (error.code === 'INSUFFICIENT_CREDITS') return 'Créditos insuficientes para esta operação.';
  if (error.code === 'NOT_FOUND')
    return 'O recurso não foi encontrado ou não pertence à sua conta.';
  return 'Não foi possível concluir a ação. Revise os dados e tente novamente.';
}

export function stableIdempotencyKey(prefix: string): string {
  return `${prefix}:${crypto.randomUUID()}`;
}

export function usePromptApi(injected?: PromptApi): PromptApi {
  const { getAccessTokenSilently } = useAppAuth();
  return useMemo(
    () => injected ?? new PromptClient(getAccessTokenSilently),
    [getAccessTokenSilently, injected],
  );
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      window.clearTimeout(timer);
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const timer = window.setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
