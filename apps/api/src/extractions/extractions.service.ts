import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ExtractionJobSchema,
  ExtractionListResponseSchema,
  type Auth0User,
  type CreateExtraction,
  type ExtractionJob,
  type ExtractionListQuery,
  type ExtractionListResponse,
} from '@extractionstack/shared';
import {
  EXTRACTION_QUEUE,
  EXTRACTIONS_REPOSITORY,
  type ExtractionQueuePort,
  type ExtractionsRepositoryPort,
  type StoredExtractionJob,
} from './extractions.types.js';

@Injectable()
export class ExtractionsService {
  constructor(
    @Inject(EXTRACTIONS_REPOSITORY)
    private readonly repository: ExtractionsRepositoryPort,
    @Inject(EXTRACTION_QUEUE)
    private readonly queue: ExtractionQueuePort,
  ) {}

  async create(
    actor: Auth0User,
    command: CreateExtraction,
    idempotencyKey: string,
  ): Promise<ExtractionJob> {
    const normalizedUrl = new URL(command.url).toString();
    const result = await this.repository.createOrGet({
      actor,
      command,
      normalizedUrl,
      idempotencyKey,
    });

    if (result.created) {
      try {
        await this.queue.enqueue(result.job.id);
      } catch {
        await this.repository.failQueueSubmission(result.job.id);
        throw new ServiceUnavailableException({
          code: 'QUEUE_UNAVAILABLE',
          message: 'extraction queue is unavailable',
        });
      }
    }

    return toPublicJob(result.job);
  }

  async get(actor: Auth0User, id: string): Promise<ExtractionJob> {
    const job = await this.repository.findOwned(actor, id);
    if (!job) {
      throw new NotFoundException({ code: 'NOT_FOUND', message: 'extraction not found' });
    }
    return toPublicJob(job);
  }

  async list(actor: Auth0User, query: ExtractionListQuery): Promise<ExtractionListResponse> {
    const result = await this.repository.listOwned(actor, query);
    return ExtractionListResponseSchema.parse({
      items: result.items.map(toPublicJob),
      nextCursor: result.nextCursor,
    });
  }

  async cancel(actor: Auth0User, id: string): Promise<ExtractionJob> {
    const job = await this.repository.requestCancellation(actor, id);
    if (!job) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'extraction cannot be cancelled',
      });
    }
    await this.queue.cancel(job.id);
    return toPublicJob(job);
  }
}

function toPublicJob(job: StoredExtractionJob): ExtractionJob {
  return ExtractionJobSchema.parse({
    ...job,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    report: job.report ?? undefined,
  });
}
