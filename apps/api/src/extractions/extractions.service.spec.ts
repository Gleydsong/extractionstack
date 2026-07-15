import { ConflictException, NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import type { Auth0User } from '@extractionstack/shared';
import { ExtractionsService } from './extractions.service.js';
import type {
  ExtractionQueuePort,
  ExtractionsRepositoryPort,
  StoredExtractionJob,
} from './extractions.types.js';

const actor: Auth0User = {
  sub: 'auth0|user-1',
  email: 'user@example.com',
  roles: ['user'],
};

function storedJob(overrides: Partial<StoredExtractionJob> = {}): StoredExtractionJob {
  const now = new Date('2026-07-15T12:00:00.000Z');
  return {
    id: 'cm1234567890abcdef',
    requestedUrl: 'https://example.com',
    normalizedUrl: 'https://example.com/',
    status: 'QUEUED',
    attempts: 0,
    maxAttempts: 3,
    errorCode: null,
    errorMessage: null,
    queuedAt: now,
    startedAt: null,
    finishedAt: null,
    createdAt: now,
    updatedAt: now,
    report: null,
    ...overrides,
  };
}

function setup(createResult = { job: storedJob(), created: true }) {
  const repository: ExtractionsRepositoryPort = {
    createOrGet: vi.fn().mockResolvedValue(createResult),
    findOwned: vi.fn(),
    listOwned: vi.fn(),
    requestCancellation: vi.fn(),
    failQueueSubmission: vi.fn(),
  };
  const queue: ExtractionQueuePort = {
    enqueue: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  return { service: new ExtractionsService(repository, queue), repository, queue };
}

describe('ExtractionsService', () => {
  it('enqueues a newly persisted job exactly once', async () => {
    const { service, queue } = setup();

    const result = await service.create(
      actor,
      { url: 'https://example.com' },
      'extract-request:0001',
    );

    expect(result.status).toBe('QUEUED');
    expect(queue.enqueue).toHaveBeenCalledWith('cm1234567890abcdef');
  });

  it('returns an idempotent existing job without enqueueing it again', async () => {
    const existing = storedJob();
    const { service, queue } = setup({ job: existing, created: false });

    const result = await service.create(
      actor,
      { url: 'https://example.com' },
      'extract-request:0001',
    );

    expect(result.id).toBe(existing.id);
    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it('marks a job failed when durable queue submission fails', async () => {
    const { service, repository, queue } = setup();
    vi.mocked(queue.enqueue).mockRejectedValue(new Error('redis password=secret'));

    await expect(
      service.create(actor, { url: 'https://example.com' }, 'extract-request:0001'),
    ).rejects.toMatchObject({ status: 503 });
    expect(repository.failQueueSubmission).toHaveBeenCalledWith('cm1234567890abcdef');
  });

  it('does not reveal a job owned by another user', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findOwned).mockResolvedValue(null);

    await expect(service.get(actor, 'cm1234567890abcdef')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('rejects cancellation of a terminal job', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.requestCancellation).mockResolvedValue(null);

    await expect(service.cancel(actor, 'cm1234567890abcdef')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
