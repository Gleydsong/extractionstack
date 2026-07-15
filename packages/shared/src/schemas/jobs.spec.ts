import { describe, expect, it } from 'vitest';
import {
  CreateExtractionSchema,
  ExtractionJobSchema,
  ExtractionListQuerySchema,
  IdempotencyKeySchema,
} from './jobs';

describe('job contracts', () => {
  it('accepts a bounded public extraction command', () => {
    expect(
      CreateExtractionSchema.parse({ url: 'https://example.com/products?lang=pt' }),
    ).toEqual({ url: 'https://example.com/products?lang=pt' });
  });

  it('rejects unknown command fields and oversized URLs', () => {
    expect(
      CreateExtractionSchema.safeParse({ url: 'https://example.com', admin: true }).success,
    ).toBe(false);
    expect(
      CreateExtractionSchema.safeParse({ url: `https://example.com/${'x'.repeat(2049)}` }).success,
    ).toBe(false);
  });

  it('accepts only bounded, non-ambiguous idempotency keys', () => {
    expect(IdempotencyKeySchema.safeParse('extract-request:0001').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('x'.repeat(129)).success).toBe(false);
    expect(IdempotencyKeySchema.safeParse("key' OR 1=1 --").success).toBe(false);
  });

  it('coerces safe pagination and rejects arbitrary sort expressions', () => {
    expect(ExtractionListQuerySchema.parse({ limit: '25', sort: 'createdAt:desc' })).toEqual({
      limit: 25,
      sort: 'createdAt:desc',
    });
    expect(
      ExtractionListQuerySchema.safeParse({ sort: 'createdAt; DROP TABLE User' }).success,
    ).toBe(false);
    expect(ExtractionListQuerySchema.safeParse({ limit: '101' }).success).toBe(false);
  });

  it('requires valid job state and rejects mass assignment', () => {
    const base = {
      id: 'cm1234567890',
      requestedUrl: 'https://example.com',
      normalizedUrl: 'https://example.com/',
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      queuedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(ExtractionJobSchema.safeParse(base).success).toBe(true);
    expect(ExtractionJobSchema.safeParse({ ...base, ownerId: 'other-user' }).success).toBe(false);
    expect(ExtractionJobSchema.safeParse({ ...base, status: 'MAGIC' }).success).toBe(false);
  });
});
