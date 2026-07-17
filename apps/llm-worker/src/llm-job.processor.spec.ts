import { describe, expect, it, vi } from 'vitest';
import { PricingCatalog, ProviderFailure } from '@extractionstack/llm-core';
import { LlmJobProcessor } from './llm-job.processor';

function setup(overrides?: { attempts?: number; maxAttempts?: number }) {
  const claimed = {
    id: 'job-1',
    ownerId: 'owner-1',
    operation: 'GENERATE' as const,
    provider: 'OPENAI' as const,
    model: 'gpt-test',
    credentialMode: 'PLATFORM_CREDITS' as const,
    connectionId: null,
    projectId: 'project-1',
    sourcePromptVersionId: null,
    attempts: overrides?.attempts ?? 1,
    maxAttempts: overrides?.maxAttempts ?? 3,
    leaseToken: '2c271b1d-35fe-4509-8980-f78075cfb178',
  };
  const context = {
    job: claimed,
    wizard: {
      objective: 'Criar',
      audience: 'Time',
      technologies: [],
      requirements: [],
      exclusions: [],
      freeInstructions: '',
    },
    report: {},
    sourcePrompt: null,
    reservationId: 'reservation-1',
    maximumAcceptedAmountMinor: 10n,
  };
  const store = {
    claim: vi.fn().mockResolvedValue(claimed),
    loadAuthorizedContext: vi.fn().mockResolvedValue(context),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    heartbeat: vi.fn().mockResolvedValue(true),
    markProviderCompleted: vi.fn().mockResolvedValue(true),
    complete: vi.fn().mockResolvedValue(true),
    markRetry: vi.fn().mockResolvedValue(true),
    fail: vi.fn().mockResolvedValue(true),
    deadLetter: vi.fn().mockResolvedValue(true),
    markAmbiguous: vi.fn().mockResolvedValue(true),
    cancel: vi.fn().mockResolvedValue(true),
    reject: vi.fn().mockResolvedValue(true),
  };
  const provider = {
    getCapabilities: vi.fn().mockReturnValue({ maxOutputTokens: 1_000 }),
    generatePrompt: vi.fn().mockResolvedValue({
      content: 'Prompt universal de teste.',
      finishReason: 'complete',
      providerRequestId: 'req-1',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostMicros: null },
    }),
  };
  const pricing = new PricingCatalog('price-2026-07-17', [
    {
      provider: 'OPENAI',
      model: 'gpt-test',
      inputMicrosPerMillionTokens: '1000000',
      cachedInputMicrosPerMillionTokens: '500000',
      outputMicrosPerMillionTokens: '2000000',
      reasoningMicrosPerMillionTokens: '2000000',
      requireCachedTokens: false,
      requireReasoningTokens: false,
    },
  ]);
  const dependencies = {
    store,
    assembler: {
      assemble: vi
        .fn()
        .mockReturnValue({
          narrative: 'Relatorio seguro.',
          safetyReasonCodes: [],
          truncated: false,
        }),
    },
    safety: {
      inspect: vi.fn().mockReturnValue({ safeText: 'ok', reasonCodes: [], modified: false }),
    },
    composer: {
      compose: vi
        .fn()
        .mockReturnValue({
          system: 'policy',
          userTask: 'task',
          sourceData: 'source',
          destinationRules: 'rules',
          outputContract: 'contract',
        }),
    },
    credentials: {
      resolve: vi.fn().mockResolvedValue({ mode: 'PLATFORM_CREDITS', value: 'secret' }),
    },
    providers: { get: vi.fn().mockReturnValue(provider) },
    pricing,
  };
  return {
    processor: new LlmJobProcessor(dependencies as never),
    dependencies,
    store,
    provider,
    claimed,
    context,
  };
}

