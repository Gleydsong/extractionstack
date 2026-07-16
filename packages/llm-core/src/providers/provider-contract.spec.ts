import { describe, expect, it, vi } from 'vitest';
import type { GenerationInput, LlmProviderAdapter } from './provider-adapter';
import { FakeProviderAdapter } from './fake-provider.adapter';
import { GeminiProviderAdapter } from './gemini-provider.adapter';
import { OpenAiProviderAdapter } from './openai-provider.adapter';
import { ProviderFailure } from './provider-errors';

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
  createSuccess: () => new FakeProviderAdapter({ allowTestProvider: true }),
  createRateLimited: () =>
    new FakeProviderAdapter({
      allowTestProvider: true,
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
    }),
  createRateLimited: () =>
    new OpenAiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse({ error: 'secret body' }, 429)),
      baseUrl: new URL('https://openai.test/v1/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
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
    }),
  createRateLimited: () =>
    new GeminiProviderAdapter({
      fetch: vi.fn(async () => jsonResponse({ error: 'secret body' }, 429)),
      baseUrl: new URL('https://gemini.test/v1beta/'),
      timeoutMs: 100,
      maxOutputCharacters: 1_000,
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
          usage: {
            inputTokens: 7,
            outputTokens: 3,
            totalTokens: 99,
            estimatedCostMicros: 0,
          },
        }),
    ).toThrowError(expect.objectContaining({ code: 'INPUT_INVALID' }));
  });

  it('is deterministic and supports configured delay and usage', async () => {
    vi.useFakeTimers();
    try {
      const adapter = new FakeProviderAdapter({
        allowTestProvider: true,
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
  });

  it.each([
    ['API_KEY', 'x-goog-api-key'],
    ['OAUTH', 'authorization'],
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
        mode === 'OAUTH' ? 'Bearer test-secret' : 'test-secret',
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
