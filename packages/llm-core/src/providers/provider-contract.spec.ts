import { describe, expect, it, vi } from 'vitest';
import type { GenerationInput, LlmProviderAdapter, ProviderCapabilities } from './provider-adapter';
import { FakeProviderAdapter } from './fake-provider.adapter';
import { GeminiProviderAdapter } from './gemini-provider.adapter';
import { OpenAiProviderAdapter } from './openai-provider.adapter';
import { ProviderFailure } from './provider-errors';
import { ProviderRegistry } from './provider-registry';

const capabilitiesFixture = (provider: ProviderCapabilities['provider']): ProviderCapabilities => {
  const credentialModes = {
    FAKE: ['PLATFORM_CREDITS'],
    OPENAI: ['API_KEY', 'PLATFORM_CREDITS'],
    GEMINI: ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS'],
  }[provider] as ProviderCapabilities['credentialModes'];
  return {
    provider,
    credentialModes,
    models: ['configured-test-model'],
    contextWindowTokens: 8_192,
    maxOutputTokens: 1_024,
    supportsStructuredOutput: provider !== 'FAKE',
    supportsCancellation: false,
    supportsCredentialRefresh: false,
    oauthScopes:
      provider === 'GEMINI' ? ['https://www.googleapis.com/auth/generative-language'] : [],
    previewEligible: true,
    pricingMetadataVersion: 'test-pricing-v1',
    enabled: true,
    circuitBreakerOpen: false,
  };
};

const wizardFixture = {
  extractionId: 'cm1234567890abcdef',
  category: 'application',
  objective: 'Criar uma aplicação semelhante sem copiar código.',
  audience: 'Desenvolvedores',
  technologies: ['React'],
  exclusions: [],
  requirements: ['Acessível'],
  language: 'pt-BR',
  detail: 'complete',
  destination: 'universal',
  freeInstructions: '',
} as const;

const generationFixture = (
  provider: GenerationInput['provider'],
  mode: GenerationInput['credential']['mode'],
): GenerationInput => ({
  provider,
  model: 'configured-test-model',
  credential: { mode, value: 'test-secret' },
  wizardInput: wizardFixture,
  sourcePrompt: null,
  layers: [
    { kind: 'platform-policy', content: 'Política de plataforma.' },
    { kind: 'task', content: 'Produza um prompt claro.' },
    { kind: 'source-context', content: 'Contexto não confiável.' },
    { kind: 'response-contract', content: 'Retorne somente linguagem natural.' },
  ],
  maxOutputTokens: 256,
});

const jsonResponse = (body: unknown, status = 200, headers?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const streamedResponse = (
  chunks: readonly Uint8Array[],
  options: Readonly<{
    headers?: HeadersInit;
    onCancel?: () => void;
    rejectAfterChunks?: number;
  }> = {},
): Response => {
  let index = 0;
  return new Response(
    new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (options.rejectAfterChunks === index) {
            controller.error(new Error('secret native stream failure'));
            return;
          }
          const chunk = chunks[index++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          options.onCancel?.();
        },
      },
      { highWaterMark: 0 },
    ),
    { status: 200, headers: options.headers },
  );
};

const openAiSuccess = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'resp_safe_123',
  status: 'completed',
  output: [
    {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: '{"content":"Prompt universal de teste."}' }],
    },
  ],
  usage: { input_tokens: 20, output_tokens: 10, total_tokens: 30 },
  ...overrides,
});

