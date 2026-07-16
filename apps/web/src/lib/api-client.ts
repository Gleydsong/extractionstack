import {
  ErrorResponseSchema,
  ExtractionJobSchema,
  ExtractionListResponseSchema,
  type ExtractionJob,
  type ExtractionListQuery,
  type ExtractionListResponse,
} from '@extractionstack/shared';

interface RuntimeSchema<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class ClientError extends Error {
  constructor(
    public readonly code: 'HTTP_ERROR' | 'INVALID_RESPONSE' | 'NETWORK_ERROR',
    message: string,
  ) {
    super(message);
    this.name = 'ClientError';
  }
}

export class ExtractionApiClient {
  private readonly baseUrl: string;

  constructor(
    private readonly getAccessToken: () => Promise<string>,
    private readonly fetcher: typeof fetch = (input, init) => globalThis.fetch(input, init),
    baseUrl = (import.meta.env.VITE_API_BASE_URL as string | undefined) ?? '',
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
  }

  createJob(url: string, idempotencyKey: string): Promise<ExtractionJob> {
    return this.request('/api/extractions', ExtractionJobSchema, {
      method: 'POST',
      headers: { 'idempotency-key': idempotencyKey },
      body: JSON.stringify({ url }),
    });
  }

  getJob(id: string, signal?: AbortSignal): Promise<ExtractionJob> {
    return this.request(`/api/extractions/${encodeURIComponent(id)}`, ExtractionJobSchema, {
      signal,
    });
  }

  listJobs(query: Partial<ExtractionListQuery> = {}): Promise<ExtractionListResponse> {
    const params = new URLSearchParams();
    if (query.cursor) params.set('cursor', query.cursor);
    if (query.limit) params.set('limit', String(query.limit));
    if (query.status) params.set('status', query.status);
    if (query.sort) params.set('sort', query.sort);
    const suffix = params.size ? `?${params.toString()}` : '';
    return this.request(`/api/extractions${suffix}`, ExtractionListResponseSchema);
  }

  cancelJob(id: string): Promise<ExtractionJob> {
    return this.request(`/api/extractions/${encodeURIComponent(id)}/cancel`, ExtractionJobSchema, {
      method: 'POST',
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
      throw new ClientError('NETWORK_ERROR', 'network request failed');
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ClientError('INVALID_RESPONSE', 'API returned invalid JSON');
    }
    if (!response.ok) {
      const parsedError = ErrorResponseSchema.safeParse(body);
      throw new ClientError(
        'HTTP_ERROR',
        parsedError.success ? parsedError.data.message : `request failed (${response.status})`,
      );
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) {
      throw new ClientError('INVALID_RESPONSE', 'API response violated its contract');
    }
    return parsed.data;
  }
}
