import { describe, expect, it, vi } from 'vitest';
import { ProviderFailure } from '@extractionstack/llm-core';
import { LlmJobProcessor } from './llm-job.processor';

function setup() {
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
    attempts: 1,
    maxAttempts: 3,
  };
  const context = {
    job: claimed,
    wizard: {},
    report: {},
    sourcePrompt: null,
    reservationId: 'reservation-1',
  } as never;
  const store = {
    claim: vi.fn().mockResolvedValue(claimed),
    loadAuthorizedContext: vi.fn().mockResolvedValue(context),
    isCancellationRequested: vi.fn().mockResolvedValue(false),
    complete: vi.fn().mockResolvedValue(true),
    markRetry: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    deadLetter: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
    reject: vi.fn().mockResolvedValue(undefined),
  };
  const provider = {
    getCapabilities: vi.fn().mockReturnValue({ maxOutputTokens: 1_000 }),
    generatePrompt: vi
      .fn()
      .mockResolvedValue({
        content: 'Prompt universal de teste.',
        finishReason: 'complete',
        providerRequestId: 'req-1',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostMicros: 2_000 },
      }),
  };
  const dependencies = {
    store,
    assembler: {
      assemble: vi
        .fn()
        .mockReturnValue({
          narrative: 'Relatório seguro.',
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
    credits: {
      confirm: vi.fn().mockResolvedValue(undefined),
      reverse: vi.fn().mockResolvedValue(undefined),
    },
  };
  return {
    processor: new LlmJobProcessor(dependencies as never),
    dependencies,
    store,
    provider,
    credits: dependencies.credits,
  };
}

describe('LlmJobProcessor', () => {
  it('persists natural language and confirms credits exactly once', async () => {
    const { processor, store, credits } = setup();
    await processor.process('job-1', 1, 3);
    expect(store.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        result: expect.objectContaining({ content: 'Prompt universal de teste.' }),
      }),
    );
    expect(credits.confirm).toHaveBeenCalledTimes(1);
  });

  it('returns without side effects when atomic claim loses', async () => {
    const { processor, store, provider, credits } = setup();
    store.claim.mockResolvedValue(null);
    await processor.process('job-1', 1, 3);
    expect(provider.generatePrompt).not.toHaveBeenCalled();
    expect(credits.confirm).not.toHaveBeenCalled();
  });

  it('retries transient provider failure without confirming credits', async () => {
    const { processor, store, provider, credits } = setup();
    provider.generatePrompt.mockRejectedValue(
      new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true }),
    );
    await expect(processor.process('job-1', 1, 3)).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(store.markRetry).toHaveBeenCalledWith('job-1', 'PROVIDER_UNAVAILABLE');
    expect(credits.confirm).not.toHaveBeenCalled();
  });

  it('does not persist a late result after cancellation and reverses once', async () => {
    const { processor, store, credits } = setup();
    store.isCancellationRequested.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await processor.process('job-1', 1, 3);
    expect(store.complete).not.toHaveBeenCalled();
    expect(store.cancel).toHaveBeenCalledTimes(1);
    expect(credits.reverse).toHaveBeenCalledTimes(1);
  });

  it('dead-letters exhausted transient failure and reverses reservation', async () => {
    const { processor, store, provider, credits } = setup();
    provider.generatePrompt.mockRejectedValue(new ProviderFailure('TIMEOUT', { retryable: true }));
    await processor.process('job-1', 3, 3);
    expect(store.deadLetter).toHaveBeenCalledWith('job-1', 'TIMEOUT');
    expect(credits.reverse).toHaveBeenCalledTimes(1);
  });

  it('treats a lost completion race as cancellation and never confirms', async () => {
    const { processor, store, credits } = setup();
    store.complete.mockResolvedValue(false);
    await processor.process('job-1', 1, 3);
    expect(store.cancel).toHaveBeenCalledOnce();
    expect(credits.confirm).not.toHaveBeenCalled();
    expect(credits.reverse).toHaveBeenCalledOnce();
  });

  it('aborts an in-flight provider request after cooperative cancellation polling', async () => {
    const { dependencies, store, provider, credits } = setup();
    store.isCancellationRequested.mockResolvedValueOnce(false).mockResolvedValue(true);
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
    await processor.process('job-1', 1, 3);
    expect(store.cancel).toHaveBeenCalledOnce();
    expect(credits.reverse).toHaveBeenCalledOnce();
    expect(store.fail).not.toHaveBeenCalled();
  });
});
