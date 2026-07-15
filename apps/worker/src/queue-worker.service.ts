import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { Worker, type Job } from 'bullmq';
import IORedis from 'ioredis';
import { loadRuntimeEnv } from '../../api/src/common/runtime-env.js';
import {
  EXTRACTION_QUEUE_NAME,
  type ExtractionQueuePayload,
} from '../../api/src/extractions/extraction-queue.js';
import type { WorkerProcessor } from './worker.processor.js';

@Injectable()
export class QueueWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(QueueWorkerService.name);
  private connection: IORedis | null = null;
  private worker: Worker<ExtractionQueuePayload> | null = null;

  constructor(private readonly processor: WorkerProcessor) {}

  onModuleInit(): void {
    const env = loadRuntimeEnv(process.env);
    this.connection = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
    this.worker = new Worker<ExtractionQueuePayload>(
      EXTRACTION_QUEUE_NAME,
      (job: Job<ExtractionQueuePayload>) =>
        this.processor.process(
          job.data.jobId,
          job.attemptsMade + 1,
          job.opts.attempts ?? 1,
        ),
      { connection: this.connection, concurrency: env.WORKER_CONCURRENCY },
    );
    this.worker.on('completed', (job) => this.logger.log(`job completed id=${job.id}`));
    this.worker.on('failed', (job) => this.logger.warn(`job failed id=${job?.id ?? 'unknown'}`));
    this.worker.on('error', () => this.logger.error('queue worker error'));
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
