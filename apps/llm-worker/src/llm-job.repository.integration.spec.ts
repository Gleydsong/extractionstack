import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { CrawledPage, PromptWizardInput } from '@extractionstack/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { buildInvestigationReport } from '../../api/src/extract/investigation-report.builder';
import { LlmJobRepository } from './llm-job.repository';
import type { ClaimedLlmJob, CompletionCommand } from './llm-worker.types';

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
    const command = completion(claimed!, 'request-1', 2n);
    await expect(repository.markProviderStarted(claimed!)).resolves.toBe(true);
    await expect(repository.markProviderCompleted(command)).resolves.toBe(true);
    await repository.complete(command);

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
      actualAmountMinor: null,
      pricingVersion: 'integration-v1',
    });
    expect(await prisma.promptVersion.count({ where: { projectId: fixture.projectId } })).toBe(0);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'CANCEL_REQUESTED' });
  });

  it('dead-letters and reverses an open reservation in one terminal transaction', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.deadLetter(claimed!, 'TIMEOUT');
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'FAILED', errorCode: 'DEAD_LETTER_TIMEOUT' });
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
    await repository.deadLetter(claimed!, 'TIMEOUT');
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
  });

  it('gives a stale claimant zero transition and settlement effects after a new lease wins', async () => {
    const fixture = await createFixture(prisma, true);
    const staleClaim = await repository.claim(fixture.jobId);
    expect(staleClaim).not.toBeNull();
    await prisma.promptGenerationJob.update({
      where: { id: fixture.jobId },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    const currentClaim = await repository.claim(fixture.jobId);
    expect(currentClaim).not.toBeNull();
    expect(currentClaim!.leaseToken).not.toBe(staleClaim!.leaseToken);
    expect(currentClaim!.attempts).toBe(staleClaim!.attempts + 1);

    await expect(repository.heartbeat(staleClaim!)).resolves.toBe(false);
    await expect(repository.markProviderStarted(staleClaim!)).resolves.toBe(false);
    await expect(repository.markRetry(staleClaim!, 'TIMEOUT')).resolves.toBe(false);
    await expect(repository.fail(staleClaim!, 'INTERNAL')).resolves.toBe(false);
    await expect(repository.deadLetter(staleClaim!, 'TIMEOUT')).resolves.toBe(false);
    await expect(repository.markAmbiguous(staleClaim!, 'PERSISTENCE_FAILED')).resolves.toBe(false);
    await expect(repository.cancel(staleClaim!)).resolves.toBe(false);

    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({
      status: 'RUNNING',
      leaseToken: currentClaim!.leaseToken,
      attempts: currentClaim!.attempts,
    });
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(1);
    await expect(repository.deadLetter(currentClaim!, 'TIMEOUT')).resolves.toBe(true);
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(2);
  });

  it('atomically dead-letters and reverses a stale lease that exhausted its database attempts', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await prisma.promptGenerationJob.update({
      where: { id: fixture.jobId },
      data: {
        attempts: claimed!.maxAttempts,
        heartbeatAt: new Date(Date.now() - 10 * 60_000),
      },
    });

    await expect(repository.claim(fixture.jobId)).resolves.toBeNull();
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({
      status: 'FAILED',
      errorCode: 'DEAD_LETTER_WORKER_LEASE_EXPIRED',
      retryable: false,
      leaseToken: null,
    });
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
  });

  it('finalizes a stale normalized provider snapshot without another provider call', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    const command = completion(claimed!, 'paid-request', 2n);
    await repository.markProviderStarted(claimed!);
    await repository.markProviderCompleted(command);
    await prisma.promptGenerationJob.update({
      where: { id: fixture.jobId },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });

    await expect(repository.claim(fixture.jobId)).resolves.toBeNull();
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED', providerStage: 'COMPLETED' });
    expect(
      await prisma.creditLedgerEntry.count({
        where: { jobId: fixture.jobId, kind: 'CONFIRMATION' },
      }),
    ).toBe(1);
  });

  it('holds a stale STARTED reservation until explicit not-run reconciliation', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await prisma.promptGenerationJob.update({
      where: { id: fixture.jobId },
      data: { heartbeatAt: new Date(Date.now() - 10 * 60_000) },
    });
    await expect(repository.claim(fixture.jobId)).resolves.toBeNull();
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'AMBIGUOUS', providerStage: 'STARTED' });
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(1);

    await expect(
      repository.reconcileConfirmedNotRun(fixture.jobId, 'operator confirmed no request'),
    ).resolves.toBe(true);
    await expect(repository.reconcileConfirmedNotRun(fixture.jobId, 'duplicate')).resolves.toBe(
      false,
    );
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'REVERSAL' } }),
    ).toBe(1);
  });

  it('settles an unknown paid outcome once through explicit adjustment', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await repository.markAmbiguous(claimed!, 'LEASE_STATE_UNKNOWN');

    await expect(
      repository.reconcileUnknownPaid(fixture.jobId, 40n, 'provider invoice confirmed'),
    ).resolves.toBe(true);
    await expect(repository.reconcileUnknownPaid(fixture.jobId, 40n, 'duplicate')).resolves.toBe(
      false,
    );
    const adjustment = await prisma.creditLedgerEntry.findFirstOrThrow({
      where: { jobId: fixture.jobId, kind: 'ADJUSTMENT' },
    });
    expect(adjustment.amountMinor).toBe(60n);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'FAILED', errorCode: 'RECONCILED_PAID_UNKNOWN' });
  });

  it('explicitly reconciles a known completed snapshot exactly once', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    const command = completion(claimed!, 'known-request', 2n);
    await repository.markProviderStarted(claimed!);
    await repository.markProviderCompleted(command);
    await repository.markAmbiguous(claimed!, 'PERSISTENCE_FAILED');

    await expect(
      repository.reconcileKnownSnapshot(fixture.jobId, 'operator replayed normalized snapshot'),
    ).resolves.toBe(true);
    await expect(repository.reconcileKnownSnapshot(fixture.jobId, 'duplicate')).resolves.toBe(
      false,
    );
    expect(
      await prisma.creditLedgerEntry.count({
        where: { jobId: fixture.jobId, kind: 'CONFIRMATION' },
      }),
    ).toBe(1);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({
      status: 'SUCCEEDED',
      reconciliationReason: 'operator replayed normalized snapshot',
    });
  });

  it('reconciles a known snapshot safely under concurrent operator commands', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    const command = completion(claimed!, 'concurrent-known-request', 2n);
    await repository.markProviderStarted(claimed!);
    await repository.markProviderCompleted(command);
    await repository.markAmbiguous(claimed!, 'PERSISTENCE_FAILED');

    const results = await Promise.all([
      repository.reconcileKnownSnapshot(fixture.jobId, 'operator command A'),
      repository.reconcileKnownSnapshot(fixture.jobId, 'operator command B'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(
      await prisma.creditLedgerEntry.count({
        where: { jobId: fixture.jobId, kind: 'CONFIRMATION' },
      }),
    ).toBe(1);
    expect(await prisma.llmUsage.count({ where: { jobId: fixture.jobId } })).toBe(1);
  });

  it('uses zero-delta CONFIRMATION when actual cost equals the reservation', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await repository.markAmbiguous(claimed!, 'PROVIDER_OUTCOME_UNKNOWN');
    await expect(
      repository.reconcileUnknownPaid(fixture.jobId, 100n, 'invoice equals reserve'),
    ).resolves.toBe(true);
    const confirmation = await prisma.creditLedgerEntry.findFirstOrThrow({
      where: { jobId: fixture.jobId, kind: 'CONFIRMATION' },
    });
    expect(confirmation.amountMinor).toBe(0n);
    expect(
      await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId, kind: 'ADJUSTMENT' } }),
    ).toBe(0);
  });

  it('rejects actual cost above the accepted maximum and keeps the reservation open', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await repository.markAmbiguous(claimed!, 'PROVIDER_OUTCOME_UNKNOWN');
    await expect(
      repository.reconcileUnknownPaid(fixture.jobId, 101n, 'invoice above accepted maximum'),
    ).rejects.toThrow('CREDIT_COST_LIMIT_EXCEEDED');
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(1);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'AMBIGUOUS' });
  });

  it('keeps a post-STARTED provider failure ambiguous with no second claim', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await repository.markAmbiguous(claimed!, 'PROVIDER_OUTCOME_UNKNOWN');
    await expect(repository.claim(fixture.jobId)).resolves.toBeNull();
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(1);
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'AMBIGUOUS', providerStage: 'STARTED' });
  });

  it('sweeper finalizes COMPLETED without a future queue delivery', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    const command = completion(claimed!, 'swept-request', 2n);
    await repository.markProviderStarted(claimed!);
    await repository.markProviderCompleted(command);
    await expect(repository.sweepRecoverable()).resolves.toMatchObject({ completed: 1 });
    await expect(
      prisma.promptGenerationJob.findUniqueOrThrow({ where: { id: fixture.jobId } }),
    ).resolves.toMatchObject({ status: 'SUCCEEDED' });
  });

  it('does not acknowledge a fresh STARTED recovery as successful delivery', async () => {
    const fixture = await createFixture(prisma, true);
    const claimed = await repository.claim(fixture.jobId);
    await repository.markProviderStarted(claimed!);
    await expect(repository.claim(fixture.jobId)).rejects.toThrow('LLM_RECOVERY_PENDING');
    expect(await prisma.creditLedgerEntry.count({ where: { jobId: fixture.jobId } })).toBe(1);
  });

  it('database rejects invalid provider stage timestamp and snapshot shapes', async () => {
    const fixture = await createFixture(prisma, false);
    await expect(
      prisma.promptGenerationJob.update({
        where: { id: fixture.jobId },
        data: { providerStage: 'STARTED' },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.promptGenerationJob.update({
        where: { id: fixture.jobId },
        data: {
          providerStage: 'COMPLETED',
          providerStartedAt: new Date(),
          providerCompletedAt: new Date(),
        },
      }),
    ).rejects.toThrow();
  });
});

function completion(
  job: ClaimedLlmJob,
  providerRequestId: string,
  actualAmountMinor: bigint | null,
): CompletionCommand {
  return {
    job,
    latencyMs: 42,
    security: { action: 'ALLOW', reasonCodes: [] },
    result: {
      content: 'Prompt natural persistido.',
      finishReason: 'complete',
      providerRequestId,
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15, estimatedCostMicros: null },
    },
    actualAmountMinor,
    pricingVersion: actualAmountMinor === null ? null : 'integration-v1',
  };
}

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
