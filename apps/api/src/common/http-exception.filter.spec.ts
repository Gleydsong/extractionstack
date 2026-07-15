import { BadRequestException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

function httpHost() {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/api/extractions' }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  it('never exposes an unhandled exception message or stack', () => {
    const { host, json } = httpHost();

    new HttpExceptionFilter().catch(
      new Error('password=secret at /Users/private/database.ts'),
      host,
    );

    expect(json).toHaveBeenCalledWith({ code: 'INTERNAL', message: 'unexpected error' });
  });

  it('strips unknown fields from a shaped public exception', () => {
    const { host, json } = httpHost();

    new HttpExceptionFilter().catch(
      new BadRequestException({
        code: 'VALIDATION',
        message: 'invalid input',
        internalSql: 'SELECT * FROM User',
      }),
      host,
    );

    expect(json).toHaveBeenCalledWith({ code: 'VALIDATION', message: 'request failed' });
  });

  it('preserves only a valid canonical public error', () => {
    const { host, json } = httpHost();

    new HttpExceptionFilter().catch(
      new BadRequestException({ code: 'URL_NOT_ALLOWED', message: 'target rejected' }),
      host,
    );

    expect(json).toHaveBeenCalledWith({
      code: 'URL_NOT_ALLOWED',
      message: 'target rejected',
    });
  });
});
