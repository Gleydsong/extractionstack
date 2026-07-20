import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma, PrismaClient, type CreditLedgerEntry } from '@prisma/client';
import { loadRuntimeEnv } from '../common/runtime-env.js';

export const CREDITS_REPOSITORY = Symbol('CREDITS_REPOSITORY');
const CURRENCY = 'CREDITS';

export interface ReserveCreditsRecord {
  ownerId: string;
  jobId: string;
  amountMinor: bigint;
  maximumAcceptedAmountMinor: bigint;
  idempotencyKey: string;
  dailyBudgetMinor: bigint;
}

export interface CreditReservationRecord {
  id: string;
  ownerId: string;
  jobId: string;
  amountMinor: bigint;
  maximumAcceptedAmountMinor: bigint;
  createdAt: Date;
}

export interface CreditsRepositoryPort {
  reserve(command: ReserveCreditsRecord): Promise<CreditReservationRecord>;
  confirm(reservationId: string, actualAmountMinor: bigint): Promise<void>;
  reverse(reservationId: string, reason: string): Promise<void>;
  getAvailableBalance(ownerId: string): Promise<bigint>;
}

@Injectable()
export class CreditsRepository implements CreditsRepositoryPort {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async reserve(command: ReserveCreditsRecord): Promise<CreditReservationRecord> {
    return this.prisma.$transaction(async (transaction) => {
      await lockOwner(transaction, command.ownerId);
      const job = await transaction.promptGenerationJob.findFirst({
        where: { id: command.jobId, ownerId: command.ownerId },
        select: { id: true },
      });
      if (!job) throw creditError('CREDIT_SCOPE_INVALID');
      await ensureLocalFakeCredits(transaction, command.ownerId);

      const storedKey = reservationKey(command.ownerId, command.idempotencyKey);
      const requestHash = hash(
        JSON.stringify({
          ownerId: command.ownerId,
          jobId: command.jobId,
          amountMinor: command.amountMinor.toString(),
          maximumAcceptedAmountMinor: command.maximumAcceptedAmountMinor.toString(),
        }),
      );
      const existing = await transaction.creditLedgerEntry.findUnique({
        where: { idempotencyKey: storedKey },
      });
      if (existing) {
        if (reservationRequestHash(existing) !== requestHash) {
          throw creditError('CREDIT_IDEMPOTENCY_CONFLICT');
        }
        return toReservation(existing);
      }

      const balance = await aggregateBalance(transaction, command.ownerId);
      if (balance < command.amountMinor) throw creditError('INSUFFICIENT_CREDITS');
      const committed = await aggregateDailyPlatformCommitment(transaction, command.ownerId);
      if (committed + command.amountMinor > command.dailyBudgetMinor) {
        throw creditError('CREDIT_DAILY_BUDGET_EXCEEDED');
      }

      const entry = await transaction.creditLedgerEntry.create({
        data: {
          ownerId: command.ownerId,
          jobId: command.jobId,
          kind: 'RESERVATION',
          amountMinor: -command.amountMinor,
          currency: CURRENCY,
          idempotencyKey: storedKey,
          metadata: {
            estimatedAmountMinor: command.amountMinor.toString(),
            maximumAcceptedAmountMinor: command.maximumAcceptedAmountMinor.toString(),
            requestHash,
          },
        },
      });
      return toReservation(entry);
    });
  }

