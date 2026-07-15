import { Inject, Injectable } from '@nestjs/common';
import { ExtractionReportSchema } from '@extractionstack/shared';
import {
  WORKER_EXTRACTOR,
  WORKER_JOB_STORE,
  type WorkerExtractor,
  type WorkerJobStore,
} from './worker.types.js';

@Injectable()
export class WorkerProcessor {
  constructor(
    @Inject(WORKER_JOB_STORE) private readonly store: WorkerJobStore,
    @Inject(WORKER_EXTRACTOR) private readonly extractor: WorkerExtractor,
  ) {}

  async process(jobId: string, attempt = 1, maxAttempts = 1): Promise<void> {
    const job = await this.store.claim(jobId);
    if (!job) return;

    try {
      const rawReport = await this.extractor.extract({ url: job.requestedUrl });
      const report = ExtractionReportSchema.parse(rawReport);
      await this.store.complete(job.id, report);
    } catch (cause) {
      if (attempt < maxAttempts) {
        await this.store.retry(job.id, 'INTERNAL', 'extraction attempt failed');
      } else {
        await this.store.fail(job.id, 'INTERNAL', 'extraction failed');
      }
      throw new Error('extraction failed', { cause });
    }
  }
}
