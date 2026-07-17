import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Auth0User } from '@extractionstack/shared';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { LlmReconciliationCommand } from './llm-reconciliation.controller';

@Injectable()
export class LlmReconciliationService {
  constructor(private readonly prisma: PrismaClient) {}

  async reconcile(actor: Auth0User, jobId: string, command: LlmReconciliationCommand, key: string) {
    return this.prisma
      .$transaction(async (transaction) => {
        const admin = await transaction.user.findUnique({ where: { auth0Sub: actor.sub } });
        if (!admin)
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'resource not found' });
        const operation = `llm-reconcile:${jobId}`;
        const keyHash = hash(key);
        const requestHash = hash(JSON.stringify(command));
        const existing = await transaction.mutationIdempotency.findUnique({
          where: { ownerId_operation_keyHash: { ownerId: admin.id, operation, keyHash } },
        });
        if (existing) {
          if (existing.requestHash !== requestHash)
            throw new ConflictException({
              code: 'IDEMPOTENCY_CONFLICT',
              message: 'idempotency key conflict',
            });
          return { jobId, status: 'accepted' as const, replayed: true };
        }
        const job = await transaction.promptGenerationJob.findUnique({
          where: { id: jobId },
          include: {
            creditLedgerEntries: { where: { kind: 'RESERVATION', settlement: null }, take: 1 },
          },
        });
        if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'resource not found' });
        const reservation = job.creditLedgerEntries[0];
        if (command.command === 'KNOWN_SNAPSHOT') {
          if (
            job.status !== 'AMBIGUOUS' ||
            job.providerStage !== 'COMPLETED' ||
            !job.providerSnapshot
          )
            throw invalidState();
          await transaction.promptGenerationJob.update({
            where: { id: job.id },
            data: {
              status: 'RUNNING',
              leaseToken: randomUUID(),
              heartbeatAt: new Date(),
              finishedAt: null,
              reconciliationReason: command.reason,
            },
          });
        } else {
          if (job.status !== 'AMBIGUOUS' || !reservation) throw invalidState();
          const reserved = -reservation.amountMinor;
          const actual =
            command.command === 'CONFIRM_ACTUAL_COST' ? BigInt(command.actualCostMinor!) : 0n;
          const maximum = reservationMaximum(reservation.metadata);
          if (actual > maximum)
            throw new BadRequestException({
              code: 'CREDIT_COST_LIMIT_EXCEEDED',
              message: 'actual cost exceeds accepted maximum',
            });
          const kind =
            command.command === 'REVERSE_NOT_CHARGED'
              ? 'REVERSAL'
              : actual === reserved
                ? 'CONFIRMATION'
                : 'ADJUSTMENT';
          const delta = reserved - actual;
          if (kind === 'ADJUSTMENT' && delta === 0n) throw invalidState();
          await transaction.creditLedgerEntry.create({
            data: {
              ownerId: reservation.ownerId,
              jobId: job.id,
              kind,
              amountMinor: delta,
              currency: reservation.currency,
              idempotencyKey: `admin-reconcile:${reservation.id}`,
              reservationId: reservation.id,
              metadata: {
                actualAmountMinor: actual.toString(),
                reason: command.reason,
                evidenceHash: hash(command.evidence),
              },
            },
          });
          await transaction.promptGenerationJob.update({
            where: { id: job.id },
            data: {
              status: 'FAILED',
              errorCode: kind === 'REVERSAL' ? 'RECONCILED_NOT_CHARGED' : 'RECONCILED_ACTUAL_COST',
              errorMessage: 'Generation could not be completed.',
              reconciliationReason: command.reason,
              reconciledAt: new Date(),
            },
          });
        }
        await transaction.auditEvent.create({
          data: {
            actorId: admin.id,
            action: 'llm_job.reconciled',
            entityType: 'PromptGenerationJob',
            entityId: job.id,
            metadata: {
              command: command.command,
              reason: command.reason,
              evidenceHash: hash(command.evidence),
              ownerIdHash: hash(job.ownerId),
            },
          },
        });
        await transaction.mutationIdempotency.create({
          data: {
            ownerId: admin.id,
            operation,
            keyHash,
            requestHash,
            status: 'COMPLETE',
            entityId: job.id,
            publicResult: { jobId, status: 'accepted' },
            completedAt: new Date(),
          },
        });
        return { jobId, status: 'accepted' as const, replayed: false };
      })
      .catch(async (error) => {
        if (
          error instanceof Prisma.PrismaClientKnownRequestError &&
          (error.code === 'P2002' || error.code === 'P2034')
        ) {
          const admin = await this.prisma.user.findUnique({ where: { auth0Sub: actor.sub } });
          const existing = admin
            ? await this.prisma.mutationIdempotency.findUnique({
                where: {
                  ownerId_operation_keyHash: {
                    ownerId: admin.id,
                    operation: `llm-reconcile:${jobId}`,
                    keyHash: hash(key),
                  },
                },
              })
            : null;
          if (existing?.requestHash === hash(JSON.stringify(command)))
            return { jobId, status: 'accepted' as const, replayed: true };
          throw new ConflictException({
            code: 'IDEMPOTENCY_CONFLICT',
            message: 'concurrent reconciliation conflict',
          });
        }
        throw error;
      });
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function invalidState() {
  return new ConflictException({
    code: 'RECONCILIATION_STATE_INVALID',
    message: 'job cannot be reconciled by this command',
  });
}
function reservationMaximum(metadata: Prisma.JsonValue | null): bigint {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw invalidState();
  const raw = (metadata as Record<string, Prisma.JsonValue>).maximumAcceptedAmountMinor;
  if (typeof raw !== 'string') throw invalidState();
  return BigInt(raw);
}
