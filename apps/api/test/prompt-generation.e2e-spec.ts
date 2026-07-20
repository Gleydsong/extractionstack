import 'reflect-metadata';
import {
  ConflictException,
  type CanActivate,
  type ExecutionContext,
  type INestApplication,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { PricingCatalog, ProviderRegistry } from '@extractionstack/llm-core';
import type {
  Auth0User,
  PromptGenerationJob,
  PromptProject,
  PromptVersionDetail,
  PromptWizardInput,
} from '@extractionstack/shared';
import { json } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { JwtAuthGuard } from '../src/auth/jwt-auth.guard.js';
import { RolesGuard } from '../src/auth/roles.guard.js';
import { HttpExceptionFilter } from '../src/common/http-exception.filter.js';
import { LlmRateLimitGuard } from '../src/common/llm-rate-limit.guard.js';
import { requestIdMiddleware } from '../src/common/request-context.js';
import { CreditsService, type CreditsPort } from '../src/credits/credits.service.js';
import {
  PROMPT_GENERATION_QUEUE,
  PROMPT_PROJECTS_REPOSITORY,
  PromptProjectsService,
  type PromptGenerationQueuePort,
  type PromptProjectsRepositoryPort,
} from '../src/prompt-projects/prompt-projects.service.js';
import {
  PromptJobsController,
  PromptProjectsController,
  PromptVersionsController,
} from '../src/prompt-projects/prompt-projects.controller.js';

const NOW = '2026-07-16T12:00:00.000Z';
const OWNER_PROJECT = 'cmownerproject000000000001';
const OWNER_VERSION = 'cmownerversion000000000001';
const OWNER_CONNECTION = 'cmownerconnection000000001';
const OTHER_CONNECTION = 'cmotherconnection000000001';

const owner: Auth0User = { sub: 'auth0|owner', roles: ['user'] };
const other: Auth0User = { sub: 'auth0|other', roles: ['user'] };

const wizard: PromptWizardInput = {
  extractionId: 'cmownerextraction000000001',
  category: 'application',
  objective: 'Criar uma aplicação acessível e segura',
  audience: 'Equipa de produto',
  technologies: ['TypeScript'],
  exclusions: ['credenciais'],
  requirements: ['Saída em linguagem natural'],
  language: 'pt-BR',
  detail: 'complete',
  destination: 'universal',
  freeInstructions: '',
};

const generation = {
  provider: 'FAKE' as const,
  model: 'fake-deterministic-v1',
  credentialMode: 'PLATFORM_CREDITS' as const,
  connectionId: null,
  acceptPlatformCharge: true,
  maximumCostMinor: '25',
};

class HeaderAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string>; user?: Auth0User }>();
    req.user = req.headers['x-test-user'] === 'other' ? other : owner;
    return true;
  }
}

class MemoryPromptRepository implements PromptProjectsRepositoryPort {
  readonly projects = new Map<string, PromptProject & { ownerSub: string }>();
  readonly versions = new Map<string, PromptVersionDetail & { ownerSub: string }>();
  readonly jobs = new Map<string, PromptGenerationJob & { ownerSub: string }>();
  readonly connections = new Map<string, { ownerSub: string; provider: string; mode: string }>();
  readonly idempotency = new Map<string, { fingerprint: string; jobId: string }>();
  createJobCalls = 0;
  private sequence = 0;

