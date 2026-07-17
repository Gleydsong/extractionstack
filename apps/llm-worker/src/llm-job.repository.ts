import { createHash } from 'node:crypto';
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
      }>
    >`
      UPDATE "PromptGenerationJob"
      SET "status" = 'RUNNING'::"PromptJobStatus",
          "startedAt" = ${now},
          "attempts" = "attempts" + 1,
          "errorCode" = NULL,
          "errorMessage" = NULL,
          "retryable" = NULL,
          "updatedAt" = ${now}
      WHERE "id" = ${jobId}
        AND "attempts" < "maxAttempts"
        AND (
          "status" = 'QUEUED'::"PromptJobStatus"
          OR ("status" = 'RUNNING'::"PromptJobStatus" AND "startedAt" < ${staleBefore})
        )
      RETURNING "id", "ownerId", "projectId", "operation", "provider", "model",
                "credentialMode", "connectionId", "sourcePromptVersionId", "attempts", "maxAttempts"
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
        project: { ownerId: job.ownerId, state: 'ACTIVE', extraction: { ownerId: job.ownerId } },
      },
      include: {
        project: { include: { extraction: { include: { report: true } } } },
        sourcePromptVersion: true,
        creditLedgerEntries: {
          where: { kind: 'RESERVATION', settlement: null },
          select: { id: true },
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
    });
  }

  async isCancellationRequested(jobId: string): Promise<boolean> {
    const row = await this.prisma.promptGenerationJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    return row?.status === 'CANCEL_REQUESTED' || row?.status === 'CANCELLED';
  }

  async complete(command: CompletionCommand): Promise<boolean> {
    return this.prisma.$transaction(async (transaction) => {
      const current = await transaction.promptGenerationJob.findFirst({
        where: {
          id: command.job.id,
          ownerId: command.job.ownerId,
          projectId: command.job.projectId,
          status: 'RUNNING',
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
          estimatedAmountMinor: microsToMinor(command.result.usage.estimatedCostMicros),
          confirmedAmountMinor: microsToMinor(command.result.usage.estimatedCostMicros),
          currency: current.credentialMode === 'PLATFORM_CREDITS' ? 'CREDITS' : null,
          pricingVersion: 'provider-registry-v1',
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
        const actual = microsToMinor(command.result.usage.estimatedCostMicros) ?? 0n;
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
        where: { id: current.id, ownerId: current.ownerId, status: 'RUNNING' },
        data: {
          status: 'SUCCEEDED',
          resultPromptVersionId,
          finishedAt: new Date(),
          retryable: false,
        },
      });
      if (updated.count !== 1) throw new Error('WORKER_STATE_CHANGED');
      return true;
    });
  }

  async markRetry(jobId: string, errorCode: string): Promise<void> {
    await this.transition(jobId, 'QUEUED', errorCode, true, false);
  }
  async fail(jobId: string, errorCode: string): Promise<void> {
    await this.terminalTransition(jobId, 'FAILED', errorCode, 'generation failed');
  }
  async deadLetter(jobId: string, errorCode: string): Promise<void> {
    await this.terminalTransition(
      jobId,
      'FAILED',
      `DEAD_LETTER_${errorCode}`.slice(0, MAX_ERROR_CODE),
      'generation retries exhausted',
    );
  }
  async cancel(jobId: string): Promise<void> {
    await this.terminalTransition(jobId, 'CANCELLED', null, 'generation cancelled');
  }
  async reject(jobId: string, reasonCode: string): Promise<void> {
    await this.fail(jobId, `SAFETY_${safeCode(reasonCode)}`);
  }

  async confirm(reservationId: string, _actualAmountMinor: bigint): Promise<void> {
    const settlement = await this.prisma.creditLedgerEntry.findUnique({
      where: { reservationId },
      select: { kind: true },
    });
    if (settlement?.kind === 'CONFIRMATION') return;
    throw new Error('CREDIT_SETTLEMENT_PENDING');
  }

  async reverse(reservationId: string, reason: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const existing = await transaction.creditLedgerEntry.findUnique({ where: { reservationId } });
      if (existing) return;
      const reservation = await transaction.creditLedgerEntry.findFirst({
        where: { id: reservationId, kind: 'RESERVATION' },
      });
      if (!reservation) throw new Error('CREDIT_RESERVATION_NOT_FOUND');
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
            reason: reason.slice(0, 500),
          },
        },
      });
    });
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

  private async transition(
    jobId: string,
    status: 'QUEUED' | 'FAILED',
    errorCode: string,
    retryable: boolean,
    terminal: boolean,
  ): Promise<void> {
    await this.prisma.promptGenerationJob.updateMany({
      where: { id: jobId, status: { in: ['RUNNING', 'CANCEL_REQUESTED'] } },
      data: {
        status,
        errorCode: safeCode(errorCode),
        errorMessage: publicMessage(status),
        retryable,
        ...(terminal ? { finishedAt: new Date() } : { startedAt: null }),
      },
    });
  }

  private async terminalTransition(
    jobId: string,
    status: 'FAILED' | 'CANCELLED',
    errorCode: string | null,
    reversalReason: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.promptGenerationJob.updateMany({
        where: { id: jobId, status: { in: ['RUNNING', 'CANCEL_REQUESTED'] } },
        data: {
          status,
          errorCode: errorCode ? safeCode(errorCode) : null,
          errorMessage: status === 'FAILED' ? publicMessage(status) : null,
          retryable: false,
          finishedAt: new Date(),
        },
      });
      if (updated.count !== 1) return;
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
            reason: reversalReason,
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
function microsToMinor(value: number | null): bigint | null {
  return value === null ? null : BigInt(Math.ceil(value / 10_000));
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
