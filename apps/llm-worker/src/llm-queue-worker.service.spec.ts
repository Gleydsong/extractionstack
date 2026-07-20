import { describe, expect, it, vi } from 'vitest';
import {
  boundedJitterBackoff,
  LlmQueueWorkerService,
  parseQueuePayload,
} from './llm-queue-worker.service';

describe('LLM queue worker boundaries', () => {
  it('accepts payload exactly { jobId }', () => {
    expect(parseQueuePayload({ jobId: 'job-1' })).toEqual({ jobId: 'job-1' });
    expect(() => parseQueuePayload({ jobId: 'job-1', secret: 'no' })).toThrow();
  });

  it('uses bounded exponential jitter', () => {
    expect(boundedJitterBackoff(1, 0)).toBe(500);
    expect(boundedJitterBackoff(1, 1)).toBe(1_000);
    expect(boundedJitterBackoff(8, 1)).toBeLessThanOrEqual(30_000);
  });

  it('records bounded queue state during lifecycle refresh', async () => {
    const operations = { recordQueueState: vi.fn() };
    const service = new LlmQueueWorkerService(
      {} as never,
      { redisUrl: 'redis://localhost:6379', concurrency: 1 },
      operations,
    );
    Reflect.set(service, 'connection', { zcard: vi.fn().mockResolvedValue(7) });
    await service.refreshQueueMetrics();
    expect(operations.recordQueueState).toHaveBeenCalledWith({
      deadLetters: 7,
      reconciliationBacklog: 0,
    });
  });
});
