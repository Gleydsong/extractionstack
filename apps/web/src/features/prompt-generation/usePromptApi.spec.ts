import { describe, expect, it, vi } from 'vitest';
import {
  PromptClient,
  PromptClientError,
  pollPromptJob,
  promptErrorMessage,
  type PromptApi,
} from './usePromptApi';

const now = '2026-07-17T12:00:00.000Z';
const queued = {
  id: 'cm1234567890jobid',
  projectId: 'cm1234567890project',
  operation: 'GENERATE',
  provider: 'OPENAI',
  model: 'model-test',
  credentialMode: 'API_KEY',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  sourcePromptVersionId: null,
  resultPromptVersionId: null,
  message: 'Aguardando.',
  queuedAt: now,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
} as const;

describe('PromptClient', () => {
  it('rejects successful responses with unknown raw provider data', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...queued, rawProviderPayload: { secret: true } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
    const client = new PromptClient(async () => 'token', fetcher);
    await expect(client.getJob(queued.id)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });

  it('maps public failures to natural messages without leaking server text', () => {
    expect(promptErrorMessage(new PromptClientError('NOT_FOUND'))).toMatch(
      /não foi encontrado|não pertence/i,
    );
    expect(promptErrorMessage(new Error('provider secret raw payload'))).not.toContain(
      'provider secret',
    );
  });

  it('requests owner-scoped version quotes and cursor pages through bounded URLs', async () => {
    const quote = {
      provider: 'OPENAI',
      model: 'model-test',
      sourceVersionId: 'cm1234567890version',
      operation: 'PREVIEW',
      reportSections: ['technologies', 'structure', 'evidence', 'limitations', 'confidence'],
      retentionNotice: 'Histórico retido no projeto.',
      maximumInputTokens: 2400,
      maximumOutputTokens: 1000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: now,
    } as const;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(quote), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ items: [], nextCursor: null }), { status: 200 }),
      );
    const client = new PromptClient(async () => 'token', fetcher);
    await expect(
      client.estimateVersionCost(quote.sourceVersionId, {
        provider: 'OPENAI',
        model: 'model-test',
        operation: 'PREVIEW',
      }),
    ).resolves.toEqual(quote);
    await client.listVersions('cm1234567890project', 'cm2234567890cursor');
    expect(fetcher.mock.calls[0]?.[0]).toContain(
      '/prompt-versions/cm1234567890version/cost-estimate',
    );
    expect(fetcher.mock.calls[1]?.[0]).toContain('?cursor=cm2234567890cursor');
  });
});

describe('pollPromptJob', () => {
  it('stops on a terminal job and publishes updates', async () => {
    const succeeded = {
      ...queued,
      status: 'SUCCEEDED' as const,
      message: 'Concluído.',
      resultPromptVersionId: 'cm1234567890version',
      finishedAt: now,
    };
    const api = { getJob: vi.fn().mockResolvedValue(succeeded) } as unknown as PromptApi;
    const update = vi.fn();
    await expect(
      pollPromptJob(api, queued.id, new AbortController().signal, update),
    ).resolves.toEqual(succeeded);
    expect(api.getJob).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith(succeeded);
  });

  it('cancels immediately when the owning view is unmounted', async () => {
    const controller = new AbortController();
    controller.abort();
    const api = { getJob: vi.fn() } as unknown as PromptApi;
    await expect(pollPromptJob(api, queued.id, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(api.getJob).not.toHaveBeenCalled();
  });
});
