import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Job } from 'bullmq';
import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import { z } from 'zod';
import type { LlmJobProcessor } from './llm-job.processor';
import { LLM_QUEUE_NAME } from './llm-worker.types';
import type { LlmWorkerOperationsService } from './llm-worker-operations.service.js';

const PayloadSchema = z
  .object({ jobId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,190}$/) })
  .strict();
export type LlmQueuePayload = z.infer<typeof PayloadSchema>;

export type LlmQueueWorkerOptions = Readonly<{
  redisUrl: string;
  concurrency: number;
  random?: () => number;
}>;

export class LlmQueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LlmQueueWorkerService.name);
  private connection: IORedis | null = null;
  private worker: Worker<LlmQueuePayload> | null = null;

  constructor(
    private readonly processor: LlmJobProcessor,
    private readonly options: LlmQueueWorkerOptions,
    private readonly operations?: Pick<LlmWorkerOperationsService, 'recordQueueState'>,
  ) {}

  onModuleInit(): void {
    this.connection = new IORedis(this.options.redisUrl, { maxRetriesPerRequest: null });
    this.worker = new Worker<LlmQueuePayload>(
      LLM_QUEUE_NAME,
      async (transportJob: Job<LlmQueuePayload>) => {
        const payload = parseQueuePayload(transportJob.data);
        await this.processor.process(
          payload.jobId,
          transportJob.attemptsMade + 1,
          transportJob.opts.attempts ?? 1,
        );
      },
      {
        connection: this.connection,
        concurrency: this.options.concurrency,
        settings: {
          backoffStrategy: (attemptsMade, type) => {
            if (type !== 'llm-bounded-jitter') throw new Error('QUEUE_BACKOFF_INVALID');
            return boundedJitterBackoff(attemptsMade, (this.options.random ?? Math.random)());
          },
        },
      },
    );
    this.worker.on('completed', (job) => {
      this.logger.log(`llm job completed id=${job.id}`);
      void this.refreshQueueMetrics().catch(() => undefined);
    });
    this.worker.on('failed', (job, error) => {
      this.logger.warn(
        `llm job failed id=${job?.id ?? 'unknown'} errorType=${error.name || 'Error'}`,
      );
      void this.refreshQueueMetrics().catch(() => undefined);
    });
    this.worker.on('error', () => this.logger.error('llm queue worker error'));
  }

  async refreshQueueMetrics(): Promise<void> {
    if (!this.connection || !this.operations) return;
    const failed = await this.connection.zcard(`bull:${LLM_QUEUE_NAME}:failed`);
    this.operations.recordQueueState({ deadLetters: failed, reconciliationBacklog: 0 });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.worker) {
      await this.worker.pause();
      await this.worker.close();
      this.worker = null;
    }
    if (this.connection) {
      await this.connection.quit();
      this.connection = null;
    }
  }
}

export function parseQueuePayload(value: unknown): LlmQueuePayload {
  return PayloadSchema.parse(value);
}

export function boundedJitterBackoff(attemptsMade: number, random: number): number {
  const safeAttempt = Math.max(1, Math.min(10, Math.trunc(attemptsMade)));
  const boundedRandom = Number.isFinite(random) ? Math.max(0, Math.min(1, random)) : 0.5;
  const base = Math.min(30_000, 1_000 * 2 ** (safeAttempt - 1));
  return Math.min(30_000, Math.max(250, Math.round(base * (0.5 + boundedRandom * 0.5))));
}
