import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Queue } from 'bullmq';
import type { ExtractionQueuePort } from './extractions.types.js';

export const EXTRACTION_QUEUE_NAME = 'extractions-v1';
export const EXTRACTION_BULL_QUEUE = Symbol('EXTRACTION_BULL_QUEUE');

export interface ExtractionQueuePayload {
  jobId: string;
}

@Injectable()
export class BullMqExtractionQueue implements ExtractionQueuePort, OnModuleDestroy {
  constructor(
    @Inject(EXTRACTION_BULL_QUEUE)
    private readonly queue: Queue<ExtractionQueuePayload>,
  ) {}

  async enqueue(jobId: string): Promise<void> {
    await this.queue.add(
      EXTRACTION_QUEUE_NAME,
      { jobId },
      {
        jobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 86_400, count: 5_000 },
      },
    );
  }

  async cancel(jobId: string): Promise<void> {
    const job = await this.queue.getJob(jobId);
    if (!job) return;
    const state = await job.getState();
    if (state === 'waiting' || state === 'delayed') {
      await job.remove();
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
  }
}
