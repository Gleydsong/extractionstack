import type { ExtractionReport } from '@extractionstack/shared';

export const WORKER_JOB_STORE = Symbol('WORKER_JOB_STORE');
export const WORKER_EXTRACTOR = Symbol('WORKER_EXTRACTOR');

export interface ClaimedExtractionJob {
  id: string;
  requestedUrl: string;
  status: 'RUNNING';
}

export interface WorkerJobStore {
  claim(jobId: string): Promise<ClaimedExtractionJob | null>;
  complete(jobId: string, report: ExtractionReport): Promise<void>;
  retry(jobId: string, code: string, message: string): Promise<void>;
  fail(jobId: string, code: string, message: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

export interface WorkerExtractor {
  extract(request: { url: string }): Promise<ExtractionReport>;
}
