import { createHash, randomUUID } from 'node:crypto';
import {
  InvestigationReportSchema,
  PromptVersionSchema,
  PromptWizardInputSchema,
  type LlmProvider,
} from '@extractionstack/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import {
  NormalizedGenerationSchema,
  NormalizedPreviewSchema,
  type CredentialStorePort,
  type StoredProviderCredential,
} from '@extractionstack/llm-core';
import type {
  AuthorizedLlmContext,
  ClaimedLlmJob,
  CompletionCommand,
  LlmJobStorePort,
} from './llm-worker.types';
import {
  classifyRecoveryError,
  PermanentRecoveryError,
  sanitizedRecoveryCode,
} from './llm-recovery-error';

const STALE_RUNNING_MS = 5 * 60 * 1_000;
const RECOVERY_LEASE_MS = 30_000;
const MAX_ERROR_CODE = 64;
const SnapshotSchema = z
  .object({
    schemaVersion: z.literal(1),
    result: z.union([NormalizedGenerationSchema, NormalizedPreviewSchema]),
    security: z
      .object({
        action: z.enum(['ALLOW', 'REDACT', 'BLOCK']),
        reasonCodes: z
          .array(
            z.enum([
              'SENSITIVE_HEADER_VALUE',
              'SECRET_LIKE_VALUE',
              'SOURCE_DELIMITER_ESCAPE',
              'INSTRUCTION_LIKE_CONTENT',
            ]),
          )
          .max(16),
      })
      .strict(),
    latencyMs: z.number().int().nonnegative().max(2_147_483_647),
    actualAmountMinor: z
      .string()
      .regex(/^(0|[1-9][0-9]{0,18})$/)
      .nullable(),
    pricingVersion: z.string().min(1).max(64).nullable(),
  })
  .strict();
const MetadataSchema = z
  .object({
    destination: z
      .enum(['codex', 'chatgpt', 'claude', 'gemini', 'cursor', 'lovable', 'bolt'])
      .optional(),
  })
  .strict();

export class LlmJobRepository implements LlmJobStorePort, CredentialStorePort {
  constructor(private readonly prisma: PrismaClient) {}

  async claim(jobId: string): Promise<ClaimedLlmJob | null> {
    const now = new Date();
    await this.recoverCompletedDelivery(jobId, now);
    const pending = await this.prisma.promptGenerationJob.findFirst({
      where: { id: jobId, status: 'RUNNING' },
      select: { id: true },
    });
    if (pending) throw new Error('LLM_RECOVERY_PENDING');
    const leaseToken = randomUUID();
    const rows = await this.prisma.$queryRaw<
      Array<{
        id: string;
        ownerId: string;
        projectId: string;
        operation: string;
        provider: string;
        model: string;
        credentialMode: string;
        connectionId: string | null;
        sourcePromptVersionId: string | null;
        attempts: number;
        maxAttempts: number;
        leaseToken: string;
      }>
    >`
      UPDATE "PromptGenerationJob"
      SET "status" = 'RUNNING'::"PromptJobStatus",
          "startedAt" = ${now},
          "heartbeatAt" = ${now},
          "leaseToken" = ${leaseToken}::uuid,
          "attempts" = "attempts" + 1,
          "errorCode" = NULL,
          "errorMessage" = NULL,
          "retryable" = NULL,
          "updatedAt" = ${now}
      WHERE "id" = ${jobId}
        AND "attempts" < "maxAttempts"
        AND "recoveryLeaseToken" IS NULL
        AND "providerStage" = 'NOT_STARTED'::"ProviderExecutionStage"
        AND "status" = 'QUEUED'::"PromptJobStatus"
      RETURNING "id", "ownerId", "projectId", "operation", "provider", "model",
                "credentialMode", "connectionId", "sourcePromptVersionId", "attempts", "maxAttempts", "leaseToken"::text
    `;
    return rows[0] ? claimedJob(rows[0]) : null;
  }

