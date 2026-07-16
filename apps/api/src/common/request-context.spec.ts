import { describe, expect, it, vi } from 'vitest';
import {
  requestIdMiddleware,
  requestLogContext,
  type RequestWithId,
} from './request-context.js';

function invoke(value?: string): { id: string; header: unknown; next: ReturnType<typeof vi.fn> } {
  const request = { header: vi.fn().mockReturnValue(value) } as unknown as RequestWithId;
  const setHeader = vi.fn();
  const next = vi.fn();
  requestIdMiddleware(request, { setHeader } as never, next);
  return { id: request.id, header: setHeader.mock.calls[0]?.[1], next };
}

describe('requestIdMiddleware', () => {
  it('preserves a safe caller correlation id', () => {
    const result = invoke('job:123.trace-1');
    expect(result.id).toBe('job:123.trace-1');
    expect(result.header).toBe(result.id);
    expect(result.next).toHaveBeenCalledOnce();
  });

  it.each(['', 'contains spaces', '<script>', 'a'.repeat(129)])(
    'replaces unsafe correlation id %j',
    (value) => {
      expect(invoke(value).id).toMatch(/^[0-9a-f-]{36}$/);
    },
  );
});

describe('requestLogContext', () => {
  it('reads the Express request id passed directly by pino-http', () => {
    expect(requestLogContext({ id: 'request-123' })).toEqual({ requestId: 'request-123' });
  });
});
