import { BadRequestException, HttpException, type ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { HttpExceptionFilter } from './http-exception.filter.js';

function httpHost(requestId = 'cb6d0478-a915-4d09-bde4-b6270d677e6a') {
  const json = vi.fn();
  const status = vi.fn(() => ({ json }));
  const host = {
    switchToHttp: () => ({
      getResponse: () => ({ status }),
      getRequest: () => ({ method: 'POST', url: '/api/extractions', id: requestId }),
    }),
  } as unknown as ArgumentsHost;
  return { host, status, json };
}

describe('HttpExceptionFilter', () => {
  it.each([
    {
      exception: { name: 'PayloadTooLargeError', status: 413 },
      label: 'named parser error',
    },
    {
      exception: { type: 'entity.too.large', statusCode: 413 },
      label: 'typed parser error',
    },
  ])('maps a $label to a sanitized 413 response', ({ exception }) => {
    const { host, status, json } = httpHost();

    new HttpExceptionFilter().catch(
      Object.assign(new Error('body contains secret-marker'), exception),
      host,
    );

    expect(status).toHaveBeenCalledWith(413);
    expect(json).toHaveBeenCalledWith({
      code: 'PAYLOAD_TOO_LARGE',
      message: 'O conteúdo enviado excede o limite permitido.',
      requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret-marker');
  });

  it('never exposes an unhandled exception message or stack', () => {
    const { host, json } = httpHost();

    new HttpExceptionFilter().catch(
      new Error('password=secret at /Users/private/database.ts'),
      host,
    );

    expect(json).toHaveBeenCalledWith({
      code: 'INTERNAL',
      message: 'Não foi possível concluir a solicitação.',
      requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    });
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

    expect(json).toHaveBeenCalledWith({
      code: 'VALIDATION',
      message: 'Revise os dados informados e tente novamente.',
      requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    });
  });

  it('preserves only a valid canonical public error', () => {
    const { host, json } = httpHost();

    new HttpExceptionFilter().catch(
      new BadRequestException({ code: 'URL_NOT_ALLOWED', message: 'target rejected' }),
      host,
    );

    expect(json).toHaveBeenCalledWith({
      code: 'URL_NOT_ALLOWED',
      message: 'A URL informada não é permitida.',
      requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    });
  });

  it.each([
    ['CONNECTION_INVALID', 401, 'A conexão com o provedor precisa ser atualizada.'],
    ['PROVIDER_UNAVAILABLE', 503, 'O provedor está temporariamente indisponível.'],
    ['GUARDRAIL_REJECTED', 422, 'A solicitação foi recusada pelas regras de segurança.'],
    ['INSUFFICIENT_CREDITS', 402, 'Os créditos disponíveis são insuficientes.'],
    ['LLM_TIMEOUT', 504, 'A geração excedeu o tempo permitido.'],
    ['LLM_OUTPUT_INVALID', 502, 'O provedor retornou uma resposta que não pôde ser validada.'],
  ])('maps %s to stable natural language', (code, statusCode, message) => {
    const { host, status, json } = httpHost();
    new HttpExceptionFilter().catch(
      new HttpException({ code, message: '401 body={"api_key":"secret"}' }, statusCode),
      host,
    );
    expect(status).toHaveBeenCalledWith(statusCode);
    expect(json).toHaveBeenCalledWith({
      code,
      message,
      requestId: 'cb6d0478-a915-4d09-bde4-b6270d677e6a',
    });
    expect(JSON.stringify(json.mock.calls)).not.toContain('secret');
  });
});
