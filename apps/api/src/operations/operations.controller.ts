import {
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import { OperationsService } from './operations.service.js';

@Controller()
export class OperationsController {
  constructor(@Inject(OperationsService) private readonly operations: OperationsService) {}

  @Get('health/live')
  liveness(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async readiness(): Promise<{ status: 'ok'; checks: Record<string, boolean> }> {
    const result = await this.operations.readiness();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'one or more dependencies are unavailable',
        details: result.checks,
      });
    }
    return {
      status: 'ok',
      checks: Object.fromEntries(Object.keys(result.checks).map((key) => [key, true])),
    };
  }

  @Get('metrics')
  @HttpCode(200)
  async metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const env = loadRuntimeEnv(process.env);
    if (!env.METRICS_TOKEN || !secureTokenMatches(authorization, env.METRICS_TOKEN)) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'invalid metrics token' });
    }
    response.type(this.operations.contentType()).send(await this.operations.metrics());
  }
}

function secureTokenMatches(authorization: string | undefined, expected: string): boolean {
  const actualHash = createHash('sha256')
    .update(authorization ?? '')
    .digest();
  const expectedHash = createHash('sha256').update(`Bearer ${expected}`).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
