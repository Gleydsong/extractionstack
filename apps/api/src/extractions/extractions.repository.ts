import { Injectable } from '@nestjs/common';
import {
  ExtractionReportSchema,
  type Auth0User,
  type ExtractionListQuery,
} from '@extractionstack/shared';
import type { PrismaClient} from '@prisma/client';
import { Prisma, type ExtractionJob, type ExtractionReport } from '@prisma/client';
import type {
  CreateStoredExtraction,
  ExtractionsRepositoryPort,
  StoredExtractionJob,
} from './extractions.types.js';

type JobWithReport = ExtractionJob & { report: ExtractionReport | null };

@Injectable()
export class ExtractionsRepository implements ExtractionsRepositoryPort {
  constructor(private readonly prisma: PrismaClient) {}

  async createOrGet(
    input: CreateStoredExtraction,
  ): Promise<{ job: StoredExtractionJob; created: boolean }> {
    const owner = await this.upsertActor(input.actor);
    const key = {
      ownerId_idempotencyKey: {
        ownerId: owner.id,
        idempotencyKey: input.idempotencyKey,
      },
    };
    const existing = await this.prisma.extractionJob.findUnique({
      where: key,
      include: { report: true },
    });
    if (existing) return { job: mapJob(existing), created: false };

    try {
      const job = await this.prisma.$transaction(async (transaction) => {
        const created = await transaction.extractionJob.create({
          data: {
            ownerId: owner.id,
            requestedUrl: input.command.url,
            normalizedUrl: input.normalizedUrl,
            idempotencyKey: input.idempotencyKey,
          },
          include: { report: true },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: owner.id,
            action: 'extraction.created',
            entityType: 'ExtractionJob',
            entityId: created.id,
            metadata: { normalizedUrl: input.normalizedUrl },
          },
        });
        return created;
      });
      return { job: mapJob(job), created: true };
    } catch (error) {
      if (!isUniqueConstraintError(error)) throw error;
      const raced = await this.prisma.extractionJob.findUnique({
        where: key,
        include: { report: true },
      });
      if (!raced) throw error;
      return { job: mapJob(raced), created: false };
    }
  }

  async findOwned(actor: Auth0User, id: string): Promise<StoredExtractionJob | null> {
    const job = await this.prisma.extractionJob.findFirst({
      where: {
        id,
        ...(actor.roles.includes('admin') ? {} : { owner: { auth0Sub: actor.sub } }),
      },
      include: { report: true },
    });
    return job ? mapJob(job) : null;
  }

  async listOwned(
    actor: Auth0User,
    query: ExtractionListQuery,
  ): Promise<{ items: StoredExtractionJob[]; nextCursor: string | null }> {
    const jobs = await this.prisma.extractionJob.findMany({
      where: {
        ...(actor.roles.includes('admin') ? {} : { owner: { auth0Sub: actor.sub } }),
        ...(query.status ? { status: query.status } : {}),
      },
      include: { report: true },
      orderBy: { createdAt: query.sort === 'createdAt:asc' ? 'asc' : 'desc' },
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
      take: query.limit + 1,
    });
    const hasMore = jobs.length > query.limit;
    const items = hasMore ? jobs.slice(0, query.limit) : jobs;
    return {
      items: items.map(mapJob),
      nextCursor: hasMore ? (items.at(-1)?.id ?? null) : null,
    };
  }

  async requestCancellation(actor: Auth0User, id: string): Promise<StoredExtractionJob | null> {
    const ownerWhere = actor.roles.includes('admin')
      ? {}
      : { owner: { auth0Sub: actor.sub } };
    const candidate = await this.prisma.extractionJob.findFirst({
      where: { id, ...ownerWhere, status: { in: ['QUEUED', 'RUNNING'] } },
      select: { id: true },
    });
    if (!candidate) return null;
    await this.prisma.extractionJob.updateMany({
      where: { id: candidate.id, status: { in: ['QUEUED', 'RUNNING'] } },
      data: { status: 'CANCEL_REQUESTED' },
    });
    return this.findOwned(actor, id);
  }

  async failQueueSubmission(id: string): Promise<void> {
    await this.prisma.extractionJob.updateMany({
      where: { id, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        errorCode: 'QUEUE_UNAVAILABLE',
        errorMessage: 'extraction queue is unavailable',
        finishedAt: new Date(),
      },
    });
  }

  private upsertActor(actor: Auth0User) {
    return this.prisma.user.upsert({
      where: { auth0Sub: actor.sub },
      create: {
        auth0Sub: actor.sub,
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
      update: {
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
    });
  }
}

function mapJob(job: JobWithReport): StoredExtractionJob {
  return {
    id: job.id,
    requestedUrl: job.requestedUrl,
    normalizedUrl: job.normalizedUrl,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    errorCode: job.errorCode,
    errorMessage: job.errorMessage,
    queuedAt: job.queuedAt,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    report: job.report ? ExtractionReportSchema.parse(job.report.payload) : null,
  };
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
