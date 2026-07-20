import { describe, expect, it, vi } from 'vitest';
import { requestIdMiddleware, requestLogContext, type RequestWithId } from './request-context.js';
import { ErrorResponseSchema } from '@extractionstack/shared';

function invoke(value?: string): { id: string; header: unknown; next: ReturnType<typeof vi.fn> } {
  const request = { header: vi.fn().mockReturnValue(value) } as unknown as RequestWithId;
  const setHeader = vi.fn();
  const next = vi.fn();
  requestIdMiddleware(request, { setHeader } as never, next);
  return { id: request.id, header: setHeader.mock.calls[0]?.[1], next };
}

describe('requestIdMiddleware', () => {
  it('preserves a canonical UUID caller correlation id', () => {
    const supplied = 'cb6d0478-a915-4d09-bde4-b6270d677e6a';
    const result = invoke(supplied);
    expect(result.id).toBe(supplied);
    expect(result.header).toBe(result.id);
    expect(result.next).toHaveBeenCalledOnce();
  });

  it.each(['', 'job:123.trace-1', 'contains spaces', '<script>', 'a'.repeat(129)])(
    'replaces unsafe correlation id %j',
    (value) => {
      const generated = invoke(value).id;
      expect(generated).toMatch(/^[0-9a-f-]{36}$/);
      expect(
        ErrorResponseSchema.safeParse({ code: 'INTERNAL', message: 'Falha.', requestId: generated })
          .success,
      ).toBe(true);
    },
  );
});

describe('requestLogContext', () => {
  it('reads the Express request id passed directly by pino-http', () => {
    expect(requestLogContext({ id: 'request-123' })).toEqual({ requestId: 'request-123' });
  });
});
