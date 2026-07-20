import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import pinoHttp from 'pino-http';

const REQUEST_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

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
      req: (request) => ({
        id: request.id,
        method: request.method,
        path: typeof request.url === 'string' ? request.url.split('?', 1)[0] : undefined,
      }),
      res: (response) => ({ statusCode: response.statusCode }),
    },
  });
}

export function requestLogContext(request: unknown): { requestId: string | undefined } {
  return { requestId: (request as Partial<RequestWithId>).id };
}

export function isUuidRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}
