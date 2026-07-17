import type { OnModuleDestroy } from '@nestjs/common';
import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { LLM_QUEUE_NAME } from './llm-worker.types';
import type { LlmQueuePayload } from './llm-queue-worker.service';
import type { LlmRecoveryQueuePort } from './llm-reconciliation-sweeper.service';

export class LlmRecoveryQueueService implements LlmRecoveryQueuePort, OnModuleDestroy {
  private readonly connection: IORedis;
  private readonly queue: Queue<LlmQueuePayload>;

  constructor(redisUrl: string) {
    this.connection = new IORedis(redisUrl, { maxRetriesPerRequest: null });
    this.queue = new Queue<LlmQueuePayload>(LLM_QUEUE_NAME, { connection: this.connection });
  }

  async enqueue(jobId: string): Promise<void> {
    const existing = await this.queue.getJob(jobId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed') {
        await existing.retry();
        return;
      }
      if (state === 'completed') {
        await existing.remove();
      } else {
        return;
      }
    }
    await this.queue.add(
      LLM_QUEUE_NAME,
      { jobId },
      {
        jobId,
        attempts: 10,
        backoff: { type: 'llm-bounded-jitter' },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: false,
      },
    );
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