  reset(): void {
    this.projects.clear();
    this.versions.clear();
    this.jobs.clear();
    this.connections.clear();
    this.idempotency.clear();
    this.createJobCalls = 0;
    this.sequence = 0;
    this.projects.set(OWNER_PROJECT, {
      id: OWNER_PROJECT,
      extractionId: wizard.extractionId,
      title: 'Aplicação segura',
      category: wizard.category,
      language: wizard.language,
      wizardInput: wizard,
      currentVersionId: OWNER_VERSION,
      state: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
      ownerSub: owner.sub,
    });
    this.versions.set(OWNER_VERSION, {
      id: OWNER_VERSION,
      projectId: OWNER_PROJECT,
      sequence: 1,
      sourceVersionId: null,
      kind: 'UNIVERSAL',
      destination: 'universal',
      content: 'Construa uma aplicação com evidências delimitadas e requisitos verificáveis.',
      summary: 'Prompt universal inicial.',
      provider: 'FAKE',
      model: generation.model,
      createdAt: NOW,
      ownerSub: owner.sub,
    });
    this.connections.set(OWNER_CONNECTION, {
      ownerSub: owner.sub,
      provider: 'OPENAI',
      mode: 'API_KEY',
    });
    this.connections.set(OTHER_CONNECTION, {
      ownerSub: other.sub,
      provider: 'OPENAI',
      mode: 'API_KEY',
    });
  }

  async createProject(
    actor: Auth0User,
    input: PromptWizardInput,
  ): Promise<{ result: PromptProject; created: boolean }> {
    const result: PromptProject = {
      id: `cmcreatedproject${String(++this.sequence).padStart(10, '0')}`,
      extractionId: input.extractionId,
      title: input.objective.slice(0, 200),
      category: input.category,
      language: input.language,
      wizardInput: input,
      currentVersionId: null,
      state: 'ACTIVE',
      createdAt: NOW,
      updatedAt: NOW,
    };
    this.projects.set(result.id, { ...result, ownerSub: actor.sub });
    return { result, created: true };
  }

  async findProjectOwned(actor: Auth0User, id: string): Promise<PromptProject | null> {
    const project = this.projects.get(id);
    return project?.ownerSub === actor.sub ? stripOwner(project) : null;
  }

  async findExtractionReportOwned(): Promise<null> {
    return null;
  }

  async listProjectsOwned(actor: Auth0User) {
    return {
      items: [...this.projects.values()]
        .filter((item) => item.ownerSub === actor.sub)
        .map(stripOwner),
      nextCursor: null,
    };
  }

  async findVersionOwned(actor: Auth0User, id: string) {
    const version = this.versions.get(id);
    return version?.ownerSub === actor.sub
      ? { id: version.id, projectId: version.projectId }
      : null;
  }

  async listVersionsOwned(actor: Auth0User, projectId: string) {
    if (!(await this.findProjectOwned(actor, projectId))) return null;
    return {
      items: [...this.versions.values()]
        .filter((item) => item.ownerSub === actor.sub && item.projectId === projectId)
        .map(({ content: _content, ownerSub: _ownerSub, ...item }) => item),
      nextCursor: null,
    };
  }

  async getVersionOwned(actor: Auth0User, id: string): Promise<PromptVersionDetail | null> {
    const version = this.versions.get(id);
    return version?.ownerSub === actor.sub ? stripOwner(version) : null;
  }

  async findPreviewByJobOwned(): Promise<null> {
    return null;
  }

  async createEditedVersionOwned(): Promise<null> {
    return null;
  }

  async findActiveConnectionOwned(actor: Auth0User, id: string, provider: string, mode: string) {
    const connection = this.connections.get(id);
    return Boolean(
      connection?.ownerSub === actor.sub &&
      connection.provider === provider &&
      connection.mode === mode,
    );
  }

