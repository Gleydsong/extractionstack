import { randomUUID } from 'node:crypto';
import { ProviderRegistry } from '@extractionstack/llm-core';
import type { Auth0User, PromptWizardInput } from '@extractionstack/shared';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CreditsRepository } from '../credits/credits.repository.js';
import { CreditsService } from '../credits/credits.service.js';
import { PromptProjectsRepository } from './prompt-projects.repository.js';
import { PromptProjectsService } from './prompt-projects.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const prismaUrl = databaseUrl ?? 'postgresql://skip:skip@127.0.0.1:1/skip';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('PromptProjectsRepository PostgreSQL integration', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: prismaUrl } } });
  const repository = new PromptProjectsRepository(prisma);

  afterAll(async () => prisma.$disconnect());

  it('enforces extraction ownership and stores only the strict wizard projection', async () => {
    const owner = actor('owner');
    const other = actor('other');
    const extractionId = await createExtraction(prisma, owner);
    const input = wizard(extractionId);

    await expect(repository.createProject(other, input, 'project:other-owner')).resolves.toBeNull();
    const created = await repository.createProject(owner, input, 'project:owned');
    expect(created?.result.wizardInput).toEqual(input);
    const stored = await prisma.promptProject.findUniqueOrThrow({
      where: { id: created!.result.id },
    });
    expect(stored.wizardInput).toEqual(input);
  });

  it('uses durable project and job idempotency without duplicate audits', async () => {
    const owner = actor('idempotency');
    const extractionId = await createExtraction(prisma, owner);
    const project = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:idempotent',
    ))!.result;
    const command = generationCommand(project.id);
    const first = await repository.createJob(owner, command, 'generation:idempotent');
    const second = await repository.createJob(owner, command, 'generation:idempotent');

    expect(second).toMatchObject({ created: false, result: { id: first.result.id } });
    expect(await prisma.promptGenerationJob.count({ where: { id: first.result.id } })).toBe(1);
    expect(
      await prisma.auditEvent.count({
        where: { entityId: first.result.id, action: 'prompt_job.created' },
      }),
    ).toBe(1);
    await expect(
      repository.createJob(owner, { ...command, model: 'other-model' }, 'generation:idempotent'),
    ).rejects.toMatchObject({ status: 409 });
  });

  it('does not accept another owner project as a pagination cursor', async () => {
    const owner = actor('cursor-owner');
    const other = actor('cursor-other');
    const ownedExtraction = await createExtraction(prisma, owner);
    const otherExtraction = await createExtraction(prisma, other);
    await repository.createProject(owner, wizard(ownedExtraction), 'project:cursor-owner');
    const otherProject = (await repository.createProject(
      other,
      wizard(otherExtraction),
      'project:cursor-other',
    ))!.result;
    await expect(
      repository.listProjectsOwned(owner, { cursor: otherProject.id, limit: 20 }),
    ).resolves.toBeNull();
  });

  it('rejects another owner active provider connection at repository and database scope', async () => {
    const owner = actor('connection-owner');
    const other = actor('connection-other');
    const extractionId = await createExtraction(prisma, owner);
    await createExtraction(prisma, other);
    const project = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:connection-owner',
    ))!.result;
    const otherRow = await prisma.user.findUniqueOrThrow({ where: { auth0Sub: other.sub } });
    const connection = await prisma.aiConnection.create({
      data: {
        ownerId: otherRow.id,
        provider: 'OPENAI',
        displayLabel: 'Other owner API key',
        credentialMode: 'API_KEY',
        state: 'ACTIVE',
        scopes: [],
      },
    });

    await expect(
      repository.findActiveConnectionOwned(owner, connection.id, 'OPENAI', 'API_KEY'),
    ).resolves.toBe(false);
    await expect(
      repository.createJob(
        owner,
        {
          ...generationCommand(project.id),
          credentialMode: 'API_KEY',
          connectionId: connection.id,
        },
        'generation:cross-owner-connection',
      ),
    ).rejects.toThrow('prompt job connection scope is invalid');
  });

  it('returns the current terminal job on replay after queue failure', async () => {
    const owner = actor('failed-replay');
    const extractionId = await createExtraction(prisma, owner);
    const project = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:failed-replay',
    ))!.result;
    const command = generationCommand(project.id);
    const first = await repository.createJob(owner, command, 'generation:failed-replay');
    await repository.failJob(owner, first.result.id, 'QUEUE_UNAVAILABLE');

    const replay = await repository.createJob(owner, command, 'generation:failed-replay');
    expect(replay).toMatchObject({
      created: false,
      result: { id: first.result.id, status: 'FAILED' },
    });
  });

  it('allocates concurrent immutable version sequences and rejects cross-project references', async () => {
    const owner = actor('versions');
    const extractionId = await createExtraction(prisma, owner);
    const left = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:versions-left',
    ))!.result;
    const right = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:versions-right',
    ))!.result;
    const [first, second] = await Promise.all([
      repository.createVersion(owner, versionCommand(left.id, 'First content')),
      repository.createVersion(owner, versionCommand(left.id, 'Second content')),
    ]);
    expect([first.sequence, second.sequence].sort()).toEqual([1, 2]);
    await expect(
      repository.createVersion(owner, {
        ...versionCommand(right.id, 'Cross project'),
        sourceVersionId: first.id,
        kind: 'ADAPTED',
        destination: 'codex',
      }),
    ).rejects.toThrow('PROMPT_SCOPE_NOT_FOUND');

    await expect(
      prisma.promptVersion.update({ where: { id: first.id }, data: { content: 'mutated' } }),
    ).rejects.toThrow('prompt versions are append-only');
    await expect(prisma.promptVersion.delete({ where: { id: first.id } })).rejects.toThrow(
      'prompt versions are append-only',
    );
    await expect(
      prisma.promptProject.update({
        where: { id: right.id },
        data: { currentVersionId: first.id },
      }),
    ).rejects.toThrow('current prompt version must belong to its project');
  });

  it('reverses an actual credit reservation once and leaves a terminal job when enqueue fails', async () => {
    const owner = actor('credits-rollback');
    const extractionId = await createExtraction(prisma, owner);
    const project = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:credits-rollback',
    ))!.result;
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { auth0Sub: owner.sub } });
    await prisma.creditLedgerEntry.create({
      data: {
        ownerId: ownerRow.id,
        kind: 'GRANT',
        amountMinor: 500n,
        currency: 'CREDITS',
        idempotencyKey: `grant:${randomUUID()}`,
      },
    });
    const credits = new CreditsService(new CreditsRepository(prisma));
    const queue = {
      enqueue: vi.fn().mockRejectedValue(new Error('redis secret payload')),
      cancel: vi.fn(),
    };
    const service = new PromptProjectsService(repository, queue, registry(), credits);

    await expect(
      service.generate(owner, project.id, paidRequest(), 'generation:queue-failure'),
    ).rejects.toMatchObject({ status: 503 });
    const jobs = await prisma.promptGenerationJob.findMany({ where: { projectId: project.id } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'FAILED', errorCode: 'QUEUE_UNAVAILABLE' });
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: jobs[0]!.id, kind: 'RESERVATION' } }),
    ).toBe(1);
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: jobs[0]!.id, kind: 'REVERSAL' } }),
    ).toBe(1);

    const replay = await service.generate(
      owner,
      project.id,
      paidRequest(),
      'generation:queue-failure',
    );
    expect(replay).toMatchObject({ id: jobs[0]!.id, status: 'FAILED' });
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: jobs[0]!.id } })).toBe(2);
  });

  it('reverses a queued credit reservation exactly once when cancellation removes the transport job', async () => {
    const owner = actor('credits-cancel');
    const extractionId = await createExtraction(prisma, owner);
    const project = (await repository.createProject(
      owner,
      wizard(extractionId),
      'project:credits-cancel',
    ))!.result;
    const ownerRow = await prisma.user.findUniqueOrThrow({ where: { auth0Sub: owner.sub } });
    await prisma.creditLedgerEntry.create({
      data: {
        ownerId: ownerRow.id,
        kind: 'GRANT',
        amountMinor: 500n,
        currency: 'CREDITS',
        idempotencyKey: `grant:${randomUUID()}`,
      },
    });
    const queue = { enqueue: vi.fn(), cancel: vi.fn() };
    const service = new PromptProjectsService(
      repository,
      queue,
      registry(),
      new CreditsService(new CreditsRepository(prisma)),
    );
    const queued = await service.generate(owner, project.id, paidRequest(), 'generation:cancel');

    const cancelled = await service.cancel(owner, queued.id, 'cancel:queued');
    expect(cancelled.status).toBe('CANCELLED');
    expect(queue.cancel).toHaveBeenCalledWith(queued.id);
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: queued.id, kind: 'REVERSAL' } }),
    ).toBe(1);

    await expect(service.cancel(owner, queued.id, 'cancel:queued')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: queued.id, kind: 'REVERSAL' } }),
    ).toBe(1);
  });
});