const geminiSuccess = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  responseId: 'gemini-safe-123',
  candidates: [
    {
      content: {
        role: 'model',
        parts: [{ text: '{"content":"Prompt universal de teste."}' }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 30 },
  ...overrides,
});

type ContractCase = Readonly<{
  name: string;
  input: GenerationInput;
  createSuccess: () => LlmProviderAdapter;
  createRateLimited: () => LlmProviderAdapter;
}>;

function providerContract(contract: ContractCase): void {
  describe(`${contract.name} common adapter contract`, () => {
    it('does not advertise cancellation without a cancel implementation', () => {
      const adapter = contract.createSuccess();

      expect(adapter.getCapabilities().supportsCancellation).toBe(false);
      expect(adapter.cancel).toBeUndefined();
    });

    it('returns bounded natural-language content and normalized usage', async () => {
      const result = await contract.createSuccess().generatePrompt(contract.input);

      expect(result.content).toBe('Prompt universal de teste.');
      expect(result.usage.totalTokens).toBe(result.usage.inputTokens + result.usage.outputTokens);
      expect(JSON.stringify(result)).not.toContain('test-secret');
    });

    it('classifies 429 as transient without leaking the response body', async () => {
      const promise = contract.createRateLimited().generatePrompt(contract.input);

      await expect(promise).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
      await expect(promise).rejects.not.toHaveProperty(
        'message',
        expect.stringContaining('secret'),
      );
    });
  });
}

providerContract({
  name: 'fake',
  input: generationFixture('FAKE', 'PLATFORM_CREDITS'),
  createSuccess: () =>
    new FakeProviderAdapter({
      allowTestProvider: true,
      capabilities: capabilitiesFixture('FAKE'),
    }),
  createRateLimited: () =>
    new FakeProviderAdapter({
      allowTestProvider: true,
      capabilities: capabilitiesFixture('FAKE'),
      failure: new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true }),
    }),
});

providerContract({
  name: 'OpenAI',
  input: generationFixture('OPENAI', 'API_KEY'),
  createSuccess: () =>
    new OpenAiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse(openAiSuccess())),
      baseUrl: new URL('https://openai.test/v1/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
      capabilities: capabilitiesFixture('OPENAI'),
    }),
  createRateLimited: () =>
    new OpenAiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse({ error: 'secret body' }, 429)),
      baseUrl: new URL('https://openai.test/v1/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
      capabilities: capabilitiesFixture('OPENAI'),
    }),
});

providerContract({
  name: 'Gemini',
  input: generationFixture('GEMINI', 'API_KEY'),
  createSuccess: () =>
    new GeminiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse(geminiSuccess())),
      baseUrl: new URL('https://gemini.test/v1beta/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
      capabilities: capabilitiesFixture('GEMINI'),
    }),
  createRateLimited: () =>
    new GeminiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse({ error: 'secret body' }, 429)),
      baseUrl: new URL('https://gemini.test/v1beta/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
      capabilities: capabilitiesFixture('GEMINI'),
    }),
});