  async createJob(
    actor: Auth0User,
    command: Parameters<PromptProjectsRepositoryPort['createJob']>[1],
    idempotencyKey: string,
    idempotencyRequest: Parameters<PromptProjectsRepositoryPort['createJob']>[3],
  ) {
    this.createJobCalls += 1;
    const key = `${actor.sub}:${command.operation}:${idempotencyKey}`;
    const fingerprint = JSON.stringify({ command, request: idempotencyRequest });
    const existing = this.idempotency.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw new ConflictException({ code: 'CONFLICT', message: 'idempotency conflict' });
      }
      return {
        result: stripOwner(this.jobs.get(existing.jobId)!),
        ownerId: actor.sub,
        created: false,
      };
    }
    const id = `cmpromptjob${String(++this.sequence).padStart(14, '0')}`;
    const result: PromptGenerationJob & { ownerSub: string } = {
      id,
      projectId: command.projectId,
      operation: command.operation,
      provider: command.provider,
      model: command.model,
      credentialMode: command.credentialMode,
      status: 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      sourcePromptVersionId: command.sourcePromptVersionId,
      resultPromptVersionId: null,
      message: 'Queued',
      queuedAt: NOW,
      startedAt: null,
      finishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
      ownerSub: actor.sub,
    };
    this.jobs.set(id, result);
    this.idempotency.set(key, { fingerprint, jobId: id });
    return { result: stripOwner(result), ownerId: actor.sub, created: true };
  }

  async findJobOwned(actor: Auth0User, id: string): Promise<PromptGenerationJob | null> {
    const job = this.jobs.get(id);
    return job?.ownerSub === actor.sub ? stripOwner(job) : null;
  }

  async failJob(
    actor: Auth0User,
    id: string,
    errorCode: string,
  ): Promise<PromptGenerationJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.ownerSub !== actor.sub || job.status !== 'QUEUED') return null;
    const failed = {
      ...job,
      status: 'FAILED' as const,
      errorCode,
      message: 'generation submission failed',
      retryable: true,
      finishedAt: NOW,
      updatedAt: NOW,
    };
    this.jobs.set(id, failed);
    return stripOwner(failed);
  }

  async requestCancellation(actor: Auth0User, id: string): Promise<PromptGenerationJob | null> {
    const job = this.jobs.get(id);
    if (!job || job.ownerSub !== actor.sub || (job.status !== 'QUEUED' && job.status !== 'RUNNING'))
      return null;
    const cancelled = {
      ...job,
      status: job.status === 'QUEUED' ? ('CANCELLED' as const) : ('CANCEL_REQUESTED' as const),
      message: job.status === 'QUEUED' ? 'Cancelled' : 'Cancellation requested',
      finishedAt: job.status === 'QUEUED' ? NOW : null,
      updatedAt: NOW,
    };
    this.jobs.set(id, cancelled);
    return stripOwner(cancelled);
  }

  async findOpenCreditReservationOwned(): Promise<string | null> {
    return 'cmcreditreservation000000001';
  }
}

class AtomicCreditsDouble implements CreditsPort {
  balance = 100n;
  readonly reservations = new Map<string, { id: string; amount: bigint }>();
  readonly reverse = vi.fn(async () => undefined);
  readonly confirm = vi.fn(async () => undefined);

  reset(balance = 100n): void {
    this.balance = balance;
    this.reservations.clear();
    this.reverse.mockClear();
    this.confirm.mockClear();
  }

  async reserve(command: Parameters<CreditsPort['reserve']>[0]) {
    const existing = this.reservations.get(command.idempotencyKey);
    if (existing) return reservation(existing.id, command.ownerId, command.jobId, existing.amount);
    if (this.balance < command.amountMinor) throw new Error('INSUFFICIENT_CREDITS');
    this.balance -= command.amountMinor;
    const id = `cmreservation${String(this.reservations.size + 1).padStart(14, '0')}`;
    this.reservations.set(command.idempotencyKey, { id, amount: command.amountMinor });
    return reservation(id, command.ownerId, command.jobId, command.amountMinor);
  }
}

function reservation(id: string, ownerId: string, jobId: string, amount: bigint) {
  return {
    id,
    ownerId,
    jobId,
    amountMinor: amount.toString(),
    maximumAcceptedAmountMinor: amount.toString(),
    createdAt: NOW,
  };
}

type WithoutOwner<T> = T extends { ownerSub: string } ? Omit<T, 'ownerSub'> : never;

function stripOwner<T extends { ownerSub: string }>(value: T): WithoutOwner<T> {
  const { ownerSub, ...publicValue } = value;
  void ownerSub;
  return publicValue as WithoutOwner<T>;
}

