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
  async readiness(): Promise<{ status: 'ok'; checks: { database: true; redis: true } }> {
    const result = await this.operations.readiness();
    if (result.status !== 'ok') {
      throw new ServiceUnavailableException({
        code: 'DEPENDENCY_UNAVAILABLE',
        message: 'one or more dependencies are unavailable',
        details: result.checks,
      });
    }
    return { status: 'ok', checks: { database: true, redis: true } };
  }

  @Get('metrics')
  @HttpCode(200)
  async metrics(
    @Headers('authorization') authorization: string | undefined,
    @Res() response: Response,
  ): Promise<void> {
    const env = loadRuntimeEnv(process.env);
    if (env.METRICS_TOKEN && authorization !== `Bearer ${env.METRICS_TOKEN}`) {
      throw new UnauthorizedException({ code: 'UNAUTHORIZED', message: 'invalid metrics token' });
    }
    response.type(this.operations.contentType()).send(await this.operations.metrics());
  }
}
