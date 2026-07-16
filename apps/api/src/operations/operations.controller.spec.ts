import { ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { OperationsController } from './operations.controller.js';
import type { OperationsService } from './operations.service.js';

afterEach(() => {
  delete process.env.METRICS_TOKEN;
});

describe('OperationsController', () => {
  it('reports liveness without checking dependencies', () => {
    const controller = new OperationsController({} as OperationsService);
    expect(controller.liveness()).toEqual({ status: 'ok' });
  });

  it('fails readiness without leaking dependency errors', async () => {
    const operations = {
      readiness: vi.fn().mockResolvedValue({
        status: 'unavailable',
        checks: { database: false, redis: true },
      }),
    } as unknown as OperationsService;
    await expect(new OperationsController(operations).readiness()).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('protects metrics when a token is configured', async () => {
    process.env.METRICS_TOKEN = 'a-secure-metrics-token';
    const controller = new OperationsController({} as OperationsService);
    await expect(controller.metrics(undefined, {} as never)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });
});