describe('prompt generation HTTP contract', () => {
  let app: INestApplication;
  const repository = new MemoryPromptRepository();
  const credits = new AtomicCreditsDouble();
  const queue: PromptGenerationQueuePort = {
    enqueue: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
  };

  beforeAll(async () => {
    const registry = new ProviderRegistry(
      [
        {
          provider: 'FAKE',
          credentialModes: ['PLATFORM_CREDITS'],
          models: [generation.model],
          contextWindowTokens: 8_192,
          maxOutputTokens: 2_048,
          supportsStructuredOutput: true,
          supportsCancellation: true,
          supportsCredentialRefresh: false,
          oauthScopes: [],
          previewEligible: true,
          pricingMetadataVersion: 'test-fixed-2026-07-16',
          enabled: true,
          circuitBreakerOpen: false,
        },
        {
          provider: 'OPENAI',
          credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
          models: ['gpt-test'],
          contextWindowTokens: 8_192,
          maxOutputTokens: 2_048,
          supportsStructuredOutput: true,
          supportsCancellation: true,
          supportsCredentialRefresh: false,
          oauthScopes: [],
          previewEligible: true,
          pricingMetadataVersion: 'test-fixed-2026-07-16',
          enabled: true,
          circuitBreakerOpen: false,
        },
      ],
      { allowTestProvider: true },
    );
    const module = await Test.createTestingModule({
      controllers: [PromptProjectsController, PromptVersionsController, PromptJobsController],
      providers: [
        PromptProjectsService,
        RolesGuard,
        Reflector,
        { provide: PROMPT_PROJECTS_REPOSITORY, useValue: repository },
        { provide: PROMPT_GENERATION_QUEUE, useValue: queue },
        { provide: ProviderRegistry, useValue: registry },
        { provide: PricingCatalog, useValue: new PricingCatalog('test-fixed', []) },
        { provide: CreditsService, useValue: credits },
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue(new HeaderAuthGuard())
      .overrideGuard(LlmRateLimitGuard)
      .useValue({ canActivate: () => true })
      .compile();
    app = module.createNestApplication({ bodyParser: false });
    app.use(requestIdMiddleware);
    app.use(json({ limit: '16kb', strict: true }));
    app.useGlobalFilters(new HttpExceptionFilter());
    await app.init();
  });

  beforeEach(() => {
    repository.reset();
    credits.reset();
    vi.mocked(queue.enqueue).mockReset().mockResolvedValue(undefined);
    vi.mocked(queue.cancel).mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => app.close());

  it('submits a deterministic fake-provider job and exposes only the natural-language status contract', async () => {
    const response = await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('x-test-user', 'owner')
      .set('idempotency-key', 'generation:e2e:0001')
      .send(generation)
      .expect(202);

    expect(response.body).toMatchObject({
      projectId: OWNER_PROJECT,
      provider: 'FAKE',
      status: 'QUEUED',
      message: 'Queued',
    });
    expect(response.text).not.toContain('{"prompt"');
    expect(queue.enqueue).toHaveBeenCalledWith(response.body.id);
    expect(credits.reservations.size).toBe(1);
  });

  it('returns the same job and does not duplicate reservation or enqueue for an idempotent replay', async () => {
    const submit = () =>
      request(app.getHttpServer())
        .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
        .set('idempotency-key', 'generation:e2e:replay')
        .send(generation);

    const first = await submit();
    const second = await submit();

    expect([first.status, second.status]).toEqual([202, 202]);
    expect(second.body.id).toBe(first.body.id);
    expect(credits.reservations.size).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('rejects reuse of one idempotency key for a different request fingerprint', async () => {
    const key = 'generation:e2e:conflict';
    await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('idempotency-key', key)
      .send(generation)
      .expect(202);

    const response = await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('idempotency-key', key)
      .send({ ...generation, maximumCostMinor: '26' })
      .expect(409);

    expect(response.body).toMatchObject({ code: 'CONFLICT' });
  });

  it('hides projects, versions, and jobs owned by another user', async () => {
    const submitted = await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('idempotency-key', 'generation:e2e:owner')
      .send(generation)
      .expect(202);

    await request(app.getHttpServer())
      .get(`/api/prompt-projects/${OWNER_PROJECT}`)
      .set('x-test-user', 'other')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/prompt-versions/${OWNER_VERSION}`)
      .set('x-test-user', 'other')
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/prompt-jobs/${submitted.body.id}`)
      .set('x-test-user', 'other')
      .expect(404);

    await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('x-test-user', 'other')
      .set('idempotency-key', 'generation:e2e:cross-owner-project')
      .send(generation)
      .expect(404);
  });

  it('returns 404 when an owner uses another user provider connection on an owned project', async () => {
    await request(app.getHttpServer()).get(`/api/prompt-projects/${OWNER_PROJECT}`).expect(200);
    const createJobCallsBefore = repository.createJobCalls;

    await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('idempotency-key', 'generation:e2e:cross-owner-connection')
      .send({
        provider: 'OPENAI',
        model: 'gpt-test',
        credentialMode: 'API_KEY',
        connectionId: OTHER_CONNECTION,
        acceptPlatformCharge: false,
        maximumCostMinor: null,
      })
      .expect(404);

    expect(repository.connections.get(OTHER_CONNECTION)?.ownerSub).toBe(other.sub);
    expect(repository.createJobCalls).toBe(createJobCallsBefore);
  });

  it('atomically allows only one concurrent reservation when the balance covers one job', async () => {
    credits.reset(60n);
    const expensive = { ...generation, maximumCostMinor: '60' };
    const responses = await Promise.all([
      request(app.getHttpServer())
        .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
        .set('idempotency-key', 'generation:e2e:credit-a')
        .send(expensive),
      request(app.getHttpServer())
        .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
        .set('idempotency-key', 'generation:e2e:credit-b')
        .send(expensive),
    ]);

    expect(responses.map(({ status }) => status).sort()).toEqual([202, 402]);
    expect(credits.reservations.size).toBe(1);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('cancels an owned queued job once and reverses its open credit reservation', async () => {
    const submitted = await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('idempotency-key', 'generation:e2e:cancel')
      .send(generation)
      .expect(202);

    const cancelled = await request(app.getHttpServer())
      .post(`/api/prompt-jobs/${submitted.body.id}/cancel`)
      .set('idempotency-key', 'cancel:e2e:0001')
      .expect(200);

    expect(cancelled.body).toMatchObject({ status: 'CANCELLED', message: 'Cancelled' });
    expect(queue.cancel).toHaveBeenCalledWith(submitted.body.id);
    expect(credits.reverse).toHaveBeenCalledTimes(1);
    await request(app.getHttpServer())
      .post(`/api/prompt-jobs/${submitted.body.id}/cancel`)
      .set('idempotency-key', 'cancel:e2e:0002')
      .expect(409);
  });

  it('sanitizes queue failures and never exposes provider, SQL, stack, or secret details', async () => {
    vi.mocked(queue.enqueue).mockRejectedValueOnce(
      new Error('postgres://admin:secret@db/internal SELECT * FROM credentials provider-body'),
    );
    const response = await request(app.getHttpServer())
      .post(`/api/prompt-projects/${OWNER_PROJECT}/generations`)
      .set('x-request-id', '019f1517-6bd0-7c02-8f28-532a4fcce111')
      .set('idempotency-key', 'generation:e2e:failure')
      .send(generation)
      .expect(503);

    expect(response.body).toEqual({
      code: 'QUEUE_UNAVAILABLE',
      message: 'A fila de geração está temporariamente indisponível.',
      requestId: '019f1517-6bd0-7c02-8f28-532a4fcce111',
    });
    expect(response.text).not.toMatch(/secret|postgres|SELECT|provider-body|stack/i);
    expect(credits.reverse).toHaveBeenCalledTimes(1);
  });
});
