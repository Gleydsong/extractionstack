import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CreditsRepository } from './credits.repository.js';
import { CreditsService } from './credits.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const prismaUrl = databaseUrl ?? 'postgresql://skip:skip@127.0.0.1:1/skip';
const describePostgres = databaseUrl ? describe : describe.skip;

describePostgres('CreditsRepository PostgreSQL integration', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: prismaUrl } } });
  const repository = new CreditsRepository(prisma);
  const service = new CreditsService(repository);
  let ownerId: string;
  let jobIds: [string, string, string];

  beforeEach(async () => {
    const fixture = await createFixture(prisma);
    ownerId = fixture.ownerId;
    jobIds = fixture.jobIds;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('returns the same reservation for the same command and conflicts when the command changes', async () => {
    const [first, second] = await Promise.all([
      service.reserve(ownerId, jobIds[0], 100n, 'same-command'),
      service.reserve(ownerId, jobIds[0], 100n, 'same-command'),
    ]);

    expect(second).toEqual(first);
    await expect(service.reserve(ownerId, jobIds[0], 101n, 'same-command')).rejects.toThrow(
      'CREDIT_IDEMPOTENCY_CONFLICT',
    );
    expect(await ledgerCount(prisma, ownerId, 'RESERVATION')).toBe(1);
  });

  it('serializes concurrent reservations so available credits cannot be overspent', async () => {
    const outcomes = await Promise.allSettled([
      service.reserve(ownerId, jobIds[0], 800n, 'concurrent-left'),
      service.reserve(ownerId, jobIds[1], 800n, 'concurrent-right'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === 'rejected');
    expect(rejected).toMatchObject({
      reason: expect.objectContaining({ message: 'INSUFFICIENT_CREDITS' }),
    });
    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('200');
    expect(await ledgerCount(prisma, ownerId, 'RESERVATION')).toBe(1);
  });

  it('rejects overspend and rolls the whole transaction back', async () => {
    await expect(service.reserve(ownerId, jobIds[0], 1_001n, 'too-large')).rejects.toThrow(
      'INSUFFICIENT_CREDITS',
    );

    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('1000');
    expect(await ledgerCount(prisma, ownerId, 'RESERVATION')).toBe(0);
  });

  it('stores strict reservation metadata and applies positive, zero, and negative confirmation deltas', async () => {
    const below = await service.reserve(ownerId, jobIds[0], 100n, 'below');
    await service.confirm(below.id, 80n);
    const exact = await service.reserve(ownerId, jobIds[1], 100n, 'exact');
    await service.confirm(exact.id, 100n);
    const above = await service.reserve(ownerId, jobIds[2], 100n, 'above', 150n);
    await service.confirm(above.id, 120n);

    const reservations = await prisma.creditLedgerEntry.findMany({
      where: { id: { in: [below.id, exact.id, above.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(reservations.map((entry) => entry.metadata)).toEqual([
      expect.objectContaining({ estimatedAmountMinor: '100', maximumAcceptedAmountMinor: '100' }),
      expect.objectContaining({ estimatedAmountMinor: '100', maximumAcceptedAmountMinor: '100' }),
      expect.objectContaining({ estimatedAmountMinor: '100', maximumAcceptedAmountMinor: '150' }),
    ]);
    const confirmations = await prisma.creditLedgerEntry.findMany({
      where: { reservationId: { in: [below.id, exact.id, above.id] } },
      orderBy: { createdAt: 'asc' },
    });
    expect(confirmations.map((entry) => entry.amountMinor)).toEqual([20n, 0n, -20n]);
    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('700');
  });

  it('rejects actual cost above the accepted maximum without settling the reservation', async () => {
    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'ceiling', 120n);

    await expect(service.confirm(reservation.id, 121n)).rejects.toThrow(
      'CREDIT_COST_LIMIT_EXCEEDED',
    );
    expect(await prisma.creditLedgerEntry.count({ where: { reservationId: reservation.id } })).toBe(
      0,
    );
    await service.confirm(reservation.id, 120n);
    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('880');
  });

  it('allows exactly one settlement when confirmation and reversal race', async () => {
    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'race');
    const outcomes = await Promise.allSettled([
      service.confirm(reservation.id, 80n),
      service.reverse(reservation.id, 'provider request failed'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(await prisma.creditLedgerEntry.count({ where: { reservationId: reservation.id } })).toBe(
      1,
    );
  });

  it('cannot settle a reservation twice and reversal releases the full reservation', async () => {
    const confirmed = await service.reserve(ownerId, jobIds[0], 100n, 'confirm-once');
    await service.confirm(confirmed.id, 80n);
    await expect(service.confirm(confirmed.id, 80n)).rejects.toThrow('CREDIT_STATE_INVALID');

    const reversed = await service.reserve(ownerId, jobIds[1], 200n, 'reverse-once');
    await service.reverse(reversed.id, 'cancelled');
    await expect(service.reverse(reversed.id, 'cancelled')).rejects.toThrow('CREDIT_STATE_INVALID');
    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('920');
  });

  it('rejects owner/job mismatch without writing a ledger entry', async () => {
    const other = await createFixture(prisma);

    await expect(service.reserve(ownerId, other.jobIds[0], 50n, 'wrong-owner')).rejects.toThrow(
      'CREDIT_SCOPE_INVALID',
    );
    expect(await ledgerCount(prisma, ownerId, 'RESERVATION')).toBe(0);
  });

  it('has a database constraint that rejects invalid settlement targets and cross-scope rows', async () => {
    const other = await createFixture(prisma);
    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'db-scope');

    await expect(
      prisma.creditLedgerEntry.create({
        data: {
          ownerId,
          jobId: jobIds[0],
          kind: 'CONFIRMATION',
          amountMinor: 0n,
          currency: 'CREDITS',
          idempotencyKey: `invalid-target:${randomUUID()}`,
          reservationId: other.grantId,
        },
      }),
    ).rejects.toThrow();
    await expect(
      prisma.creditLedgerEntry.create({
        data: {
          ownerId: other.ownerId,
          jobId: other.jobIds[0],
          kind: 'REVERSAL',
          amountMinor: 100n,
          currency: 'CREDITS',
          idempotencyKey: `invalid-scope:${randomUUID()}`,
          reservationId: reservation.id,
        },
      }),
    ).rejects.toThrow();
    expect(await prisma.creditLedgerEntry.count({ where: { reservationId: reservation.id } })).toBe(
      0,
    );
  });

  it('exposes only append and read operations and never mutates or deletes entries', async () => {
    expect(Reflect.has(repository, 'update')).toBe(false);
    expect(Reflect.has(repository, 'delete')).toBe(false);
    expect(Reflect.has(repository, 'deleteMany')).toBe(false);

    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'append-only');
    const before = await prisma.creditLedgerEntry.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    await service.confirm(reservation.id, 90n);
    const after = await prisma.creditLedgerEntry.findUniqueOrThrow({
      where: { id: reservation.id },
    });
    expect(after).toEqual(before);
    expect(await prisma.creditLedgerEntry.count({ where: { ownerId } })).toBe(3);
  });

  it('rejects direct update and delete of every ledger entry with a stable constraint error', async () => {
    await expectAppendOnlyRejection(
      prisma.creditLedgerEntry.update({
        where: { id: (await prisma.creditLedgerEntry.findFirstOrThrow({ where: { ownerId } })).id },
        data: { amountMinor: 999n },
      }),
    );
    await expectAppendOnlyRejection(
      prisma.creditLedgerEntry.delete({ where: { id: (await createFixture(prisma)).grantId } }),
    );
  });

  it('rejects owner, job, currency, and kind mutation of a settled reservation', async () => {
    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'immutable-settled');
    await service.confirm(reservation.id, 90n);
    const other = await createFixture(prisma);

    await expectAppendOnlyRejection(
      prisma.creditLedgerEntry.update({
        where: { id: reservation.id },
        data: {
          ownerId: other.ownerId,
          jobId: other.jobIds[0],
          currency: 'USD',
          kind: 'GRANT',
        },
      }),
    );
    expect(
      await prisma.creditLedgerEntry.findUniqueOrThrow({ where: { id: reservation.id } }),
    ).toMatchObject({
      ownerId,
      jobId: jobIds[0],
      currency: 'CREDITS',
      kind: 'RESERVATION',
    });
  });

  it('cannot commit an inconsistent pair when settlement races a target update', async () => {
    const reservation = await service.reserve(ownerId, jobIds[0], 100n, 'settlement-update-race');
    const outcomes = await Promise.allSettled([
      service.confirm(reservation.id, 90n),
      prisma.creditLedgerEntry.update({
        where: { id: reservation.id },
        data: { currency: 'USD' },
      }),
    ]);

    expect(outcomes[0]).toMatchObject({ status: 'fulfilled' });
    expect(outcomes[1]).toMatchObject({ status: 'rejected' });
    if (outcomes[1]?.status !== 'rejected') throw new Error('expected target update rejection');
    expectAppendOnlyError(outcomes[1].reason);
    expect(
      await prisma.creditLedgerEntry.findUniqueOrThrow({ where: { id: reservation.id } }),
    ).toMatchObject({
      currency: 'CREDITS',
    });
    expect(await prisma.creditLedgerEntry.count({ where: { reservationId: reservation.id } })).toBe(
      1,
    );
  });
});

async function createFixture(
  prisma: PrismaClient,
): Promise<{ ownerId: string; jobIds: [string, string, string]; grantId: string }> {
  const suffix = randomUUID();
  const owner = await prisma.user.create({ data: { auth0Sub: `auth0|credits-${suffix}` } });
  const extraction = await prisma.extractionJob.create({
    data: {
      ownerId: owner.id,
      requestedUrl: 'https://credits.example.test',
      normalizedUrl: 'https://credits.example.test/',
      idempotencyKey: `credits-${suffix}`,
    },
  });
  const project = await prisma.promptProject.create({
    data: {
      ownerId: owner.id,
      extractionId: extraction.id,
      title: 'Credits fixture',
      category: 'TEST',
      language: 'en',
      wizardInput: {},
    },
  });
  const jobs = await Promise.all(
    [0, 1, 2].map((index) =>
      prisma.promptGenerationJob.create({
        data: {
          ownerId: owner.id,
          projectId: project.id,
          operation: 'GENERATE',
          provider: 'FAKE',
          model: 'fake-v1',
          credentialMode: 'PLATFORM_CREDITS',
          idempotencyKey: `job-${index}-${suffix}`,
        },
      }),
    ),
  );
  const grant = await prisma.creditLedgerEntry.create({
    data: {
      ownerId: owner.id,
      kind: 'GRANT',
      amountMinor: 1_000n,
      currency: 'CREDITS',
      idempotencyKey: `grant:${suffix}`,
      metadata: { source: 'integration-fixture' },
    },
  });
  return {
    ownerId: owner.id,
    jobIds: [jobs[0]!.id, jobs[1]!.id, jobs[2]!.id],
    grantId: grant.id,
  };
}

async function ledgerCount(
  prisma: PrismaClient,
  ownerId: string,
  kind: 'RESERVATION',
): Promise<number> {
  return prisma.creditLedgerEntry.count({ where: { ownerId, kind } });
}

async function expectAppendOnlyRejection(operation: Promise<unknown>): Promise<void> {
  try {
    await operation;
    throw new Error('expected append-only rejection');
  } catch (error) {
    expectAppendOnlyError(error);
  }
}

function expectAppendOnlyError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  expect(message).toContain('code: "23514"');
  expect(message).toContain('credit ledger entries are append-only');
}