describe('LlmJobProcessor', () => {
  it('persists natural language with catalog price and version', async () => {
    const { processor, store } = setup();
    await processor.process('job-1', 1, 10);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        actualAmountMinor: 1n,
        pricingVersion: 'price-2026-07-17',
        result: expect.objectContaining({ content: 'Prompt universal de teste.' }),
      }),
    );
  });

  it('returns without side effects when atomic claim loses', async () => {
    const { processor, store, provider } = setup();
    store.claim.mockResolvedValue(null);
    await processor.process('job-1', 1, 10);
    expect(provider.generatePrompt).not.toHaveBeenCalled();
    expect(store.complete).not.toHaveBeenCalled();
  });

  it('uses the database attempt, not the transport attempt, for retry authority', async () => {
    const { processor, store, provider, claimed } = setup({ attempts: 2, maxAttempts: 2 });
    provider.generatePrompt.mockRejectedValue(new ProviderFailure('TIMEOUT', { retryable: true }));
    await processor.process('job-1', 1, 10);
    expect(store.deadLetter).toHaveBeenCalledWith(claimed, 'TIMEOUT');
    expect(store.markRetry).not.toHaveBeenCalled();
  });

  it('retries a transient pre-provider failure only after a fenced transition', async () => {
    const { processor, store, provider, claimed } = setup();
    provider.generatePrompt.mockRejectedValue(
      new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true }),
    );
    await expect(processor.process('job-1', 9, 10)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(store.markRetry).toHaveBeenCalledWith(claimed, 'PROVIDER_UNAVAILABLE');
  });

  it('marks missing pricing ambiguous and never persists a zero charge', async () => {
    const state = setup();
    state.dependencies.pricing = new PricingCatalog('price-v2', []);
    const processor = new LlmJobProcessor(state.dependencies as never);
    await processor.process('job-1', 1, 10);
    expect(state.store.markAmbiguous).toHaveBeenCalledWith(state.claimed, 'PRICING_NOT_CONFIGURED');
    expect(state.store.complete).not.toHaveBeenCalled();
  });

  it('never settles a platform reservation at zero', async () => {
    const state = setup();
    state.dependencies.pricing = new PricingCatalog('free-v1', [
      {
        provider: 'OPENAI',
        model: 'gpt-test',
        inputMicrosPerMillionTokens: '0',
        cachedInputMicrosPerMillionTokens: '0',
        outputMicrosPerMillionTokens: '0',
        reasoningMicrosPerMillionTokens: '0',
        requireCachedTokens: false,
        requireReasoningTokens: false,
      },
    ]);
    await new LlmJobProcessor(state.dependencies as never).process('job-1', 1, 10);
    expect(state.store.markAmbiguous).toHaveBeenCalledWith(
      state.claimed,
      'PRICING_USAGE_INSUFFICIENT',
    );
    expect(state.store.complete).not.toHaveBeenCalled();
  });

  it('fails before settlement when actual price exceeds accepted maximum', async () => {
    const state = setup();
    state.context.maximumAcceptedAmountMinor = 0n;
    await state.processor.process('job-1', 1, 10);
    expect(state.store.fail).toHaveBeenCalledWith(state.claimed, 'CREDIT_COST_LIMIT_EXCEEDED');
    expect(state.store.complete).not.toHaveBeenCalled();
  });

  it('marks post-provider persistence failure ambiguous without throwing for retry', async () => {
    const { processor, store, provider, claimed } = setup();
    store.complete.mockRejectedValue(new Error('db down'));
    await processor.process('job-1', 1, 10);
    expect(provider.generatePrompt).toHaveBeenCalledOnce();
    expect(store.markAmbiguous).toHaveBeenCalledWith(claimed, 'PERSISTENCE_FAILED');
    expect(store.markRetry).not.toHaveBeenCalled();
  });

  it('does not persist a late result after cancellation', async () => {
    const { processor, store, claimed } = setup();
    store.isCancellationRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await processor.process('job-1', 1, 10);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.cancel).toHaveBeenCalledWith(claimed);
  });

  it('aborts an in-flight provider request when the lease is lost', async () => {
    const { dependencies, store, provider, claimed } = setup();
    store.heartbeat.mockResolvedValue(false);
    provider.generatePrompt.mockImplementation(
      (input: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) =>
          input.signal?.addEventListener(
            'abort',
            () => reject(new ProviderFailure('REQUEST_CANCELLED')),
            { once: true },
          ),
        ),
    );
    const processor = new LlmJobProcessor({ ...dependencies, cancellationPollMs: 1 } as never);
    await processor.process('job-1', 1, 10);
    expect(store.cancel).toHaveBeenCalledWith(claimed);
    expect(store.complete).not.toHaveBeenCalled();
  });
});
