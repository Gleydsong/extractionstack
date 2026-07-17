import { createHash, randomUUID } from 'node:crypto';
import {
  InvestigationReportSchema,
  PromptVersionSchema,
  PromptWizardInputSchema,
  type LlmProvider,
} from '@extractionstack/shared';
import type { Prisma, PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CredentialStorePort, StoredProviderCredential } from '@extractionstack/llm-core';
import type {
  AuthorizedLlmContext,
  ClaimedLlmJob,
  CompletionCommand,
  LlmJobStorePort,
} from './llm-worker.types';

const STALE_RUNNING_MS = 5 * 60 * 1_000;
const MAX_ERROR_CODE = 64;
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
    const staleBefore = new Date(now.getTime() - STALE_RUNNING_MS);
    await this.reconcileUnclaimableStaleJob(jobId, staleBefore, now);
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
        AND "providerCompletedAt" IS NULL
        AND (
          "status" = 'QUEUED'::"PromptJobStatus"
          OR ("status" = 'RUNNING'::"PromptJobStatus" AND COALESCE("heartbeatAt", "startedAt") < ${staleBefore})
        )
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

  async markProviderCompleted(
    job: ClaimedLlmJob,
    providerRequestId: string | null,
  ): Promise<boolean> {
    const updated = await this.prisma.promptGenerationJob.updateMany({
      where: { ...leaseWhere(job, ['RUNNING']), providerCompletedAt: null },
      data: { providerCompletedAt: new Date(), providerRequestId },
    });
    return updated.count === 1;
  }

  async complete(command: CompletionCommand): Promise<boolean> {
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
        },
        include: {
          creditLedgerEntries: { where: { kind: 'RESERVATION', settlement: null }, take: 1 },
        },
      });
      if (!current) return false;

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
        where: leaseWhere(command.job, ['RUNNING']),
        data: {
          status: 'SUCCEEDED',
          resultPromptVersionId,
          finishedAt: new Date(),
          retryable: false,
          leaseToken: null,
          heartbeatAt: null,
        },
      });
      if (updated.count !== 1) throw new Error('WORKER_STATE_CHANGED');
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
    return this.terminalTransition(
      job,
      'AMBIGUOUS',
      errorCode,
      'generation outcome requires reconciliation',
    );
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
    status: 'FAILED' | 'CANCELLED' | 'AMBIGUOUS',
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

  private async reconcileUnclaimableStaleJob(
    jobId: string,
    staleBefore: Date,
    now: Date,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const rows = await transaction.$queryRaw<Array<{ id: string }>>`
        UPDATE "PromptGenerationJob"
        SET "status" = CASE
              WHEN "providerCompletedAt" IS NOT NULL THEN 'AMBIGUOUS'::"PromptJobStatus"
              ELSE 'FAILED'::"PromptJobStatus"
            END,
            "errorCode" = CASE
              WHEN "providerCompletedAt" IS NOT NULL THEN 'PERSISTENCE_FAILED'
              ELSE 'DEAD_LETTER_WORKER_LEASE_EXPIRED'
            END,
            "errorMessage" = CASE
              WHEN "providerCompletedAt" IS NOT NULL THEN NULL
              ELSE 'Generation could not be completed.'
            END,
            "retryable" = false,
            "finishedAt" = ${now},
            "leaseToken" = NULL,
            "heartbeatAt" = NULL,
            "updatedAt" = ${now}
        WHERE "id" = ${jobId}
          AND "status" = 'RUNNING'::"PromptJobStatus"
          AND COALESCE("heartbeatAt", "startedAt") < ${staleBefore}
          AND ("providerCompletedAt" IS NOT NULL OR "attempts" >= "maxAttempts")
        RETURNING "id"
      `;
      if (!rows[0]) return;
      const reservation = await transaction.creditLedgerEntry.findFirst({
        where: { jobId, kind: 'RESERVATION', settlement: null },
      });
      if (!reservation) return;
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
