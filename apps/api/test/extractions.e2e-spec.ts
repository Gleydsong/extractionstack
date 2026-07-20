import type { INestApplication } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { json } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js';
import { RolesGuard } from '../src/auth/roles.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { requestIdMiddleware } from '../src/common/request-context.js';
import { ExtractionsController } from '../src/extractions/extractions.controller.js';
import { ExtractionsService } from '../src/extractions/extractions.service.js';
import {
  EXTRACTION_QUEUE,
  EXTRACTIONS_REPOSITORY,
  type ExtractionQueuePort,
  type ExtractionsRepositoryPort,
  type StoredExtractionJob,
} from '../src/extractions/extractions.types.js';

const date = new Date('2026-07-15T12:00:00.000Z');
const storedJob: StoredExtractionJob = {
  id: 'cm1234567890abcdef',
  requestedUrl: 'https://example.com',
  normalizedUrl: 'https://example.com/',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  errorCode: null,
  errorMessage: null,
  queuedAt: date,
  startedAt: null,
  finishedAt: null,
  createdAt: date,
  updatedAt: date,
  report: null,
};

describe('extractions HTTP contract', () => {
  let app: INestApplication;
  const repository = {
    createOrGet: vi.fn().mockResolvedValue({ created: true, job: storedJob }),
    failQueueSubmission: vi.fn(),
  } as unknown as ExtractionsRepositoryPort;
  const queue = { enqueue: vi.fn(), cancel: vi.fn() } as unknown as ExtractionQueuePort;

  beforeAll(async () => {
    process.env.AUTH_DEV_MODE = 'true';
    process.env.NODE_ENV = 'test';
    const module = await Test.createTestingModule({
      controllers: [ExtractionsController],
      providers: [
        ExtractionsService,
        JwtAuthGuard,
        RolesGuard,
        Reflector,
        { provide: EXTRACTIONS_REPOSITORY, useValue: repository },
        { provide: EXTRACTION_QUEUE, useValue: queue },
      ],
    }).compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use(json({ limit: '16kb', strict: true }));
    app.use(requestIdMiddleware);
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  afterAll(async () => {
    delete process.env.AUTH_DEV_MODE;
    await app.close();
  });

  it('accepts a valid idempotent job request and propagates request id', async () => {
    const requestId = '019f1517-6bd0-7c02-8f28-532a4fcce123';
    const response = await request(app.getHttpServer())
      .post('/api/extractions')
      .set('x-request-id', requestId)
      .set('idempotency-key', 'extract:e2e-request-1')
      .send({ url: 'https://example.com' })
      .expect(202);

    expect(response.headers['x-request-id']).toBe(requestId);
    expect(response.body).toMatchObject({ id: storedJob.id, status: 'QUEUED' });
    expect(queue.enqueue).toHaveBeenCalledWith(storedJob.id);
  });

  it('rejects unknown input fields and missing idempotency key', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/extractions')
      .send({ url: 'https://example.com', role: 'admin' })
      .expect(400);

    expect(response.body).toMatchObject({
      code: 'VALIDATION',
      message: 'Revise os dados informados e tente novamente.',
    });
    expect(response.body).not.toHaveProperty('fields');
    expect(repository.createOrGet).toHaveBeenCalledTimes(1);
  });
});
