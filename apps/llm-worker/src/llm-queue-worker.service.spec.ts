import { describe, expect, it } from 'vitest';
import { boundedJitterBackoff, parseQueuePayload } from './llm-queue-worker.service';

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
});