  async loadAuthorizedContext(job: ClaimedLlmJob): Promise<AuthorizedLlmContext> {
    const row = await this.prisma.promptGenerationJob.findFirst({
      where: {
        id: job.id,
        ownerId: job.ownerId,
        projectId: job.projectId,
        status: 'RUNNING',
        leaseToken: job.leaseToken,
        attempts: job.attempts,
        project: { ownerId: job.ownerId, state: 'ACTIVE', extraction: { ownerId: job.ownerId } },
      },
      include: {
        project: { include: { extraction: { include: { report: true } } } },
        sourcePromptVersion: true,
        creditLedgerEntries: {
          where: { kind: 'RESERVATION', settlement: null },
          select: { id: true, metadata: true },
          take: 1,
        },
      },
    });
    if (!row?.project.extraction.report) throw new Error('WORKER_SCOPE_INVALID');
    if (row.sourcePromptVersion && row.sourcePromptVersion.projectId !== row.projectId) {
      throw new Error('WORKER_SCOPE_INVALID');
    }
    const wizard = PromptWizardInputSchema.parse(row.project.wizardInput);
    const metadata = MetadataSchema.parse(row.requestMetadata);
    const effectiveWizard = metadata.destination
      ? PromptWizardInputSchema.parse({ ...wizard, destination: metadata.destination })
      : wizard;
    return Object.freeze({
      job,
      wizard: effectiveWizard,
      report: InvestigationReportSchema.parse(row.project.extraction.report.payload),
      sourcePrompt: row.sourcePromptVersion ? publicVersion(row.sourcePromptVersion) : null,
      reservationId: row.creditLedgerEntries[0]?.id ?? null,
      maximumAcceptedAmountMinor: row.creditLedgerEntries[0]
        ? reservationMaximum(row.creditLedgerEntries[0].metadata)
        : null,
    });
  }

  async isCancellationRequested(job: ClaimedLlmJob): Promise<boolean> {
    const row = await this.prisma.promptGenerationJob.findUnique({
      where: { id: job.id },
      select: { status: true, leaseToken: true, attempts: true },
    });
    return (
      !row ||
      row.leaseToken !== job.leaseToken ||
      row.attempts !== job.attempts ||
      row.status === 'CANCEL_REQUESTED' ||
      row.status === 'CANCELLED'
    );
  }

