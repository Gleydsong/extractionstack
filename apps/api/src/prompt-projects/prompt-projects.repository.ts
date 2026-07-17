import { createHash } from 'node:crypto';
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import {
  PromptGenerationJobSchema,
  PromptProjectListResponseSchema,
  PromptProjectSchema,
  PromptVersionSchema,
  PromptWizardInputSchema,
  type Auth0User,
  type CredentialMode,
  type LlmProvider,
  type PromptGenerationJob,
  type PromptProject,
  type PromptProjectListQuery,
  type PromptProjectListResponse,
  type PromptVersion,
  type PromptWizardInput,
} from '@extractionstack/shared';
import { Prisma, PrismaClient, type MutationIdempotency } from '@prisma/client';
import { z } from 'zod';
import type { PromptProjectsRepositoryPort } from './prompt-projects.service.js';

const VersionMetadataSchema = z.object({ summary: z.string().trim().min(1).max(2_000) }).strict();

export type CreatePromptVersionCommand = Readonly<{
  projectId: string;
  sourceVersionId: string | null;
  kind: 'UNIVERSAL' | 'ADAPTED';
  destination: string;
  content: string;
  summary: string;
  templateVersion: string;
  reportSchemaVersion: number;
  provider: LlmProvider | null;
  model: string | null;
}>;

@Injectable()
export class PromptProjectsRepository implements PromptProjectsRepositoryPort {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async createProject(
    actor: Auth0User,
    wizardInput: PromptWizardInput,
    idempotencyKey: string,
  ): Promise<{ result: PromptProject; created: boolean } | null> {
    const wizard = PromptWizardInputSchema.parse(wizardInput);
    const owner = await this.upsertActor(actor);
    const extraction = await this.prisma.extractionJob.findFirst({
      where: { id: wizard.extractionId, ownerId: owner.id },
      select: { id: true },
    });
    if (!extraction) return null;
    const mutation = durableInput('prompt-project.create', idempotencyKey, wizard);
    return this.executeDurable(owner.id, mutation, PromptProjectSchema, async (transaction) => {
      const project = await transaction.promptProject.create({
        data: {
          ownerId: owner.id,
          extractionId: extraction.id,
          title: wizard.objective.slice(0, 200),
          category: wizard.category,
          language: wizard.language,
          wizardInput: wizard as Prisma.InputJsonValue,
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: owner.id,
          action: 'prompt_project.created',
          entityType: 'PromptProject',
          entityId: project.id,
          metadata: { extractionId: extraction.id, category: wizard.category },
        },
      });
      return publicProject(project);
    });
  }

  async findProjectOwned(actor: Auth0User, id: string): Promise<PromptProject | null> {
    const project = await this.prisma.promptProject.findFirst({
      where: { id, owner: { auth0Sub: actor.sub } },
    });
    return project ? publicProject(project) : null;
  }

