import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';

export const LLM_QUEUE_NAME = 'llm-generations-v1';
export const LLM_BULL_QUEUE = Symbol('LLM_BULL_QUEUE');

export interface LlmQueuePayload {
  jobId: string;
}

@Injectable()
export class BullMqPromptGenerationQueue implements OnModuleDestroy {
  constructor(
    @Inject(LLM_BULL_QUEUE)
    private readonly queue: Queue<LlmQueuePayload>,
  ) {}

  async enqueue(jobId: string): Promise<void> {
    if (await this.queue.getJob(jobId)) return;
    await this.queue.add(
      LLM_QUEUE_NAME,
      { jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'llm-bounded-jitter' },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: false,
      },
    );
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') await job.remove();
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
