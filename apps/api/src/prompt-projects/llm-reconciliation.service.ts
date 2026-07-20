import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MAXIMUM_COST_MINOR, type Auth0User } from '@extractionstack/shared';
import { Prisma, PrismaClient } from '@prisma/client';
import type { LlmReconciliationCommand } from './llm-reconciliation.controller';

@Injectable()
export class LlmReconciliationService {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async reconcile(actor: Auth0User, jobId: string, command: LlmReconciliationCommand, key: string) {
    return this.prisma
      .$transaction(async (transaction) => {
        const admin = await transaction.user.findUnique({ where: { auth0Sub: actor.sub } });
        if (!admin)
          throw new NotFoundException({ code: 'NOT_FOUND', message: 'resource not found' });
        const locked = await transaction.$queryRaw<Array<{ id: string }>>`
          SELECT "id" FROM "PromptGenerationJob" WHERE "id" = ${jobId} FOR UPDATE
        `;
        if (!locked[0])
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
        const job = await transaction.promptGenerationJob.findUnique({ where: { id: jobId } });
        if (!job) throw new NotFoundException({ code: 'NOT_FOUND', message: 'resource not found' });
        const reservations =
          command.command === 'KNOWN_SNAPSHOT'
            ? []
            : await transaction.creditLedgerEntry.findMany({
                where: {
                  ownerId: job.ownerId,
                  jobId: job.id,
                  currency: 'CREDITS',
                  kind: 'RESERVATION',
                },
                include: { settlement: { select: { id: true } } },
                take: 2,
              });
        const reservation = reservations.length === 1 ? reservations[0] : null;
        if (
          command.command === 'KNOWN_SNAPSHOT' &&
          (job.status !== 'AMBIGUOUS' ||
            job.providerStage !== 'COMPLETED' ||
            !isNormalizedSnapshot(job.providerSnapshot))
        )
          throw invalidState();
        if (
          command.command !== 'KNOWN_SNAPSHOT' &&
          (job.status !== 'AMBIGUOUS' ||
            !reservation ||
            reservation.amountMinor >= 0n ||
            reservation.settlement)
        )
          throw invalidState();
        const mutation = await transaction.mutationIdempotency.create({
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
        if (command.command === 'KNOWN_SNAPSHOT') {
          const updated = await transaction.promptGenerationJob.updateMany({
            where: {
              id: job.id,
              status: 'AMBIGUOUS',
              providerStage: 'COMPLETED',
              reconciliationCommandId: null,
            },
            data: {
              status: 'RUNNING',
              leaseToken: randomUUID(),
              heartbeatAt: new Date(),
              finishedAt: null,
              reconciliationReason: command.reason,
              reconciliationActorId: admin.id,
              reconciliationCommandId: mutation.id,
            },
          });
          if (updated.count !== 1) throw invalidState();
        } else {
          const scopedReservation = reservation!;
          const reserved = -scopedReservation.amountMinor;
          const actual =
            command.command === 'CONFIRM_ACTUAL_COST' ? BigInt(command.actualCostMinor!) : 0n;
          if (actual < 0n || actual > MAXIMUM_COST_MINOR)
            throw new BadRequestException({
              code: 'CREDIT_COST_LIMIT_EXCEEDED',
              message: 'actual cost exceeds the server limit',
            });
          const kind = command.command === 'REVERSE_NOT_CHARGED' ? 'REVERSAL' : 'CONFIRMATION';
          const delta = reserved - actual;
          await transaction.creditLedgerEntry.create({
            data: {
              ownerId: scopedReservation.ownerId,
              jobId: job.id,
              kind,
              amountMinor: delta,
              currency: scopedReservation.currency,
              idempotencyKey: `admin-reconcile:${scopedReservation.id}`,
              reservationId: scopedReservation.id,
              metadata: {
                reservedAmountMinor: reserved.toString(),
                actualAmountMinor: actual.toString(),
                reason: command.reason,
                evidenceHash: hash(command.evidence),
              },
            },
          });
          const updated = await transaction.promptGenerationJob.updateMany({
            where: { id: job.id, status: 'AMBIGUOUS', reconciliationCommandId: null },
            data: {
              status: 'FAILED',
              errorCode: kind === 'REVERSAL' ? 'RECONCILED_NOT_CHARGED' : 'RECONCILED_ACTUAL_COST',
              errorMessage: 'Generation could not be completed.',
              reconciliationReason: command.reason,
              reconciledAt: new Date(),
              reconciliationActorId: admin.id,
              reconciliationCommandId: mutation.id,
            },
          });
          if (updated.count !== 1) throw invalidState();
        }
        await transaction.auditEvent.create({
          data: {
            actorId: admin.id,
            action:
              command.command === 'KNOWN_SNAPSHOT'
                ? 'llm_job.reconciliation_accepted'
                : 'llm_job.reconciliation_completed',
            entityType: 'PromptGenerationJob',
            entityId: job.id,
            metadata: {
              command: command.command,
              reason: command.reason,
              evidenceHash: hash(command.evidence),
              ownerIdHash: hash(job.ownerId),
              outcome: command.command === 'KNOWN_SNAPSHOT' ? 'PENDING' : 'FAILED',
              commandIdHash: hash(mutation.id),
            },
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
function isNormalizedSnapshot(value: Prisma.JsonValue | null): boolean {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (value as Record<string, Prisma.JsonValue>).schemaVersion === 1
  );
}
