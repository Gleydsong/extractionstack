import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { CrawledPage, PromptWizardInput } from '@extractionstack/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInvestigationReport } from '../../api/src/extract/investigation-report.builder';
import { LlmJobRepository } from './llm-job.repository';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl ?? 'postgresql://skip:skip@127.0.0.1:1/skip' } },
});

describePostgres('LlmJobRepository PostgreSQL integration', () => {
  const repository = new LlmJobRepository(prisma);
  afterAll(async () => prisma.$disconnect());

  it('claims one duplicate delivery and persists terminal artifacts plus settlement atomically', async () => {
    const fixture = await createFixture(prisma, true);
    const [left, right] = await Promise.all([
      repository.claim(fixture.jobId),
      repository.claim(fixture.jobId),
    ]);
    const claimed = left ?? right;
    expect([left, right].filter(Boolean)).toHaveLength(1);
    expect(claimed).not.toBeNull();
    const context = await repository.loadAuthorizedContext(claimed!);
    expect(context.job.ownerId).toBe(fixture.ownerId);

    await repository.complete({
      job: claimed!,
      latencyMs: 42,
      security: { action: 'ALLOW', reasonCodes: [] },
      result: {
        content: 'Prompt natural persistido.',
        finishReason: 'complete',
        providerRequestId: 'request-1',
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostMicros: 20_000 },
      },
    });

    await expect(repository.claim(fixture.jobId)).resolves.toBeNull();
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
    expect(await prisma.promptVersion.count({ where: { projectId: fixture.projectId } })).toBe(1);
    expect(await prisma.llmUsage.count({ where: { jobId: fixture.jobId } })).toBe(1);
    expect(await prisma.securityDecision.count({ where: { jobId: fixture.jobId } })).toBe(1);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { jobId: fixture.jobId, kind: 'CONFIRMATION' },
      }),
    ).toBe(1);
  });

  it('recovers a stale RUNNING lease but never claims a fresh RUNNING job', async () => {
    const stale = await createFixture(prisma, false);
    await prisma.promptGenerationJob.update({
      where: { id: stale.jobId },
      data: { status: 'RUNNING', startedAt: new Date(Date.now() - 10 * 60_000) },
    });
    await expect(repository.claim(stale.jobId)).resolves.toMatchObject({ id: stale.jobId });
    await expect(repository.claim(stale.jobId)).resolves.toBeNull();
  });

  it('discards completion after cancellation request', async () => {
    const fixture = await createFixture(prisma, false);
    const claimed = await repository.claim(fixture.jobId);
    await prisma.promptGenerationJob.update({
      where: { id: fixture.jobId },
      data: { status: 'CANCEL_REQUESTED' },
    });
    await repository.complete({
      job: claimed!,
      latencyMs: 1,
      security: { action: 'ALLOW', reasonCodes: [] },
      result: {
        content: 'Resultado tardio.',
        finishReason: 'complete',
        providerRequestId: null,
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2, estimatedCostMicros: null },
      },
    });
    expect(await prisma.promptVersion.count({ where: { projectId: fixture.projectId } })).toBe(0);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
  });

  it('dead-letters and reverses an open reservation in one terminal transaction', async () => {
    const fixture = await createFixture(prisma, true);
    await repository.claim(fixture.jobId);
    await repository.deadLetter(fixture.jobId, 'TIMEOUT');
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'FAILED', errorCode: 'DEAD_LETTER_TIMEOUT' });
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
    await repository.deadLetter(fixture.jobId, 'TIMEOUT');
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
  });
});

async function createFixture(client: PrismaClient, withCredits: boolean) {
  const suffix = randomUUID();
  const user = await client.user.create({
    data: { auth0Sub: `auth0|worker-${suffix}`, email: `worker-${suffix}@example.test` },
  });
  const extraction = await client.extractionJob.create({
    data: {
      ownerId: user.id,
      requestedUrl: 'https://example.test',
      normalizedUrl: 'https://example.test/',
      idempotencyKey: `extract:${suffix}`,
      status: 'SUCCEEDED',
      finishedAt: new Date(),
      report: {
        create: {
          schemaVersion: 1,
          finalUrl: 'https://example.test/',
          fetchedAt: new Date(),
          durationMs: 1,
          payload: report(),
        },
      },
    },
  });
  const wizard: PromptWizardInput = {
    extractionId: extraction.id,
    category: 'application',
    objective: 'Build a secure maintainable application',
    audience: 'Developers',
    technologies: ['TypeScript'],
    exclusions: [],
    requirements: ['Strict typing'],
    language: 'en-US',
    detail: 'balanced',
    destination: 'universal',
    freeInstructions: '',
  };
  const project = await client.promptProject.create({
    data: {
      ownerId: user.id,
      extractionId: extraction.id,
      title: 'Worker test',
      category: 'application',
      language: 'en-US',
      wizardInput: wizard,
    },
  });
  const job = await client.promptGenerationJob.create({
    data: {
      ownerId: user.id,
      projectId: project.id,
      operation: 'GENERATE',
      provider: 'OPENAI',
      model: 'gpt-test',
      credentialMode: 'PLATFORM_CREDITS',
      idempotencyKey: `job:${suffix}`,
    },
  });
  if (withCredits) {
    await client.creditLedgerEntry.create({
      data: {
        ownerId: user.id,
        jobId: job.id,
        kind: 'RESERVATION',
        amountMinor: -100n,
        currency: 'CREDITS',
        idempotencyKey: `reserve:${suffix}`,
        metadata: {
          estimatedAmountMinor: '100',
          maximumAcceptedAmountMinor: '100',
          requestHash: '0'.repeat(64),
        },
      },
    });
  }
  return { ownerId: user.id, projectId: project.id, jobId: job.id };
}

function report() {
  const page: CrawledPage = {
    finalUrl: 'https://example.test/',
    status: 200,
    html: '<html><body><h1>Test</h1></body></html>',
    headers: {},
    responseHeaders: {},
    networkLog: [],
    cookies: [],
    meta: { title: 'Test' },
    scripts: [],
    stylesheets: [],
    linkRel: [],
    computedStyles: [],
    fetchedAt: new Date().toISOString(),
  };
  return buildInvestigationReport(page, [], page.finalUrl);
}