  async heartbeat(job: ClaimedLlmJob): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: leaseWhere(job, ['RUNNING']),
      data: { heartbeatAt: new Date() },
    });
    return updated.count === 1;
  }

  async markProviderStarted(job: ClaimedLlmJob): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: { ...leaseWhere(job, ['RUNNING']), providerStage: 'NOT_STARTED' },
      data: { providerStage: 'STARTED', providerStartedAt: new Date() },
    });
    return updated.count === 1;
  }

  async markProviderCompleted(command: CompletionCommand): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: { ...leaseWhere(command.job, ['RUNNING']), providerStage: 'STARTED' },
      data: {
        providerStage: 'COMPLETED',
        providerCompletedAt: new Date(),
        providerRequestId: command.result.providerRequestId,
        providerSnapshot: snapshotJson(command),
      },
    });
    return updated.count === 1;
  }

  async complete(
    command: CompletionCommand,
    recoveryToken?: string,
    reconciliationReason?: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.promptGenerationJob.findFirst({
        where: {
          id: command.job.id,
          ownerId: command.job.ownerId,
          projectId: command.job.projectId,
          status: 'RUNNING',
          leaseToken: command.job.leaseToken,
          attempts: command.job.attempts,
          providerCompletedAt: { not: null },
          providerStage: 'COMPLETED',
          ...(recoveryToken ? { recoveryLeaseToken: recoveryToken } : {}),
        },
        include: {
          creditLedgerEntries: { where: { kind: 'RESERVATION', settlement: null }, take: 1 },
        },
      });
      if (!current) return false;
      if (!current.providerSnapshot) throw new Error('PROVIDER_SNAPSHOT_MISSING');
      command = commandFromSnapshot(command.job, current.providerSnapshot);

      let resultPromptVersionId: string | null = null;
      if (current.operation === 'PREVIEW') {
        if (!current.sourcePromptVersionId || !('summary' in command.result))
          throw new Error('WORKER_RESULT_INVALID');
        await transaction.promptPreview.create({
          data: {
            promptVersionId: current.sourcePromptVersionId,
            jobId: current.id,
            status: 'SUCCEEDED',
            content: command.result.content,
            summary: command.result.summary,
            provider: current.provider,
            model: current.model,
            finishReason: command.result.finishReason,
            latencyMs: command.latencyMs,
            completedAt: new Date(),
          },
        });
      } else {
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${current.projectId}, 0))::text AS "lock"`;
        const latest = await transaction.promptVersion.aggregate({
          where: { projectId: current.projectId },
          _max: { sequence: true },
        });
        const metadata = MetadataSchema.parse(current.requestMetadata);
        const version = await transaction.promptVersion.create({
          data: {
            projectId: current.projectId,
            sequence: (latest._max.sequence ?? 0) + 1,
            sourceVersionId: current.sourcePromptVersionId,
            kind: current.operation === 'ADAPT' ? 'ADAPTED' : 'UNIVERSAL',
            destination: metadata.destination ?? 'universal',
            content: command.result.content,
            metadata: { summary: summarize(command.result.content) },
            contentHash: hash(command.result.content),
            templateVersion: 'prompt-v1',
            reportSchemaVersion: 1,
            provider: current.provider,
            model: current.model,
          },
        });
        resultPromptVersionId = version.id;
        await transaction.promptProject.update({
          where: { id: current.projectId },
          data: { currentVersionId: version.id },
        });
      }

      await transaction.llmUsage.create({
        data: {
          jobId: current.id,
          provider: current.provider,
          model: current.model,
          credentialMode: current.credentialMode,
          inputTokens: command.result.usage.inputTokens,
          outputTokens: command.result.usage.outputTokens,
          totalTokens: command.result.usage.totalTokens,
          cachedTokens: command.result.usage.cachedInputTokens,
          estimatedAmountMinor: command.actualAmountMinor,
          confirmedAmountMinor: command.actualAmountMinor,
          currency: current.credentialMode === 'PLATFORM_CREDITS' ? 'CREDITS' : null,
          pricingVersion: command.pricingVersion,
          providerRequestId: command.result.providerRequestId,
        },
      });
      await transaction.securityDecision.createMany({
        data: (command.security.reasonCodes.length ? command.security.reasonCodes : ['NONE']).map(
          (reasonCode) => ({
            jobId: current.id,
            decisionType: 'PROMPT_INPUT',
            action: command.security.action,
            policyVersion: 'prompt-safety-v1',
            reasonCode,
            metadata: {},
          }),
        ),
      });

      const reservation = current.creditLedgerEntries[0];
      if (reservation) {
        if (command.actualAmountMinor === null || command.pricingVersion === null)
          throw new Error('PRICING_USAGE_INSUFFICIENT');
        const actual = command.actualAmountMinor;
        const estimated = -reservation.amountMinor;
        const maximum = reservationMaximum(reservation.metadata);
        if (actual > maximum) throw new Error('CREDIT_COST_LIMIT_EXCEEDED');
        await transaction.creditLedgerEntry.create({
          data: {
            ownerId: current.ownerId,
            jobId: current.id,
            kind: 'CONFIRMATION',
            amountMinor: estimated - actual,
            currency: reservation.currency,
            idempotencyKey: `confirm:${reservation.id}`,
            reservationId: reservation.id,
            metadata: {
              estimatedAmountMinor: estimated.toString(),
              actualAmountMinor: actual.toString(),
              maximumAcceptedAmountMinor: maximum.toString(),
            },
          },
        });
      }
      const updated = await transaction.promptGenerationJob.updateMany({
        where: {
          ...leaseWhere(command.job, ['RUNNING']),
          ...(recoveryToken ? { recoveryLeaseToken: recoveryToken } : {}),
        },
        data: {
          status: 'SUCCEEDED',
          resultPromptVersionId,
          finishedAt: new Date(),
          retryable: false,
          leaseToken: null,
          heartbeatAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          ...(reconciliationReason
            ? { reconciliationReason, reconciledAt: new Date() }
            : {}),
        },
      });
      if (updated.count !== 1) throw new Error('WORKER_STATE_CHANGED');
      if (current.reconciliationActorId && current.reconciliationCommandId) {
        await transaction.auditEvent.create({
          data: {
            actorId: current.reconciliationActorId,
            action: 'llm_job.reconciliation_completed',
            entityType: 'PromptGenerationJob',
            entityId: current.id,
            metadata: {
              outcome: 'SUCCEEDED',
              commandIdHash: hash(current.reconciliationCommandId),
            },
          },
        });
      }
      return true;
    });
  }

  async markRetry(job: ClaimedLlmJob, errorCode: string): Promise<boolean> {
    return this.transition(job, errorCode);
  }
  async fail(job: ClaimedLlmJob, errorCode: string): Promise<boolean> {
    return this.terminalTransition(job, 'FAILED', errorCode, 'generation failed');
  }
  async deadLetter(job: ClaimedLlmJob, errorCode: string): Promise<boolean> {
    return this.terminalTransition(
      job,
      'FAILED',
      `DEAD_LETTER_${errorCode}`.slice(0, MAX_ERROR_CODE),
      'generation retries exhausted',
    );
  }
  async markAmbiguous(job: ClaimedLlmJob, errorCode: string): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: leaseWhere(job, ['RUNNING', 'CANCEL_REQUESTED']),
      data: {
        status: 'AMBIGUOUS',
        errorCode: safeCode(errorCode),
        errorMessage: null,
        retryable: false,
        finishedAt: new Date(),
        leaseToken: null,
        heartbeatAt: null,
        reconciliationReason: 'provider outcome requires explicit reconciliation',
      },
    });
    return updated.count === 1;
  }
  async cancel(job: ClaimedLlmJob): Promise<boolean> {
    return this.terminalTransition(job, 'CANCELLED', null, 'generation cancelled');
  }
  async reject(job: ClaimedLlmJob, reasonCode: string): Promise<boolean> {
    return this.fail(job, `SAFETY_${safeCode(reasonCode)}`);
  }

  async load(connectionId: string): Promise<StoredProviderCredential | null> {
    const connection = await this.prisma.aiConnection.findUnique({
      where: { id: connectionId },
      include: {
        owner: { select: { auth0Sub: true } },
        credentials: { where: { deletedAt: null }, orderBy: { version: 'desc' }, take: 1 },
      },
    });
    const credential = connection?.credentials[0];
    if (!connection || !credential || connection.credentialMode === 'PLATFORM_CREDITS') return null;
    return Object.freeze({
      ownerId: connection.ownerId,
      encryptionOwnerId: connection.owner.auth0Sub,
      provider: connection.provider,
      credentialMode: connection.credentialMode,
      credentialVersion: credential.version,
      state: connection.state,
      expiresAt: connection.expiresAt,
      encryptedCredential: Object.freeze({
        ciphertext: Buffer.from(credential.ciphertext),
        encryptedDataKey: Buffer.from(credential.encryptedDataKey),
        algorithm: credential.algorithm,
        keyVersion: credential.keyVersion,
        authenticatedMetadata: credential.authenticatedMetadata,
      }),
    });
  }

  private async transition(job: ClaimedLlmJob, errorCode: string): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: leaseWhere(job, ['RUNNING']),
      data: {
        status: 'QUEUED',
        errorCode: safeCode(errorCode),
        errorMessage: publicMessage('QUEUED'),
        retryable: true,
        startedAt: null,
        heartbeatAt: null,
        leaseToken: null,
      },
    });
    return updated.count === 1;
  }

  private async terminalTransition(
    job: ClaimedLlmJob,
    status: 'FAILED' | 'CANCELLED',
    errorCode: string | null,
    reversalReason: string,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.promptGenerationJob.updateMany({
        where: leaseWhere(job, ['RUNNING', 'CANCEL_REQUESTED']),
        data: {
          status,
          errorCode: errorCode ? safeCode(errorCode) : null,
          errorMessage: status === 'FAILED' ? publicMessage(status) : null,
          retryable: false,
          finishedAt: new Date(),
          leaseToken: null,
          heartbeatAt: null,
        },
      });
      if (updated.count !== 1) return false;
      const reservation = await transaction.creditLedgerEntry.findFirst({
        where: { jobId: job.id, kind: 'RESERVATION', settlement: null },
      });
      if (!reservation) return true;
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
            maximumAcceptedAmountMinor: reservationMaximum(reservation.metadata).toString(),
            reason: reversalReason,
          },
        },
      });
      return true;
    });
  }

  private async finalizeStartedRecovery(jobId: string, recoveryToken: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.promptGenerationJob.findFirst({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'STARTED',
          recoveryLeaseToken: recoveryToken,
        },
      });
      if (!current) return false;
      const updated = await transaction.promptGenerationJob.updateMany({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'STARTED',
          recoveryLeaseToken: recoveryToken,
        },
        data: {
          status: 'AMBIGUOUS',
          errorCode: 'PROVIDER_OUTCOME_UNKNOWN',
          errorMessage: null,
          retryable: false,
          finishedAt: new Date(),
          leaseToken: null,
          heartbeatAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          reconciliationReason: 'stale STARTED provider execution requires explicit reconciliation',
        },
      });
      if (updated.count !== 1) return false;
      await this.createFinalRecoveryAudit(transaction, current, 'AMBIGUOUS');
      return true;
    });
  }

  private async requeueNotStartedRecovery(
    jobId: string,
    recoveryToken: string,
  ): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: {
        id: jobId,
        status: 'RUNNING',
        providerStage: 'NOT_STARTED',
        recoveryLeaseToken: recoveryToken,
      },
      data: {
        status: 'QUEUED',
        errorCode: 'RECOVERY_ENQUEUE_PENDING',
        errorMessage: 'Generation will be retried.',
        retryable: true,
        startedAt: null,
        heartbeatAt: null,
        leaseToken: null,
      },
    });
    return updated.count === 1;
  }

  private async failNotStartedRecovery(jobId: string, recoveryToken: string): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.promptGenerationJob.findFirst({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'NOT_STARTED',
          recoveryLeaseToken: recoveryToken,
        },
        include: {
          creditLedgerEntries: { where: { kind: 'RESERVATION', settlement: null }, take: 1 },
        },
      });
      if (!current || current.attempts < current.maxAttempts) return false;
      const updated = await transaction.promptGenerationJob.updateMany({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'NOT_STARTED',
          recoveryLeaseToken: recoveryToken,
        },
        data: {
          status: 'FAILED',
          errorCode: 'DEAD_LETTER_WORKER_LEASE_EXPIRED',
          errorMessage: 'Generation could not be completed.',
          retryable: false,
          finishedAt: new Date(),
          leaseToken: null,
          heartbeatAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          reconciliationReason: 'stale NOT_STARTED worker exhausted attempts',
        },
      });
      if (updated.count !== 1) return false;
      const reservation = current.creditLedgerEntries[0];
      if (reservation) {
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
              maximumAcceptedAmountMinor: reservationMaximum(reservation.metadata).toString(),
              reason: 'unclaimable stale worker lease reconciled',
            },
          },
        });
      }
      await this.createFinalRecoveryAudit(transaction, current, 'FAILED');
      return true;
    });
  }

  async reconcileKnownSnapshot(jobId: string, reason: string): Promise<boolean> {
    if (!reason.trim() || reason.length > 500) throw new Error('RECONCILIATION_REASON_INVALID');
    await this.prisma.promptGenerationJob.updateMany({
      where: { id: jobId, status: 'AMBIGUOUS', providerStage: 'COMPLETED' },
      data: {
        status: 'RUNNING',
        leaseToken: randomUUID(),
        heartbeatAt: new Date(),
        finishedAt: null,
      },
    });
    try {
      return await this.recoverCompletedSnapshot(jobId, new Date(Date.now() + 1_000), reason);
    } catch (error) {
      if (classifyRecoveryError(error) === 'IDEMPOTENT') return false;
      throw error;
    }
  }

  async reconcileConfirmedNotRun(jobId: string, reason: string): Promise<boolean> {
    return this.reconcileWithSettlement(jobId, null, reason);
  }

  async reconcileUnknownPaid(
    jobId: string,
    actualAmountMinor: bigint,
    reason: string,
  ): Promise<boolean> {
    if (actualAmountMinor <= 0n) throw new Error('RECONCILIATION_AMOUNT_INVALID');
    return this.reconcileWithSettlement(jobId, actualAmountMinor, reason);
  }

  async sweepRecoverable(batchSize = 50): Promise<
    Readonly<{
      completed: number;
      ambiguous: number;
      requeued: number;
      failed: number;
      deliveries: ReadonlyArray<Readonly<{ jobId: string; recoveryToken: string }>>;
    }>
  > {
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100)
      throw new Error('SWEEP_BATCH_INVALID');
    const now = new Date();
    const staleBefore = new Date(Date.now() - STALE_RUNNING_MS);
    const recoveryToken = randomUUID();
    const recoveryLeaseExpiresAt = new Date(now.getTime() + RECOVERY_LEASE_MS);
    const rows = await this.prisma.$transaction(
      (transaction) =>
        transaction.$queryRaw<
          Array<{
            id: string;
            status: 'RUNNING' | 'QUEUED';
            providerStage: 'NOT_STARTED' | 'STARTED' | 'COMPLETED';
            attempts: number;
            maxAttempts: number;
          }>
        >`
        WITH candidates AS (
          SELECT "id"
          FROM "PromptGenerationJob"
          WHERE ("recoveryLeaseExpiresAt" IS NULL OR "recoveryLeaseExpiresAt" < ${now})
            AND (
              (
                "status" = 'RUNNING'::"PromptJobStatus"
                AND (
                  "providerStage" = 'COMPLETED'::"ProviderExecutionStage"
                  OR (
                    "providerStage" IN ('STARTED', 'NOT_STARTED')
                    AND COALESCE("heartbeatAt", "startedAt") < ${staleBefore}
                  )
                )
              )
              OR (
                "status" = 'QUEUED'::"PromptJobStatus"
                AND "providerStage" = 'NOT_STARTED'::"ProviderExecutionStage"
                AND "errorCode" = 'RECOVERY_ENQUEUE_PENDING'
              )
            )
          ORDER BY "updatedAt" ASC
          LIMIT ${batchSize}
          FOR UPDATE SKIP LOCKED
        )
        UPDATE "PromptGenerationJob" AS job
        SET "recoveryLeaseToken" = ${recoveryToken}::uuid,
            "recoveryLeaseExpiresAt" = ${recoveryLeaseExpiresAt},
            "updatedAt" = ${now}
        FROM candidates
        WHERE job."id" = candidates."id"
        RETURNING job."id", job."status"::text AS "status",
                  job."providerStage"::text AS "providerStage",
                  job."attempts", job."maxAttempts"
      `,
    );
    let completed = 0;
    let ambiguous = 0;
    let requeued = 0;
    let failed = 0;
    const deliveries: Array<Readonly<{ jobId: string; recoveryToken: string }>> = [];
    for (const row of rows) {
      if (row.providerStage === 'COMPLETED') {
        try {
          if (
            await this.recoverCompletedSnapshot(
              row.id,
              new Date(Date.now() + 1_000),
              'periodic completed snapshot recovery',
              recoveryToken,
            )
          )
            completed += 1;
        } catch (error) {
          if (await this.handleCompletedRecoveryFailure(row.id, recoveryToken, error))
            ambiguous += 1;
        }
      } else if (row.providerStage === 'STARTED') {
        if (await this.finalizeStartedRecovery(row.id, recoveryToken)) ambiguous += 1;
      } else if (row.status === 'QUEUED') {
        deliveries.push(Object.freeze({ jobId: row.id, recoveryToken }));
      } else if (row.attempts < row.maxAttempts) {
        if (await this.requeueNotStartedRecovery(row.id, recoveryToken)) {
          requeued += 1;
          deliveries.push(Object.freeze({ jobId: row.id, recoveryToken }));
        }
      } else if (await this.failNotStartedRecovery(row.id, recoveryToken)) {
        failed += 1;
      }
    }
    return Object.freeze({
      completed,
      ambiguous,
      requeued,
      failed,
      deliveries: Object.freeze(deliveries),
    });
  }

  async acknowledgeRecoveryEnqueued(jobId: string, recoveryToken: string): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: {
        id: jobId,
        status: 'QUEUED',
        providerStage: 'NOT_STARTED',
        errorCode: 'RECOVERY_ENQUEUE_PENDING',
        recoveryLeaseToken: recoveryToken,
      },
      data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null },
    });
    return updated.count === 1;
  }

  private async recoverCompletedDelivery(jobId: string, now: Date): Promise<boolean> {
    const recoveryToken = randomUUID();
    const leased = await this.prisma.promptGenerationJob.updateMany({
      where: {
        id: jobId,
        status: 'RUNNING',
        providerStage: 'COMPLETED',
        OR: [{ recoveryLeaseExpiresAt: null }, { recoveryLeaseExpiresAt: { lt: now } }],
      },
      data: {
        recoveryLeaseToken: recoveryToken,
        recoveryLeaseExpiresAt: new Date(now.getTime() + RECOVERY_LEASE_MS),
      },
    });
    if (leased.count !== 1) return false;
    try {
      return await this.recoverCompletedSnapshot(
        jobId,
        new Date(now.getTime() + 1_000),
        'automatic completed snapshot delivery recovery',
        recoveryToken,
      );
    } catch (error) {
      if (await this.handleCompletedRecoveryFailure(jobId, recoveryToken, error)) return false;
      throw new Error('LLM_RECOVERY_PENDING');
    }
  }

  private async recoverCompletedSnapshot(
    jobId: string,
    staleBefore: Date,
    reason: string,
    recoveryToken?: string,
  ): Promise<boolean> {
    const row = await this.prisma.promptGenerationJob.findFirst({
      where: {
        id: jobId,
        status: 'RUNNING',
        providerStage: 'COMPLETED',
        leaseToken: { not: null },
        ...(recoveryToken ? { recoveryLeaseToken: recoveryToken } : {}),
        OR: [
          { heartbeatAt: { lt: staleBefore } },
          { heartbeatAt: null, startedAt: { lt: staleBefore } },
        ],
      },
    });
    if (!row?.leaseToken || !row.providerSnapshot) return false;
    const claimed = claimedJob({ ...row, leaseToken: row.leaseToken });
    let command: CompletionCommand;
    try {
      command = commandFromSnapshot(claimed, row.providerSnapshot);
    } catch {
      throw new PermanentRecoveryError('PROVIDER_SNAPSHOT_INVALID');
    }
    return this.complete(command, recoveryToken, reason);
  }

  private async handleCompletedRecoveryFailure(
    jobId: string,
    recoveryToken: string,
    error: unknown,
  ): Promise<boolean> {
    if (classifyRecoveryError(error) === 'PERMANENT')
      return this.finalizePermanentCompletedRecovery(jobId, recoveryToken, error);
    await this.prisma.promptGenerationJob.updateMany({
      where: { id: jobId, recoveryLeaseToken: recoveryToken },
      data: { recoveryLeaseToken: null, recoveryLeaseExpiresAt: null },
    });
    return false;
  }

  private async finalizePermanentCompletedRecovery(
    jobId: string,
    recoveryToken: string,
    error: unknown,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.promptGenerationJob.findFirst({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'COMPLETED',
          recoveryLeaseToken: recoveryToken,
        },
      });
      if (!current) return false;
      const updated = await transaction.promptGenerationJob.updateMany({
        where: {
          id: jobId,
          status: 'RUNNING',
          providerStage: 'COMPLETED',
          recoveryLeaseToken: recoveryToken,
        },
        data: {
          status: 'AMBIGUOUS',
          errorCode: 'RECOVERY_COMPLETION_INVALID',
          errorMessage: null,
          retryable: false,
          finishedAt: new Date(),
          leaseToken: null,
          heartbeatAt: null,
          recoveryLeaseToken: null,
          recoveryLeaseExpiresAt: null,
          reconciliationReason: 'automatic recovery failed; manual reconciliation required',
          reconciledAt: current.reconciliationActorId ? new Date() : null,
          reconciliationActorId: null,
          reconciliationCommandId: null,
        },
      });
      if (updated.count !== 1) return false;
      await transaction.auditEvent.create({
        data: {
          actorId: current.reconciliationActorId ?? current.ownerId,
          action: 'llm_job.recovery_failed',
          entityType: 'PromptGenerationJob',
          entityId: current.id,
          metadata: {
            outcome: 'AMBIGUOUS',
            reasonCode: sanitizedRecoveryCode(error),
            actorType: current.reconciliationActorId ? 'ADMIN' : 'SYSTEM',
            ...(current.reconciliationCommandId
              ? { commandIdHash: hash(current.reconciliationCommandId) }
              : {}),
          },
        },
      });
      return true;
    });
  }

  private async createFinalRecoveryAudit(
    transaction: Prisma.TransactionClient,
    current: Readonly<{
      id: string;
      reconciliationActorId: string | null;
      reconciliationCommandId: string | null;
    }>,
    outcome: 'SUCCEEDED' | 'FAILED' | 'AMBIGUOUS',
  ): Promise<void> {
    if (!current.reconciliationActorId || !current.reconciliationCommandId) return;
    await transaction.auditEvent.create({
      data: {
        actorId: current.reconciliationActorId,
        action: 'llm_job.reconciliation_completed',
        entityType: 'PromptGenerationJob',
        entityId: current.id,
        metadata: {
          outcome,
          commandIdHash: hash(current.reconciliationCommandId),
        },
      },
    });
  }

  private async reconcileWithSettlement(
    jobId: string,
    actualAmountMinor: bigint | null,
    reason: string,
  ): Promise<boolean> {
    if (!reason.trim() || reason.length > 500) throw new Error('RECONCILIATION_REASON_INVALID');
    return this.prisma.$transaction(async (transaction) => {
      const job = await transaction.promptGenerationJob.findFirst({
        where: { id: jobId, status: 'AMBIGUOUS' },
        include: {
          creditLedgerEntries: { where: { kind: 'RESERVATION', settlement: null }, take: 1 },
        },
      });
      if (!job) return false;
      const reservation = job.creditLedgerEntries[0];
      if (reservation) {
        const reserved = -reservation.amountMinor;
        const actual = actualAmountMinor ?? 0n;
        if (actual > reservationMaximum(reservation.metadata))
          throw new Error('CREDIT_COST_LIMIT_EXCEEDED');
        const kind =
          actualAmountMinor === null
            ? 'REVERSAL'
            : actual === reserved
              ? 'CONFIRMATION'
              : 'ADJUSTMENT';
        const delta = reserved - actual;
        if (kind === 'ADJUSTMENT' && delta === 0n) throw new Error('ADJUSTMENT_AMOUNT_INVALID');
        await transaction.creditLedgerEntry.create({
          data: {
            ownerId: reservation.ownerId,
            jobId,
            kind,
            amountMinor: delta,
            currency: reservation.currency,
            idempotencyKey: `reconcile:${reservation.id}`,
            reservationId: reservation.id,
            metadata: { actualAmountMinor: actual.toString(), reason },
          },
        });
      }
      const updated = await transaction.promptGenerationJob.updateMany({
        where: { id: jobId, status: 'AMBIGUOUS' },
        data: {
          status: 'FAILED',
          errorCode: actualAmountMinor === null ? 'RECONCILED_NOT_RUN' : 'RECONCILED_PAID_UNKNOWN',
          errorMessage: 'Generation could not be completed.',
          reconciliationReason: reason,
          reconciledAt: new Date(),
          retryable: false,
        },
      });
      return updated.count === 1;
    });
  }
}

function claimedJob(row: {
  id: string;
  ownerId: string;
  projectId: string;
  operation: string;
  provider: string;
  model: string;
  credentialMode: string;
  connectionId: string | null;
  sourcePromptVersionId: string | null;
  attempts: number;
  maxAttempts: number;
  leaseToken: string;
}): ClaimedLlmJob {
  return {
    id: row.id,
    ownerId: row.ownerId,
    projectId: row.projectId,
    operation: row.operation as ClaimedLlmJob['operation'],
    provider: row.provider as ClaimedLlmJob['provider'],
    model: row.model,
    credentialMode: row.credentialMode as ClaimedLlmJob['credentialMode'],
    connectionId: row.connectionId,
    sourcePromptVersionId: row.sourcePromptVersionId,
    attempts: row.attempts,
    maxAttempts: row.maxAttempts,
    leaseToken: row.leaseToken,
  };
}

function snapshotJson(command: CompletionCommand): Prisma.InputJsonValue {
  return SnapshotSchema.parse({
    schemaVersion: 1,
    result: command.result,
    security: command.security,
    latencyMs: command.latencyMs,
    actualAmountMinor: command.actualAmountMinor?.toString() ?? null,
    pricingVersion: command.pricingVersion,
  }) as Prisma.InputJsonValue;
}

function commandFromSnapshot(job: ClaimedLlmJob, value: Prisma.JsonValue): CompletionCommand {
  const snapshot = SnapshotSchema.parse(value);
  return {
    job,
    result: snapshot.result,
    security: snapshot.security,
    latencyMs: snapshot.latencyMs,
    actualAmountMinor:
      snapshot.actualAmountMinor === null ? null : BigInt(snapshot.actualAmountMinor),
    pricingVersion: snapshot.pricingVersion,
  };
}

function publicVersion(row: {
  id: string;
  projectId: string;
  sequence: number;
  sourceVersionId: string | null;
  kind: string;
  destination: string;
  content: string;
  metadata: unknown;
  contentHash: string;
  templateVersion: string;
  reportSchemaVersion: number;
  provider: LlmProvider | null;
  model: string | null;
  createdAt: Date;
}) {
  const metadata = z
    .object({ summary: z.string().min(1).max(2_000) })
    .strict()
    .parse(row.metadata);
  return PromptVersionSchema.parse({
    id: row.id,
    projectId: row.projectId,
    sequence: row.sequence,
    sourceVersionId: row.sourceVersionId,
    kind: row.kind,
    destination: row.destination,
    content: row.content,
    summary: metadata.summary,
    contentHash: row.contentHash,
    templateVersion: row.templateVersion,
    reportSchemaVersion: row.reportSchemaVersion,
    provider: row.provider,
    model: row.model,
    createdAt: row.createdAt.toISOString(),
  });
}

function safeCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'INTERNAL';
}
function publicMessage(status: string): string {
  return status === 'QUEUED' ? 'Generation will be retried.' : 'Generation could not be completed.';
}
function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function summarize(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 2_000);
}
function leaseWhere(job: ClaimedLlmJob, statuses: Array<'RUNNING' | 'CANCEL_REQUESTED'>) {
  return {
    id: job.id,
    leaseToken: job.leaseToken,
    attempts: job.attempts,
    status: { in: statuses },
  } as const;
}
function reservationMaximum(metadata: Prisma.JsonValue | null): bigint {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
    throw new Error('CREDIT_STATE_INVALID');
  const raw = (metadata as Record<string, Prisma.JsonValue>).maximumAcceptedAmountMinor;
  if (typeof raw !== 'string') throw new Error('CREDIT_STATE_INVALID');
  const amount = BigInt(raw);
  if (amount <= 0n || amount > 1_000_000_000_000n) throw new Error('CREDIT_STATE_INVALID');
  return amount;
}