  async confirm(reservationId: string, actualAmountMinor: bigint): Promise<void> {
    const scope = await this.reservationScope(reservationId);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await lockOwner(transaction, scope.ownerId);
        const reservation = await findOpenReservation(transaction, reservationId, scope.ownerId);
        const acceptedMaximum = reservationMaximum(reservation);
        if (actualAmountMinor > acceptedMaximum) {
          throw creditError('CREDIT_COST_LIMIT_EXCEEDED');
        }
        const estimated = -reservation.amountMinor;
        await transaction.creditLedgerEntry.create({
          data: {
            ownerId: reservation.ownerId,
            jobId: reservation.jobId,
            kind: 'CONFIRMATION',
            amountMinor: estimated - actualAmountMinor,
            currency: reservation.currency,
            idempotencyKey: `confirm:${reservation.id}`,
            reservationId: reservation.id,
            metadata: {
              estimatedAmountMinor: estimated.toString(),
              actualAmountMinor: actualAmountMinor.toString(),
              maximumAcceptedAmountMinor: acceptedMaximum.toString(),
            },
          },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw creditError('CREDIT_STATE_INVALID');
      throw error;
    }
  }

  async reverse(reservationId: string, reason: string): Promise<void> {
    const scope = await this.reservationScope(reservationId);
    try {
      await this.prisma.$transaction(async (transaction) => {
        await lockOwner(transaction, scope.ownerId);
        const reservation = await findOpenReservation(transaction, reservationId, scope.ownerId);
        const estimated = -reservation.amountMinor;
        await transaction.creditLedgerEntry.create({
          data: {
            ownerId: reservation.ownerId,
            jobId: reservation.jobId,
            kind: 'REVERSAL',
            amountMinor: estimated,
            currency: reservation.currency,
            idempotencyKey: `reverse:${reservation.id}`,
            reservationId: reservation.id,
            metadata: {
              estimatedAmountMinor: estimated.toString(),
              maximumAcceptedAmountMinor: reservationMaximum(reservation).toString(),
              reason,
            },
          },
        });
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) throw creditError('CREDIT_STATE_INVALID');
      throw error;
    }
  }

  async getAvailableBalance(ownerId: string): Promise<bigint> {
    return aggregateBalance(this.prisma, ownerId);
  }

  private async reservationScope(reservationId: string): Promise<{ ownerId: string }> {
    const reservation = await this.prisma.creditLedgerEntry.findFirst({
      where: { id: reservationId, kind: 'RESERVATION' },
      select: { ownerId: true },
    });
    if (!reservation) throw creditError('CREDIT_RESERVATION_NOT_FOUND');
    return reservation;
  }
}

async function ensureLocalFakeCredits(
  transaction: CreditTransaction,
  ownerId: string,
): Promise<void> {
  const env = loadRuntimeEnv(process.env);
  if (env.NODE_ENV === 'production' || !env.AUTH_DEV_MODE || env.LLM_PROVIDER_MODE !== 'fake') {
    return;
  }
  const owner = await transaction.user.findUnique({
    where: { id: ownerId },
    select: { auth0Sub: true },
  });
  if (owner?.auth0Sub !== 'dev|local') return;
  const idempotencyKey = `local-fake-grant:${ownerId}`;
  await transaction.creditLedgerEntry.upsert({
    where: { idempotencyKey },
    update: {},
    create: {
      ownerId,
      kind: 'GRANT',
      amountMinor: BigInt(env.LLM_FAKE_INITIAL_CREDITS_MINOR),
      currency: CURRENCY,
      idempotencyKey,
      metadata: { source: 'local-fake-provider' },
    },
  });
}

type CreditTransaction = Prisma.TransactionClient;
type BalanceReader = Pick<PrismaClient, 'creditLedgerEntry'> | CreditTransaction;

async function lockOwner(transaction: CreditTransaction, ownerId: string): Promise<void> {
  await transaction.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${ownerId}, 0))::text AS "lock"
  `;
}

async function aggregateBalance(reader: BalanceReader, ownerId: string): Promise<bigint> {
  const aggregate = await reader.creditLedgerEntry.aggregate({
    where: { ownerId, currency: CURRENCY },
    _sum: { amountMinor: true },
  });
  return aggregate._sum.amountMinor ?? 0n;
}

async function aggregateDailyPlatformCommitment(
  transaction: CreditTransaction,
  ownerId: string,
): Promise<bigint> {
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  const reservations = await transaction.creditLedgerEntry.findMany({
    where: { ownerId, currency: CURRENCY, kind: 'RESERVATION', createdAt: { gte: start } },
    select: { amountMinor: true, settlement: { select: { amountMinor: true } } },
  });
  return reservations.reduce(
    (total, reservation) =>
      total - (reservation.amountMinor + (reservation.settlement?.amountMinor ?? 0n)),
    0n,
  );
}

async function findOpenReservation(
  transaction: CreditTransaction,
  reservationId: string,
  ownerId: string,
): Promise<CreditLedgerEntry> {
  const reservation = await transaction.creditLedgerEntry.findFirst({
    where: { id: reservationId, ownerId, kind: 'RESERVATION' },
  });
  if (!reservation) throw creditError('CREDIT_RESERVATION_NOT_FOUND');
  const settlement = await transaction.creditLedgerEntry.findUnique({
    where: { reservationId },
    select: { id: true },
  });
  if (settlement) throw creditError('CREDIT_STATE_INVALID');
  return reservation;
}

function toReservation(entry: CreditLedgerEntry): CreditReservationRecord {
  if (entry.kind !== 'RESERVATION' || !entry.jobId || entry.amountMinor >= 0n) {
    throw creditError('CREDIT_STATE_INVALID');
  }
  return {
    id: entry.id,
    ownerId: entry.ownerId,
    jobId: entry.jobId,
    amountMinor: -entry.amountMinor,
    maximumAcceptedAmountMinor: reservationMaximum(entry),
    createdAt: entry.createdAt,
  };
}

function reservationMaximum(entry: CreditLedgerEntry): bigint {
  const value = metadataString(entry, 'maximumAcceptedAmountMinor');
  try {
    const maximum = BigInt(value);
    if (maximum <= 0n || maximum > 1_000_000_000_000n) throw new Error('bounds');
    return maximum;
  } catch {
    throw creditError('CREDIT_STATE_INVALID');
  }
}

function reservationRequestHash(entry: CreditLedgerEntry): string {
  return metadataString(entry, 'requestHash');
}

function metadataString(entry: CreditLedgerEntry, field: string): string {
  const metadata = entry.metadata;
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw creditError('CREDIT_STATE_INVALID');
  }
  const value = (metadata as Record<string, Prisma.JsonValue>)[field];
  if (typeof value !== 'string') throw creditError('CREDIT_STATE_INVALID');
  return value;
}

function reservationKey(ownerId: string, idempotencyKey: string): string {
  return `reserve:${hash(ownerId)}:${hash(idempotencyKey)}`;
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function creditError(code: string): Error {
  return new Error(code);
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