describe('FakeProviderAdapter', () => {
  it('requires explicit test-provider policy opt-in', () => {
    expect(() => new FakeProviderAdapter()).toThrowError(
      expect.objectContaining({ code: 'INPUT_INVALID' }),
    );
  });

  it('rejects inconsistent configured usage', () => {
    expect(
      () =>
        new FakeProviderAdapter({
          allowTestProvider: true,
          capabilities: capabilitiesFixture('FAKE'),
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 99,
            estimatedCostMicros: 0,
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'INPUT_INVALID' }));
  });

  it('returns frozen configured capabilities compatible with ProviderRegistry', () => {
    const configured = capabilitiesFixture('FAKE');
    const adapter = new FakeProviderAdapter({
      allowTestProvider: true,
      capabilities: configured,
    });

    expect(adapter.getCapabilities()).toEqual(configured);
    expect(Object.isFrozen(adapter.getCapabilities())).toBe(true);
    expect(
      () => new ProviderRegistry([adapter.getCapabilities()], { allowTestProvider: true }),
    ).not.toThrow();
  });

  it('is deterministic and supports configured delay and usage', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeProviderAdapter({
        allowTestProvider: true,
        capabilities: capabilitiesFixture('FAKE'),
        delayMs: 25,
        content: 'Resposta determinística.',
        usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, estimatedCostMicros: 0 },
      });
      const promise = adapter.generatePrompt(generationFixture('FAKE', 'PLATFORM_CREDITS'));

      await vi.advanceTimersByTimeAsync(25);
      await expect(promise).resolves.toMatchObject({
        content: 'Resposta determinística.',
        providerRequestId: 'fake-request-1',
        usage: { totalTokens: 10 },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OpenAiProviderAdapter', () => {
  const input = generationFixture('OPENAI', 'API_KEY');
  const dependencies = (fetch: typeof globalThis.fetch, maxOutputCharacters = 1_000) => ({
    fetch,
    baseUrl: new URL('https://openai.test/v1/'),
    timeoutMs: 20,
    maxOutputCharacters,
    capabilities: capabilitiesFixture('OPENAI'),
  });

  it('uses the Responses API with bearer auth, separated roles, no tools and bounded output', async () => {
    const fetch = vi.fn(async () => jsonResponse(openAiSuccess()));
    const adapter = new OpenAiProviderAdapter(dependencies(fetch));

    await adapter.generatePrompt(input);

    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe('https://openai.test/v1/responses');
    expect(String(url)).not.toContain('test-secret');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret');
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: 'configured-test-model',
      max_output_tokens: 256,
      tools: [],
      tool_choice: 'none',
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'generated_prompt',
          strict: true,
        },
      },
    });
    expect(body.input).toEqual([
      { role: 'system', content: 'Política de plataforma.' },
      {
        role: 'user',
        content:
          '[task]\nProduza um prompt claro.\n\n[source-context]\nContexto não confiável.\n\n[response-contract]\nRetorne somente linguagem natural.',
      },
    ]);
  });

  it('uses bearer auth for platform credentials without query secrets', async () => {
    const fetch = vi.fn(async () => jsonResponse(openAiSuccess()));
    const adapter = new OpenAiProviderAdapter(dependencies(fetch));

    await adapter.generatePrompt(generationFixture('OPENAI', 'PLATFORM_CREDITS'));

    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).not.toContain('test-secret');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-secret');
  });

  it('returns exact frozen capabilities compatible with ProviderRegistry', () => {
    const configured = capabilitiesFixture('OPENAI');
    const adapter = new OpenAiProviderAdapter({
      ...dependencies(vi.fn()),
      capabilities: configured,
    });

    expect(adapter.getCapabilities()).toEqual(configured);
    expect(Object.isFrozen(adapter.getCapabilities())).toBe(true);
    expect(() => new ProviderRegistry([adapter.getCapabilities()])).not.toThrow();
  });

  it.each([
    [{ ...capabilitiesFixture('OPENAI'), provider: 'GEMINI' }, 'provider mismatch'],
    [
      { ...capabilitiesFixture('OPENAI'), credentialModes: ['API_KEY'] },
      'credential mode mismatch',
    ],
    [
      { ...capabilitiesFixture('OPENAI'), supportsCredentialRefresh: true },
      'unimplemented refresh',
    ],
    [
      { ...capabilitiesFixture('OPENAI'), supportsCancellation: true },
      'unimplemented cancellation',
    ],
  ] as const)('rejects invalid capabilities: %s', (capabilities) => {
    expect(
      () =>
        new OpenAiProviderAdapter({
          ...dependencies(vi.fn()),
          capabilities: capabilities as ProviderCapabilities,
        }),
    ).toThrowError(expect.objectContaining({ code: 'INPUT_INVALID' }));
  });

  it('preserves a base URL path without requiring a trailing slash', async () => {
    const fetch = vi.fn(async () => jsonResponse(openAiSuccess()));
    const adapter = new OpenAiProviderAdapter({
      ...dependencies(fetch),
      baseUrl: new URL('https://openai.test/v1'),
    });

    await adapter.generatePrompt(input);

    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://openai.test/v1/responses');
  });

  it('normalizes the safe request ID header instead of exposing a response object ID', async () => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse(openAiSuccess(), 200, { 'x-request-id': 'req_header_safe' }),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).resolves.toMatchObject({
      providerRequestId: 'req_header_safe',
    });
  });

  it('discards an unsafe request ID header', async () => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse(openAiSuccess({ id: 'unsafe response id' }), 200, {
            'x-request-id': 'unsafe request id',
          }),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).resolves.toMatchObject({
      providerRequestId: null,
    });
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED', false],
    [403, 'AUTHORIZATION_FAILED', false],
    [404, 'MODEL_UNAVAILABLE', false],
    [500, 'PROVIDER_UNAVAILABLE', true],
  ] as const)('classifies HTTP %s', async (status, code, retryable) => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(vi.fn(async () => jsonResponse({ error: 'secret response' }, status))),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({ code, retryable });
  });

  it('classifies HTTP 408 as a retryable timeout with safe request ID', async () => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse({ error: 'secret timeout body' }, 408, { 'x-request-id': 'req_408' }),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
      providerRequestId: 'req_408',
      message: 'TIMEOUT',
    });
  });

  it('classifies a pre-header network rejection as transient without leaking details', async () => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(vi.fn(async () => Promise.reject(new Error('secret network detail')))),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      message: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('classifies response-body stream rejection as transient and preserves safe request ID', async () => {
    const encoded = new TextEncoder().encode(JSON.stringify(openAiSuccess()));
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          streamedResponse([encoded.subarray(0, 20)], {
            headers: { 'x-request-id': 'req_stream_failure' },
            rejectAfterChunks: 1,
          }),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
      providerRequestId: 'req_stream_failure',
      message: 'PROVIDER_UNAVAILABLE',
    });
  });

  it('accepts a multi-chunk response exactly at the byte ceiling', async () => {
    const raw = JSON.stringify(openAiSuccess()).padEnd(4_096, ' ');
    const encoded = new TextEncoder().encode(raw);
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () => streamedResponse([encoded.subarray(0, 2_000), encoded.subarray(2_000)])),
      ),
    );

    await expect(adapter.generatePrompt(input)).resolves.toMatchObject({
      content: 'Prompt universal de teste.',
    });
  });

  it('cancels and rejects a multi-chunk body as soon as it exceeds the byte ceiling', async () => {
    const cancel = vi.fn();
    const encoded = new TextEncoder().encode('x'.repeat(4_097));
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          streamedResponse([encoded.subarray(0, 4_000), encoded.subarray(4_000)], {
            onCancel: cancel,
          }),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['malformed JSON', new Response('{broken', { status: 200 }), 'INVALID_RESPONSE'],
    ['missing text', jsonResponse(openAiSuccess({ output: [] })), 'INVALID_RESPONSE'],
    [
      'oversized text',
      jsonResponse(
        openAiSuccess({
          output: [
            {
              type: 'message',
              role: 'assistant',
              content: [{ type: 'output_text', text: '{"content":"too long"}' }],
            },
          ],
        }),
      ),
      'INVALID_RESPONSE',
    ],
  ] as const)('classifies %s', async (_name, response, code) => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () => response),
        _name === 'oversized text' ? 4 : 1_000,
      ),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({ code, retryable: false });
  });

  it.each([
    ['max_output_tokens', 'length'],
    ['content_filter', 'blocked'],
  ] as const)('normalizes incomplete reason %s', async (reason, finishReason) => {
    const response = openAiSuccess({
      status: 'incomplete',
      incomplete_details: { reason },
    });
    const adapter = new OpenAiProviderAdapter(
      dependencies(vi.fn(async () => jsonResponse(response))),
    );

    await expect(adapter.generatePrompt(input)).resolves.toMatchObject({ finishReason });
  });

  it('rejects an unknown incomplete reason instead of guessing a finish classification', async () => {
    const adapter = new OpenAiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse(
            openAiSuccess({ status: 'incomplete', incomplete_details: { reason: 'unknown' } }),
          ),
        ),
      ),
    );

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('classifies timeout and aborts the injected fetch', async () => {
    const fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('secret timeout detail', 'AbortError')),
          );
        }),
    );
    const adapter = new OpenAiProviderAdapter(dependencies(fetch));

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
      message: 'TIMEOUT',
    });
  });

  it('classifies an external cooperative abort as cancellation, not timeout', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('secret cancellation detail', 'AbortError')),
          );
        }),
    );
    const adapter = new OpenAiProviderAdapter(dependencies(fetch));
    const result = adapter.generatePrompt({ ...input, signal: controller.signal });
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: 'REQUEST_CANCELLED',
      retryable: false,
      message: 'REQUEST_CANCELLED',
    });
  });

  it('keeps the timeout active while reading the response body', async () => {
    const hangingResponse = {
      ok: true,
      status: 200,
      headers: new Headers(),
      text: () => new Promise<string>(() => undefined),
    } as Response;
    const adapter = new OpenAiProviderAdapter(dependencies(vi.fn(async () => hangingResponse)));

    await expect(adapter.generatePrompt(input)).rejects.toMatchObject({
      code: 'TIMEOUT',
      retryable: true,
    });
  }, 200);
});

