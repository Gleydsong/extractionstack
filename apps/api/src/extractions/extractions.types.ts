import type {
  Auth0User,
  CreateExtraction,
  ExtractionListQuery,
  ExtractionReport,
  ExtractionStatus,
} from '@extractionstack/shared';

export const EXTRACTIONS_REPOSITORY = Symbol('EXTRACTIONS_REPOSITORY');
export const EXTRACTION_QUEUE = Symbol('EXTRACTION_QUEUE');

export interface StoredExtractionJob {
  id: string;
  requestedUrl: string;
  normalizedUrl: string;
  status: ExtractionStatus;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  report: ExtractionReport | null;
}

export interface CreateStoredExtraction {
  actor: Auth0User;
  command: CreateExtraction;
  normalizedUrl: string;
  idempotencyKey: string;
}

export interface ExtractionsRepositoryPort {
  createOrGet(
    input: CreateStoredExtraction,
  ): Promise<{ job: StoredExtractionJob; created: boolean }>;
  findOwned(actor: Auth0User, id: string): Promise<StoredExtractionJob | null>;
  listOwned(
    actor: Auth0User,
    query: ExtractionListQuery,
  ): Promise<{ items: StoredExtractionJob[]; nextCursor: string | null }>;
  requestCancellation(actor: Auth0User, id: string): Promise<StoredExtractionJob | null>;
  failQueueSubmission(id: string): Promise<void>;
}

export interface ExtractionQueuePort {
  enqueue(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}