  async listProjectsOwned(
    actor: Auth0User,
    query: PromptProjectListQuery,
  ): Promise<PromptProjectListResponse | null> {
    const cursor = query.cursor
      ? await this.prisma.promptProject.findFirst({
          where: { id: query.cursor, owner: { auth0Sub: actor.sub } },
          select: { id: true, createdAt: true },
        })
      : null;
    if (query.cursor && !cursor) return null;
    const projects = await this.prisma.promptProject.findMany({
      where: {
        owner: { auth0Sub: actor.sub },
        ...(cursor
          ? {
              OR: [
                { createdAt: { lt: cursor.createdAt } },
                { createdAt: cursor.createdAt, id: { lt: cursor.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: query.limit + 1,
    });
    const items = projects.slice(0, query.limit);
    return PromptProjectListResponseSchema.parse({
      items: items.map(publicProject),
      nextCursor: projects.length > query.limit ? (items.at(-1)?.id ?? null) : null,
    });
  }

  async findVersionOwned(
    actor: Auth0User,
    id: string,
  ): Promise<{ id: string; projectId: string } | null> {
    return this.prisma.promptVersion.findFirst({
      where: { id, project: { owner: { auth0Sub: actor.sub } } },
      select: { id: true, projectId: true },
    });
  }

  async findActiveConnectionOwned(
    actor: Auth0User,
    id: string,
    provider: LlmProvider,
    mode: Exclude<CredentialMode, 'PLATFORM_CREDITS'>,
  ): Promise<boolean> {
    const connection = await this.prisma.aiConnection.findFirst({
      where: {
        id,
        owner: { auth0Sub: actor.sub },
        provider,
        credentialMode: mode,
        state: 'ACTIVE',
      },
      select: { id: true },
    });
    return Boolean(connection);
  }

  async createJob(
    actor: Auth0User,
    command: Parameters<PromptProjectsRepositoryPort['createJob']>[1],
    idempotencyKey: string,
  ): Promise<{ result: PromptGenerationJob; ownerId: string; created: boolean }> {
    const owner = await this.prisma.user.findUnique({ where: { auth0Sub: actor.sub } });
    if (!owner) throw targetMissing();
    const operation = `prompt-job.${command.operation.toLowerCase()}`;
    const mutation = durableInput(operation, idempotencyKey, command);
    const outcome = await this.executeDurable(
      owner.id,
      mutation,
      PromptGenerationJobSchema,
      async (transaction) => {
        const project = await transaction.promptProject.findFirst({
          where: { id: command.projectId, ownerId: owner.id, state: 'ACTIVE' },
          select: { id: true },
        });
        if (!project) throw targetMissing();
        if (command.sourcePromptVersionId) {
          const source = await transaction.promptVersion.findFirst({
            where: { id: command.sourcePromptVersionId, projectId: project.id },
            select: { id: true },
          });
          if (!source) throw targetMissing();
        }
        const job = await transaction.promptGenerationJob.create({
          data: {
            ownerId: owner.id,
            projectId: project.id,
            operation: command.operation,
            provider: command.provider,
            model: command.model,
            credentialMode: command.credentialMode,
            connectionId: command.connectionId,
            idempotencyKey: `job:${mutation.keyHash}`,
            sourcePromptVersionId: command.sourcePromptVersionId,
            requestMetadata: command.requestMetadata,
          },
        });
        await transaction.auditEvent.create({
          data: {
            actorId: owner.id,
            action: 'prompt_job.created',
            entityType: 'PromptGenerationJob',
            entityId: job.id,
            metadata: { operation: command.operation, provider: command.provider },
          },
        });
        return publicJob(job);
      },
    );
    if (!outcome.created) {
      const current = await this.prisma.promptGenerationJob.findFirst({
        where: { id: outcome.result.id, ownerId: owner.id },
      });
      if (!current) throw targetMissing();
      return { result: publicJob(current), ownerId: owner.id, created: false };
    }
    return { ...outcome, ownerId: owner.id };
  }

  async findJobOwned(actor: Auth0User, id: string): Promise<PromptGenerationJob | null> {
    const job = await this.prisma.promptGenerationJob.findFirst({
      where: { id, owner: { auth0Sub: actor.sub } },
    });
    return job ? publicJob(job) : null;
  }

  async failJob(actor: Auth0User, id: string, errorCode: string): Promise<void> {
    await this.prisma.promptGenerationJob.updateMany({
      where: { id, owner: { auth0Sub: actor.sub }, status: 'QUEUED' },
      data: {
        status: 'FAILED',
        errorCode: safeCode(errorCode),
        errorMessage: 'generation submission failed',
        retryable: true,
        finishedAt: new Date(),
      },
    });
  }

  async requestCancellation(
    actor: Auth0User,
    id: string,
    _idempotencyKey: string,
  ): Promise<PromptGenerationJob | null> {
    return this.prisma.$transaction(async (transaction) => {
      const candidate = await transaction.promptGenerationJob.findFirst({
        where: { id, owner: { auth0Sub: actor.sub }, status: { in: ['QUEUED', 'RUNNING'] } },
        select: { id: true, status: true },
      });
      if (!candidate) return null;
      const next = candidate.status === 'QUEUED' ? 'CANCELLED' : 'CANCEL_REQUESTED';
      const updated = await transaction.promptGenerationJob.updateMany({
        where: { id: candidate.id, status: candidate.status },
        data: {
          status: next,
          ...(next === 'CANCELLED' ? { finishedAt: new Date() } : {}),
        },
      });
      if (updated.count !== 1) return null;
      await transaction.auditEvent.create({
        data: {
          actorId: (
            await transaction.user.findUniqueOrThrow({
              where: { auth0Sub: actor.sub },
              select: { id: true },
            })
          ).id,
          action: 'prompt_job.cancelled',
          entityType: 'PromptGenerationJob',
          entityId: candidate.id,
          metadata: { state: next },
        },
      });
      const job = await transaction.promptGenerationJob.findFirst({
        where: { id: candidate.id, owner: { auth0Sub: actor.sub } },
      });
      return job ? publicJob(job) : null;
    });
  }

  async findOpenCreditReservationOwned(actor: Auth0User, jobId: string): Promise<string | null> {
    const reservation = await this.prisma.creditLedgerEntry.findFirst({
      where: {
        jobId,
        kind: 'RESERVATION',
        owner: { auth0Sub: actor.sub },
        settlement: null,
      },
      select: { id: true },
    });
    return reservation?.id ?? null;
  }

  async createVersion(
    actor: Auth0User,
    command: CreatePromptVersionCommand,
  ): Promise<PromptVersion> {
    const metadata = VersionMetadataSchema.parse({ summary: command.summary });
    return this.prisma.$transaction(
      async (transaction) => {
        const project = await transaction.promptProject.findFirst({
          where: { id: command.projectId, owner: { auth0Sub: actor.sub }, state: 'ACTIVE' },
          select: { id: true },
        });
        if (!project) throw targetMissing();
        await transaction.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${project.id}, 0))::text AS "lock"`;
        if (command.sourceVersionId) {
          const source = await transaction.promptVersion.findFirst({
            where: { id: command.sourceVersionId, projectId: project.id },
            select: { id: true },
          });
          if (!source) throw targetMissing();
        }
        const latest = await transaction.promptVersion.aggregate({
          where: { projectId: project.id },
          _max: { sequence: true },
        });
        const version = await transaction.promptVersion.create({
          data: {
            projectId: project.id,
            sequence: (latest._max.sequence ?? 0) + 1,
            sourceVersionId: command.sourceVersionId,
            kind: command.kind,
            destination: command.destination,
            content: command.content,
            metadata,
            contentHash: hash(command.content),
            templateVersion: command.templateVersion,
            reportSchemaVersion: command.reportSchemaVersion,
            provider: command.provider,
            model: command.model,
          },
        });
        await transaction.promptProject.updateMany({
          where: { id: project.id, owner: { auth0Sub: actor.sub } },
          data: { currentVersionId: version.id },
        });
        return publicVersion(version);
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
  }

  private upsertActor(actor: Auth0User) {
    return this.prisma.user.upsert({
      where: { auth0Sub: actor.sub },
      create: {
        auth0Sub: actor.sub,
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
      update: {
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
    });
  }

  private async executeDurable<T>(
    ownerId: string,
    input: ReturnType<typeof durableInput>,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    create: (transaction: Prisma.TransactionClient) => Promise<T>,
  ): Promise<{ result: T; created: boolean }> {
    try {
      return await this.prisma.$transaction(async (transaction) => {
        const existing = await transaction.mutationIdempotency.findUnique({
          where: {
            ownerId_operation_keyHash: {
              ownerId,
              operation: input.operation,
              keyHash: input.keyHash,
            },
          },
        });
        if (existing)
          return { result: replay(existing, input.requestHash, schema), created: false };
        const durable = await transaction.mutationIdempotency.create({
          data: {
            ownerId,
            operation: input.operation,
            keyHash: input.keyHash,
            requestHash: input.requestHash,
          },
        });
        const result = await create(transaction);
        const parsed = schema.parse(result);
        await transaction.mutationIdempotency.update({
          where: { id: durable.id },
          data: {
            status: 'COMPLETE',
            publicResult: parsed as Prisma.InputJsonValue,
            entityId: entityId(parsed),
            completedAt: new Date(),
          },
        });
        return { result: parsed, created: true };
      });
    } catch (error) {
      if (!isUniqueConstraint(error)) throw error;
      const existing = await this.prisma.mutationIdempotency.findUnique({
        where: {
          ownerId_operation_keyHash: {
            ownerId,
            operation: input.operation,
            keyHash: input.keyHash,
          },
        },
      });
      if (!existing) throw error;
      return { result: replay(existing, input.requestHash, schema), created: false };
    }
  }
}

function publicProject(project: {
  id: string;
  extractionId: string;
  title: string;
  category: string;
  language: string;
  wizardInput: unknown;
  currentVersionId: string | null;
  state: string;
  createdAt: Date;
  updatedAt: Date;
}): PromptProject {
  return PromptProjectSchema.parse({
    id: project.id,
    extractionId: project.extractionId,
    title: project.title,
    category: project.category,
    language: project.language,
    wizardInput: project.wizardInput,
    currentVersionId: project.currentVersionId,
    state: project.state,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
  });
}

function publicJob(job: {
  id: string;
  projectId: string;
  operation: string;
  provider: string;
  model: string;
  credentialMode: string;
  status: string;
  attempts: number;
  maxAttempts: number;
  sourcePromptVersionId: string | null;
  resultPromptVersionId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  retryable: boolean | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}): PromptGenerationJob {
  const base = {
    id: job.id,
    projectId: job.projectId,
    operation: job.operation,
    provider: job.provider,
    model: job.model,
    credentialMode: job.credentialMode,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    sourcePromptVersionId: job.sourcePromptVersionId,
    resultPromptVersionId: job.resultPromptVersionId,
    queuedAt: job.queuedAt.toISOString(),
    startedAt: job.startedAt?.toISOString() ?? null,
    finishedAt: job.finishedAt?.toISOString() ?? null,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
  if (job.status === 'FAILED') {
    return PromptGenerationJobSchema.parse({
      ...base,
      errorCode: job.errorCode ?? 'INTERNAL',
      message: job.errorMessage ?? 'generation failed',
      retryable: job.retryable ?? false,
    });
  }
  return PromptGenerationJobSchema.parse({ ...base, message: messageForStatus(job.status) });
}

function publicVersion(version: {
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
  provider: string | null;
  model: string | null;
  createdAt: Date;
}): PromptVersion {
  const metadata = VersionMetadataSchema.parse(version.metadata);
  return PromptVersionSchema.parse({
    id: version.id,
    projectId: version.projectId,
    sequence: version.sequence,
    sourceVersionId: version.sourceVersionId,
    kind: version.kind,
    destination: version.destination,
    content: version.content,
    summary: metadata.summary,
    contentHash: version.contentHash,
    templateVersion: version.templateVersion,
    reportSchemaVersion: version.reportSchemaVersion,
    provider: version.provider,
    model: version.model,
    createdAt: version.createdAt.toISOString(),
  });
}

function durableInput(operation: string, key: string, request: unknown) {
  return { operation, keyHash: hash(key), requestHash: hash(JSON.stringify(request)) };
}

function replay<T>(
  existing: MutationIdempotency,
  requestHash: string,
  schema: z.ZodType<T, z.ZodTypeDef, unknown>,
): T {
  if (existing.requestHash !== requestHash)
    throw new ConflictException({
      code: 'CONFLICT',
      message: 'idempotency key was used for another request',
    });
  if (existing.status !== 'COMPLETE' || existing.publicResult === null)
    throw new ConflictException({ code: 'CONFLICT', message: 'request is already in progress' });
  return schema.parse(existing.publicResult);
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
function entityId(value: unknown): string | undefined {
  return typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string'
    ? value.id
    : undefined;
}
function isUniqueConstraint(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
function targetMissing(): Error {
  return new Error('PROMPT_SCOPE_NOT_FOUND');
}
function safeCode(value: string): string {
  return /^[A-Z][A-Z0-9_]{0,63}$/.test(value) ? value : 'INTERNAL';
}
function messageForStatus(status: string): string {
  switch (status) {
    case 'QUEUED':
      return 'Queued';
    case 'RUNNING':
      return 'Running';
    case 'SUCCEEDED':
      return 'Completed';
    case 'CANCEL_REQUESTED':
      return 'Cancellation requested';
    case 'CANCELLED':
      return 'Cancelled';
    default:
      return 'Generation status unavailable';
  }
}
