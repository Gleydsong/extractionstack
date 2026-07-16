import { describe, expect, it, vi } from 'vitest';
import { BullMqExtractionQueue, EXTRACTION_QUEUE_NAME } from './extraction-queue.js';

describe('BullMqExtractionQueue', () => {
  it('uses a BullMQ-compatible versioned queue name', () => {
    expect(EXTRACTION_QUEUE_NAME).toMatch(/^[^:]+$/);
  });

  it('enqueues a deterministic durable job with bounded retries', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue = new BullMqExtractionQueue({ add, getJob: vi.fn(), close: vi.fn() } as never);

    await queue.enqueue('cm1234567890abcdef');

    expect(add).toHaveBeenCalledWith(
      EXTRACTION_QUEUE_NAME,
      { jobId: 'cm1234567890abcdef' },
      expect.objectContaining({
        jobId: 'cm1234567890abcdef',
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
      }),
    );
  });

  it('removes a waiting job when cancellation is requested', async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const getJob = vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue('waiting'), remove });
    const queue = new BullMqExtractionQueue({ add: vi.fn(), getJob, close: vi.fn() } as never);

    await queue.cancel('cm1234567890abcdef');

    expect(remove).toHaveBeenCalledOnce();
  });

  it('leaves an active job for cooperative database cancellation', async () => {
    const remove = vi.fn();
    const getJob = vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue('active'), remove });
    const queue = new BullMqExtractionQueue({ add: vi.fn(), getJob, close: vi.fn() } as never);

    await queue.cancel('cm1234567890abcdef');

    expect(remove).not.toHaveBeenCalled();
  });
});
