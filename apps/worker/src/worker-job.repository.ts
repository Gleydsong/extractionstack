import { Inject, Injectable } from '@nestjs/common';
import { ExtractionReportSchema, type ExtractionReport } from '@extractionstack/shared';
import { PrismaClient, type Prisma } from '@prisma/client';
import type { ClaimedExtractionJob, WorkerJobStore } from './worker.types.js';

@Injectable()
export class WorkerJobRepository implements WorkerJobStore {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async claim(jobId: string): Promise<ClaimedExtractionJob | null> {
    await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'CANCEL_REQUESTED' },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
    const claimed = await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'QUEUED' },
      data: { status: 'RUNNING', startedAt: new Date(), attempts: { increment: 1 } },
    });
    if (claimed.count !== 1) return null;
    const job = await this.prisma.extractionJob.findUnique({
      where: { id: jobId },
      select: { id: true, requestedUrl: true, status: true },
    });
    return job?.status === 'RUNNING' ? { ...job, status: 'RUNNING' } : null;
  }

  async complete(jobId: string, rawReport: ExtractionReport): Promise<void> {
    const report = ExtractionReportSchema.parse(rawReport);
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.extractionJob.updateMany({
        where: { id: jobId, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          errorCode: null,
          errorMessage: null,
          finishedAt: new Date(),
        },
      });
      if (updated.count !== 1) return;
      await transaction.extractionReport.upsert({
        where: { jobId },
        create: {
          jobId,
          finalUrl: report.finalUrl,
          fetchedAt: new Date(report.fetchedAt),
          durationMs: report.durationMs,
          payload: report as Prisma.InputJsonValue,
        },
        update: {
          finalUrl: report.finalUrl,
          fetchedAt: new Date(report.fetchedAt),
          durationMs: report.durationMs,
          payload: report as Prisma.InputJsonValue,
        },
      });
    });
  }

  async retry(jobId: string, code: string, message: string): Promise<void> {
    await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'QUEUED', errorCode: code, errorMessage: message },
    });
  }

  async fail(jobId: string, code: string, message: string): Promise<void> {
    await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: 'RUNNING' },
      data: { status: 'FAILED', errorCode: code, errorMessage: message, finishedAt: new Date() },
    });
  }

  async cancel(jobId: string): Promise<void> {
    await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: { in: ['QUEUED', 'RUNNING', 'CANCEL_REQUESTED'] } },
      data: { status: 'CANCELLED', finishedAt: new Date() },
    });
  }
}