describe('GeminiProviderAdapter', () => {
  const dependencies = (fetch: typeof globalThis.fetch, maxOutputCharacters = 1_000) => ({
    fetch,
    baseUrl: new URL('https://gemini.test/v1beta/'),
    timeoutMs: 20,
    maxOutputCharacters,
    capabilities: capabilitiesFixture('GEMINI'),
  });

  it.each([
    ['API_KEY', 'x-goog-api-key'],
    ['OAUTH', 'authorization'],
    ['PLATFORM_CREDITS', 'authorization'],
  ] as const)(
    'uses header auth for %s and never puts credentials in the URL',
    async (mode, header) => {
      const fetch = vi.fn(async () => jsonResponse(geminiSuccess()));
      const adapter = new GeminiProviderAdapter(dependencies(fetch));

      await adapter.generatePrompt(generationFixture('GEMINI', mode));

      const [url, init] = fetch.mock.calls[0] ?? [];
      expect(String(url)).toBe(
        'https://gemini.test/v1beta/models/configured-test-model:generateContent',
      );
      expect(String(url)).not.toContain('test-secret');
      expect(new Headers(init?.headers).get(header)).toBe(
        mode === 'API_KEY' ? 'test-secret' : 'Bearer test-secret',
      );
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(body).toMatchObject({
        systemInstruction: { parts: [{ text: 'Política de plataforma.' }] },
        generationConfig: {
          maxOutputTokens: 256,
          candidateCount: 1,
          responseMimeType: 'application/json',
          responseSchema: {
            type: 'OBJECT',
            required: ['content'],
          },
        },
      });
      expect(body).not.toHaveProperty('tools');
    },
  );

  it('returns exact frozen capabilities compatible with ProviderRegistry', () => {
    const configured = capabilitiesFixture('GEMINI');
    const adapter = new GeminiProviderAdapter({
      ...dependencies(vi.fn()),
      capabilities: configured,
    });

    expect(adapter.getCapabilities()).toEqual(configured);
    expect(Object.isFrozen(adapter.getCapabilities())).toBe(true);
    expect(() => new ProviderRegistry([adapter.getCapabilities()])).not.toThrow();
  });

  it('preserves the v1beta base path without requiring a trailing slash', async () => {
    const fetch = vi.fn(async () => jsonResponse(geminiSuccess()));
    const adapter = new GeminiProviderAdapter({
      ...dependencies(fetch),
      baseUrl: new URL('https://gemini.test/v1beta'),
    });

    await adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY'));

    expect(String(fetch.mock.calls[0]?.[0])).toBe(
      'https://gemini.test/v1beta/models/configured-test-model:generateContent',
    );
  });

  it.each([
    [401, 'AUTHENTICATION_FAILED', false],
    [403, 'AUTHORIZATION_FAILED', false],
    [404, 'MODEL_UNAVAILABLE', false],
    [500, 'PROVIDER_UNAVAILABLE', true],
  ] as const)('classifies HTTP %s', async (status, code, retryable) => {
    const adapter = new GeminiProviderAdapter(
      dependencies(vi.fn(async () => jsonResponse({ error: 'secret response' }, status))),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({ code, retryable });
  });

  it.each([
    ['malformed JSON', new Response('{broken', { status: 200 }), 1_000],
    ['missing text', jsonResponse(geminiSuccess({ candidates: [] })), 1_000],
    [
      'oversized text',
      jsonResponse(
        geminiSuccess({
          candidates: [
            {
              content: { parts: [{ text: '{"content":"too long"}' }] },
              finishReason: 'STOP',
            },
          ],
        }),
      ),
      4,
    ],
  ] as const)('classifies %s as an invalid response', async (_name, response, maxCharacters) => {
    const adapter = new GeminiProviderAdapter(
      dependencies(
        vi.fn(async () => response),
        maxCharacters,
      ),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it.each([
    ['MAX_TOKENS', 'length'],
    ['SAFETY', 'blocked'],
    ['RECITATION', 'blocked'],
  ] as const)('normalizes finish reason %s', async (providerReason, finishReason) => {
    const response = geminiSuccess({
      candidates: [
        {
          content: {
            parts: [{ text: '{"content":"Prompt universal de teste."}' }],
          },
          finishReason: providerReason,
        },
      ],
    });
    const adapter = new GeminiProviderAdapter(
      dependencies(vi.fn(async () => jsonResponse(response))),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).resolves.toMatchObject({ finishReason });
  });

  it('rejects an unknown finish reason instead of treating it as complete', async () => {
    const adapter = new GeminiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse(
            geminiSuccess({
              candidates: [
                {
                  content: {
                    parts: [{ text: '{"content":"Prompt universal de teste."}' }],
                  },
                  finishReason: 'OTHER',
                },
              ],
            }),
          ),
        ),
      ),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('classifies prompt blocking without text as a blocked invalid response', async () => {
    const adapter = new GeminiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse({
            promptFeedback: { blockReason: 'SAFETY' },
            usageMetadata: {
              promptTokenCount: 20,
              candidatesTokenCount: 0,
              totalTokenCount: 20,
            },
          }),
        ),
      ),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE', retryable: false });
  });

  it('accounts for Gemini thinking tokens using the provider total', async () => {
    const adapter = new GeminiProviderAdapter(
      dependencies(
        vi.fn(async () =>
          jsonResponse(
            geminiSuccess({
              usageMetadata: {
                promptTokenCount: 20,
                candidatesTokenCount: 10,
                thoughtsTokenCount: 5,
                totalTokenCount: 35,
              },
            }),
          ),
        ),
      ),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).resolves.toMatchObject({
      usage: { inputTokens: 20, outputTokens: 15, totalTokens: 35 },
    });
  });

  it.each([
    { promptTokenCount: 20, candidatesTokenCount: 10, totalTokenCount: 25 },
    {
      promptTokenCount: 20,
      candidatesTokenCount: 10,
      thoughtsTokenCount: 6,
      totalTokenCount: 35,
    },
    { promptTokenCount: 20, candidatesTokenCount: 10 },
  ])('rejects malformed Gemini usage totals safely: %o', async (usageMetadata) => {
    const adapter = new GeminiProviderAdapter(
      dependencies(vi.fn(async () => jsonResponse(geminiSuccess({ usageMetadata })))),
    );

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      retryable: false,
      message: 'INVALID_RESPONSE',
    });
  });

  it('classifies timeout without leaking native abort details', async () => {
    const fetch = vi.fn(
      (_url: URL | RequestInfo, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('secret timeout detail', 'AbortError')),
          );
        }),
    );
    const adapter = new GeminiProviderAdapter(dependencies(fetch));

    await expect(
      adapter.generatePrompt(generationFixture('GEMINI', 'API_KEY')),
    ).rejects.toMatchObject({ code: 'TIMEOUT', retryable: true, message: 'TIMEOUT' });
  });
});
