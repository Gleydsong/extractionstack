import { describe, expect, it, vi } from 'vitest';
import { ExtractionApiClient } from './api-client';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const queuedJob = {
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

describe('ExtractionApiClient', () => {
  it('rejects a successful response that violates the shared schema', async () => {
    const fetcher = vi.fn().mockResolvedValue(response({ ...queuedJob, status: 'MAGIC' }));
    const client = new ExtractionApiClient(async () => 'token', fetcher);

    await expect(client.getJob('cm1234567890abcdef')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('submits auth, JSON, and a bounded idempotency key', async () => {
    const fetcher = vi.fn().mockResolvedValue(response(queuedJob, 202));
    const client = new ExtractionApiClient(async () => 'access-token', fetcher);

    await client.createJob('https://example.com', 'extract-request:0001');

    expect(fetcher).toHaveBeenCalledWith(
      '/api/extractions',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          authorization: 'Bearer access-token',
          'idempotency-key': 'extract-request:0001',
        }),
      }),
    );
  });

  it('returns a canonical API error without trusting arbitrary fields', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      response({ code: 'RATE_LIMITED', message: 'slow down', stack: 'secret' }, 429),
    );
    const client = new ExtractionApiClient(async () => 'token', fetcher);

    await expect(client.getJob('cm1234567890abcdef')).rejects.toMatchObject({
      code: 'HTTP_ERROR',
      message: 'request failed (429)',
    });
  });
});
