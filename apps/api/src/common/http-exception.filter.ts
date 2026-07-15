import type {
  ArgumentsHost,
  ExceptionFilter} from '@nestjs/common';
import {
  Catch,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { ErrorResponseSchema, type ErrorResponse } from '@extractionstack/shared';

@Catch()
export class HttpExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(HttpExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const shaped = this.fromHttpException(body, status);
      res.status(status).json(shaped);
      return;
    }

    this.logger.error(`unhandled error on ${req.method} ${req.url}`, {
      errorType: exception instanceof Error ? exception.name : 'UnknownError',
    });
    const body: ErrorResponse = {
      code: 'INTERNAL',
      message: 'unexpected error',
    };
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json(body);
  }

  private fromHttpException(body: unknown, status: number): ErrorResponse {
    const parsed = ErrorResponseSchema.safeParse(body);
    if (parsed.success) return parsed.data;
    const code = this.codeForStatus(status);
    return { code, message: 'request failed' };
  }

  private codeForStatus(status: number): ErrorResponse['code'] {
    switch (status) {
      case 400:
        return 'VALIDATION';
      case 401:
        return 'UNAUTHENTICATED';
      case 403:
        return 'FORBIDDEN';
      case 404:
        return 'NOT_FOUND';
      case 429:
        return 'RATE_LIMITED';
      case 502:
        return 'CRAWLER_TARGET';
      case 504:
        return 'CRAWLER_TIMEOUT';
      default:
        return 'INTERNAL';
    }
  }
}
