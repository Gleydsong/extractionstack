import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import { WorkerJobRepository } from './worker-job.repository.js';

const report = {
  url: 'https://example.com',
  finalUrl: 'https://example.com/',
  fetchedAt: '2026-07-15T12:00:00.000Z',
  durationMs: 10,
  sections: {},
};

function setup(updatedCount: number) {
  const transaction = {
    extractionJob: { updateMany: vi.fn().mockResolvedValue({ count: updatedCount }) },
    extractionReport: { upsert: vi.fn().mockResolvedValue({}) },
  };
  const prisma = {
    $transaction: vi.fn(async (callback: (client: typeof transaction) => Promise<void>) =>
      callback(transaction),
    ),
  } as unknown as PrismaClient;
  return { repository: new WorkerJobRepository(prisma), transaction };
}

describe('WorkerJobRepository.complete', () => {
  it('does not overwrite cancellation requested while extraction was running', async () => {
    const { repository, transaction } = setup(0);
    await repository.complete('cm1234567890abcdef', report);
    expect(transaction.extractionReport.upsert).not.toHaveBeenCalled();
  });

  it('persists a report only when RUNNING transitions to SUCCEEDED', async () => {
    const { repository, transaction } = setup(1);
    await repository.complete('cm1234567890abcdef', report);
    expect(transaction.extractionReport.upsert).toHaveBeenCalledOnce();
  });
});