function actor(name: string): Auth0User {
  return {
    sub: `auth0|prompt-${name}-${randomUUID()}`,
    email: `${name}-${randomUUID()}@example.test`,
    roles: ['user'],
  };
}

async function createExtraction(prisma: PrismaClient, owner: Auth0User): Promise<string> {
  const user = await prisma.user.upsert({
    where: { auth0Sub: owner.sub },
    create: { auth0Sub: owner.sub, email: owner.email },
    update: {},
  });
  const suffix = randomUUID();
  const extraction = await prisma.extractionJob.create({
    data: {
      ownerId: user.id,
      requestedUrl: 'https://prompt.example.test',
      normalizedUrl: 'https://prompt.example.test/',
      idempotencyKey: `extract:${suffix}`,
      status: 'SUCCEEDED',
      finishedAt: new Date(),
    },
  });
  return extraction.id;
}

function wizard(extractionId: string): PromptWizardInput {
  return {
    extractionId,
    category: 'application',
    objective: 'Build a maintainable application',
    audience: 'Developers',
    technologies: ['TypeScript'],
    exclusions: [],
    requirements: ['Use strict types'],
    language: 'en-US',
    detail: 'balanced',
    destination: 'universal',
    freeInstructions: 'Keep the output concise.',
  };
}

function generationCommand(projectId: string) {
  return {
    projectId,
    operation: 'GENERATE' as const,
    provider: 'OPENAI' as const,
    model: 'configured-model',
    credentialMode: 'PLATFORM_CREDITS' as const,
    connectionId: null,
    sourcePromptVersionId: null,
    requestMetadata: {},
  };
}

function versionCommand(projectId: string, content: string) {
  return {
    projectId,
    sourceVersionId: null,
    kind: 'UNIVERSAL' as const,
    destination: 'universal',
    content,
    summary: 'Generated prompt summary',
    templateVersion: 'v1',
    reportSchemaVersion: 1,
    provider: 'OPENAI' as const,
    model: 'configured-model',
  };
}

function paidRequest() {
  return {
    provider: 'OPENAI' as const,
    model: 'configured-model',
    credentialMode: 'PLATFORM_CREDITS' as const,
    connectionId: null,
    acceptPlatformCharge: true,
    maximumCostMinor: '100',
  };
}

function registry(): ProviderRegistry {
  return new ProviderRegistry([
    {
      provider: 'OPENAI',
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
      models: ['configured-model'],
      contextWindowTokens: 10_000,
      maxOutputTokens: 2_000,
      supportsStructuredOutput: true,
      supportsCancellation: false,
      supportsCredentialRefresh: false,
      oauthScopes: [],
      previewEligible: true,
      pricingMetadataVersion: 'test-v1',
      enabled: true,
      circuitBreakerOpen: false,
    },
  ]);
}
