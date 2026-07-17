import type {
  PromptComposer,
  PromptSafetyService,
  ReportNarrativeAssembler,
} from '@extractionstack/llm-core';
import {
  ProviderFailure,
  type CredentialResolver,
  type GenerationInput,
  type PromptLayer,
} from '@extractionstack/llm-core';
import type {
  AuthorizedLlmContext,
  ClaimedLlmJob,
  LlmJobStorePort,
  ProviderAdapterRegistryPort,
  SecurityRecord,
  WorkerCreditsPort,
} from './llm-worker.types';

export type LlmJobProcessorDependencies = Readonly<{
  store: LlmJobStorePort;
  assembler: ReportNarrativeAssembler;
  safety: PromptSafetyService;
  composer: PromptComposer;
  credentials: CredentialResolver;
  providers: ProviderAdapterRegistryPort;
  credits: WorkerCreditsPort;
  now?: () => number;
  cancellationPollMs?: number;
}>;

export class LlmJobProcessor {
  private readonly now: () => number;

  constructor(private readonly dependencies: LlmJobProcessorDependencies) {
    this.now = dependencies.now ?? Date.now;
  }

  async process(jobId: string, attempt: number, maxAttempts: number): Promise<void> {
    assertDelivery(jobId, attempt, maxAttempts);
    const job = await this.dependencies.store.claim(jobId);
    if (!job) return;
    let context: AuthorizedLlmContext | null = null;

    try {
      context = await this.dependencies.store.loadAuthorizedContext(job);
      if (await this.dependencies.store.isCancellationRequested(job.id)) {
        await this.cancel(context, 'generation cancelled before provider request');
        return;
      }

      const brief = this.dependencies.assembler.assemble(context.report);
      const inspection = this.dependencies.safety.inspect(brief.narrative);
      const security: SecurityRecord = Object.freeze({
        action: inspection.modified || brief.safetyReasonCodes.length ? 'REDACT' : 'ALLOW',
        reasonCodes: Object.freeze([
          ...new Set([...brief.safetyReasonCodes, ...inspection.reasonCodes]),
        ]),
      });
      const composed = this.dependencies.composer.compose({ wizard: context.wizard, brief });
      const credential = await this.dependencies.credentials.resolve({
        ownerId: job.ownerId,
        provider: job.provider,
        mode: job.credentialMode,
        connectionId: job.connectionId,
      });
      const adapter = this.dependencies.providers.get(job.provider);
      const capabilities = adapter.getCapabilities();
      const abortController = new AbortController();
      const generation: GenerationInput = Object.freeze({
        provider: job.provider,
        model: job.model,
        credential,
        wizardInput: context.wizard,
        sourcePrompt: context.sourcePrompt,
        layers: layers(composed),
        maxOutputTokens: capabilities.maxOutputTokens,
        signal: abortController.signal,
      });

      const startedAt = this.now();
      const result = await this.invokeWithCancellation(job, abortController, () =>
        job.operation === 'PREVIEW'
          ? adapter.generatePreview({ generation, preview: previewInput(context!) })
          : adapter.generatePrompt(generation),
      );
      const latencyMs = Math.max(0, this.now() - startedAt);

      if (await this.dependencies.store.isCancellationRequested(job.id)) {
        await this.cancel(context, 'late provider result discarded after cancellation');
        return;
      }

      const completed = await this.dependencies.store.complete({
        job,
        result,
        security,
        latencyMs,
      });
      if (!completed) {
        await this.cancel(context, 'generation cancelled during persistence');
        return;
      }
      if (context.reservationId) {
        await this.dependencies.credits.confirm(
          context.reservationId,
          microsToMinor(result.usage.estimatedCostMicros),
        );
      }
    } catch (cause) {
      const failure = sanitizedFailure(cause);
      if (failure.code === 'REQUEST_CANCELLED' && context) {
        await this.cancel(context, 'provider request aborted after cancellation');
        return;
      }
      if (failure.retryable && attempt < Math.min(maxAttempts, job.maxAttempts)) {
        await this.dependencies.store.markRetry(job.id, failure.code);
        throw failure;
      }

      if (failure.retryable) await this.dependencies.store.deadLetter(job.id, failure.code);
      else await this.dependencies.store.fail(job.id, failure.code);
      if (context?.reservationId) {
        await this.dependencies.credits.reverse(
          context.reservationId,
          failure.retryable ? 'generation retries exhausted' : 'generation failed',
        );
      }
    }
  }

  private async invokeWithCancellation<T>(
    job: ClaimedLlmJob,
    controller: AbortController,
    invoke: () => Promise<T>,
  ): Promise<T> {
    let checking = false;
    const timer = setInterval(() => {
      if (checking || controller.signal.aborted) return;
      checking = true;
      void this.dependencies.store
        .isCancellationRequested(job.id)
        .then((cancelled) => {
          if (cancelled) controller.abort();
        })
        .finally(() => {
          checking = false;
        });
    }, this.dependencies.cancellationPollMs ?? 250);
    timer.unref?.();
    try {
      return await invoke();
    } finally {
      clearInterval(timer);
    }
  }

  private async cancel(context: AuthorizedLlmContext, reason: string): Promise<void> {
    await this.dependencies.store.cancel(context.job.id);
    if (context.reservationId)
      await this.dependencies.credits.reverse(context.reservationId, reason);
  }
}

function layers(composed: ReturnType<PromptComposer['compose']>): readonly PromptLayer[] {
  return Object.freeze([
    Object.freeze({ kind: 'platform-policy' as const, content: composed.system }),
    Object.freeze({ kind: 'task' as const, content: composed.userTask }),
    Object.freeze({ kind: 'source-context' as const, content: composed.sourceData }),
    Object.freeze({ kind: 'destination-rules' as const, content: composed.destinationRules }),
    Object.freeze({ kind: 'response-contract' as const, content: composed.outputContract }),
  ]);
}

function previewInput(context: AuthorizedLlmContext) {
  if (!context.sourcePrompt) throw new ProviderFailure('INPUT_INVALID');
  return {
    id: context.job.id,
    promptVersionId: context.sourcePrompt.id,
    status: 'QUEUED' as const,
    content: 'Prévia pendente.',
    summary: 'Prévia limitada do prompt selecionado.',
    provider: context.job.provider,
    model: context.job.model,
    finishReason: null,
    latencyMs: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
}

function sanitizedFailure(cause: unknown): ProviderFailure {
  if (cause instanceof ProviderFailure) return cause;
  if (cause instanceof Error && cause.message === 'CREDIT_COST_LIMIT_EXCEEDED') {
    return new ProviderFailure('INPUT_INVALID');
  }
  if (cause instanceof Error && cause.message === 'WORKER_SCOPE_INVALID') {
    return new ProviderFailure('AUTHORIZATION_FAILED');
  }
  return new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
}

function microsToMinor(value: number | null): bigint {
  if (value === null) return 0n;
  return BigInt(Math.ceil(value / 10_000));
}

function assertDelivery(jobId: string, attempt: number, maxAttempts: number): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/.test(jobId) ||
    !Number.isInteger(attempt) ||
    attempt < 1 ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    attempt > maxAttempts
  ) {
    throw new ProviderFailure('INPUT_INVALID');
  }
}
