import { describe, expect, it, vi } from 'vitest';
import type { ExtractionReport } from '@extractionstack/shared';
import { WorkerProcessor } from './worker.processor.js';
import type { WorkerJobStore, WorkerExtractor } from './worker.types.js';

const report: ExtractionReport = {
  url: 'https://example.com',
  finalUrl: 'https://example.com/',
  fetchedAt: '2026-07-15T12:00:00.000Z',
  durationMs: 100,
  sections: {},
};

function setup() {
  const store: WorkerJobStore = {
    claim: vi.fn().mockResolvedValue({
      id: 'cm1234567890abcdef',
      requestedUrl: 'https://example.com',
      status: 'RUNNING',
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    retry: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    cancel: vi.fn().mockResolvedValue(undefined),
  };
  const extractor: WorkerExtractor = { extract: vi.fn().mockResolvedValue(report) };
  return { processor: new WorkerProcessor(store, extractor), store, extractor };
}

describe('WorkerProcessor', () => {
  it('persists success only after validating the extraction report', async () => {
    const { processor, store } = setup();

    await processor.process('cm1234567890abcdef');

    expect(store.complete).toHaveBeenCalledWith('cm1234567890abcdef', report);
  });

  it('rejects and sanitizes an invalid extractor response', async () => {
    const { processor, store, extractor } = setup();
    vi.mocked(extractor.extract).mockResolvedValue({ status: 'MAGIC' } as never);

    await expect(processor.process('cm1234567890abcdef')).rejects.toThrow();
    expect(store.fail).toHaveBeenCalledWith(
      'cm1234567890abcdef',
      'INTERNAL',
      'extraction failed',
    );
  });

  it('does not leak an extractor exception into persisted state', async () => {
    const { processor, store, extractor } = setup();
    vi.mocked(extractor.extract).mockRejectedValue(
      new Error('password=secret at /Users/private/file.ts'),
    );

    await expect(processor.process('cm1234567890abcdef')).rejects.toThrow();
    expect(store.fail).toHaveBeenCalledWith(
      'cm1234567890abcdef',
      'INTERNAL',
      'extraction failed',
    );
  });

  it('requeues a sanitized non-final attempt', async () => {
    const { processor, store, extractor } = setup();
    vi.mocked(extractor.extract).mockRejectedValue(new Error('temporary secret'));

    await expect(processor.process('cm1234567890abcdef', 1, 3)).rejects.toThrow();
    expect(store.retry).toHaveBeenCalledWith(
      'cm1234567890abcdef',
      'INTERNAL',
      'extraction attempt failed',
    );
    expect(store.fail).not.toHaveBeenCalled();
  });

  it('does nothing when the database job cannot be claimed', async () => {
    const { processor, store, extractor } = setup();
    vi.mocked(store.claim).mockResolvedValue(null);

    await processor.process('cm1234567890abcdef');

    expect(extractor.extract).not.toHaveBeenCalled();
  });
});
