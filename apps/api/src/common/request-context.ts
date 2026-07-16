import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';

const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface RequestWithId extends Request {
  id: string;
}

export function requestIdMiddleware(
  request: Request,
  response: Response,
  next: NextFunction,
): void {
  const supplied = request.header('x-request-id');
  const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
  (request as RequestWithId).id = requestId;
  response.setHeader('x-request-id', requestId);
  next();
}

export function createRequestLogger(): ReturnType<typeof pinoHttp> {
  return pinoHttp({
    level: process.env.LOG_LEVEL ?? 'info',
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.headers["x-api-key"]',
        'res.headers["set-cookie"]',
      ],
      censor: '[REDACTED]',
    },
    customProps: (request) => requestLogContext(request),
    serializers: {
      req: (request) => ({ id: request.id, method: request.method, url: request.url }),
      res: (response) => ({ statusCode: response.statusCode }),
    },
  });
}

export function requestLogContext(request: unknown): { requestId: string | undefined } {
  return { requestId: (request as Partial<RequestWithId>).id };
}
