import { describe, expect, it, vi } from 'vitest';
import type { ExtractionJob } from '@extractionstack/shared';
import { pollExtraction } from './poll-extraction';

const base: ExtractionJob = {
  id: 'cm1234567890abcdef',
  requestedUrl: 'https://example.com',
  normalizedUrl: 'https://example.com/',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  queuedAt: '2026-07-15T12:00:00.000Z',
  createdAt: '2026-07-15T12:00:00.000Z',
  updatedAt: '2026-07-15T12:00:00.000Z',
};

describe('pollExtraction', () => {
  it('stops after the first terminal state', async () => {
    const getJob = vi
      .fn()
      .mockResolvedValueOnce({ ...base, status: 'RUNNING' })
      .mockResolvedValueOnce({ ...base, status: 'SUCCEEDED' });
    const updates: string[] = [];

    const result = await pollExtraction(
      getJob,
      base.id,
      (job) => updates.push(job.status),
      new AbortController().signal,
      async () => undefined,
    );

    expect(result.status).toBe('SUCCEEDED');
    expect(updates).toEqual(['RUNNING', 'SUCCEEDED']);
    expect(getJob).toHaveBeenCalledTimes(2);
  });

  it('aborts without making another request', async () => {
    const controller = new AbortController();
    const getJob = vi.fn().mockImplementation(async () => {
      controller.abort();
      return base;
    });

    await expect(
      pollExtraction(getJob, base.id, vi.fn(), controller.signal, async () => undefined),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getJob).toHaveBeenCalledTimes(1);
  });
});
