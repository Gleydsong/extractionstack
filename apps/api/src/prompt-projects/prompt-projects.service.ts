import {
  BadRequestException,
  ConflictException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  PricingCatalog,
  PricingFailure,
  PromptComposer,
  ProviderFailure,
  ProviderRegistry,
  ReportNarrativeAssembler,
  composedPromptLayers,
  conservativeInputTokenUpperBound,
} from '@extractionstack/llm-core';
import {
  MAXIMUM_COST_MINOR,
  PromptCostEstimateSchema,
  PromptGenerationJobSchema,
  PromptProjectListResponseSchema,
  PromptProjectSchema,
  PromptPreviewSchema,
  PromptVersionDetailSchema,
  PromptVersionCostEstimateSchema,
  PromptVersionListResponseSchema,
  type Auth0User,
  type CredentialMode,
  type ExtractionReport,
  type LlmProvider,
  type PromptCostEstimate,
  type PromptCostEstimateRequest,
  type PromptAdaptationRequest,
  type PromptGenerationJob,
  type PromptGenerationRequest,
  type PromptPreviewRequest,
  type PromptProject,
  type PromptProjectListQuery,
  type PromptProjectListResponse,
  type PromptPreview,
  type PromptVersionDetail,
  type PromptVersion,
  type PromptVersionCostEstimate,
  type PromptVersionCostEstimateRequest,
  type PromptVersionEditRequest,
  type PromptVersionListQuery,
  type PromptVersionListResponse,
  type PromptWizardInput,
} from '@extractionstack/shared';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import { CreditsService, type CreditsPort } from '../credits/credits.service.js';

export const PROMPT_PROJECTS_REPOSITORY = Symbol('PROMPT_PROJECTS_REPOSITORY');
export const PROMPT_GENERATION_QUEUE = Symbol('PROMPT_GENERATION_QUEUE');

type JobCommand = Readonly<{
  projectId: string;
  operation: 'GENERATE' | 'ADAPT' | 'PREVIEW';
  provider: LlmProvider;
  model: string;
  credentialMode: CredentialMode;
  connectionId: string | null;
  sourcePromptVersionId: string | null;
  requestMetadata: Readonly<{ destination?: string }>;
}>;

type ExecutionRequest = PromptGenerationRequest | PromptAdaptationRequest | PromptPreviewRequest;

export interface PromptProjectsRepositoryPort {
  createProject(
    actor: Auth0User,
    wizard: PromptWizardInput,
    idempotencyKey: string,
  ): Promise<{ result: PromptProject; created: boolean } | null>;
  findProjectOwned(actor: Auth0User, id: string): Promise<PromptProject | null>;
  findExtractionReportOwned(
    actor: Auth0User,
    extractionId: string,
  ): Promise<ExtractionReport | null>;
  listProjectsOwned(
    actor: Auth0User,
    query: PromptProjectListQuery,
  ): Promise<PromptProjectListResponse | null>;
  findVersionOwned(actor: Auth0User, id: string): Promise<{ id: string; projectId: string } | null>;
  listVersionsOwned(
    actor: Auth0User,
    projectId: string,
    query: PromptVersionListQuery,
  ): Promise<PromptVersionListResponse | null>;
  getVersionOwned(actor: Auth0User, id: string): Promise<PromptVersionDetail | null>;
  findPreviewByJobOwned(actor: Auth0User, jobId: string): Promise<PromptPreview | null>;
  createEditedVersionOwned(
    actor: Auth0User,
    sourceVersionId: string,
    input: PromptVersionEditRequest,
    idempotencyKey: string,
  ): Promise<{ result: PromptVersionDetail; created: boolean } | null>;
  findActiveConnectionOwned(
    actor: Auth0User,
    id: string,
    provider: LlmProvider,
    mode: Exclude<CredentialMode, 'PLATFORM_CREDITS'>,
  ): Promise<boolean>;
  createJob(
    actor: Auth0User,
    command: JobCommand,
    idempotencyKey: string,
    idempotencyRequest: ExecutionRequest,
  ): Promise<{ result: PromptGenerationJob; ownerId: string; created: boolean }>;
  findJobOwned(actor: Auth0User, id: string): Promise<PromptGenerationJob | null>;
  failJob(actor: Auth0User, id: string, errorCode: string): Promise<PromptGenerationJob | null>;
  requestCancellation(
    actor: Auth0User,
    id: string,
    idempotencyKey: string,
  ): Promise<PromptGenerationJob | null>;
  findOpenCreditReservationOwned(actor: Auth0User, jobId: string): Promise<string | null>;
}

export interface PromptGenerationQueuePort {
  enqueue(jobId: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
}

@Injectable()
export class PromptProjectsService {
  constructor(
    @Inject(PROMPT_PROJECTS_REPOSITORY) private readonly repository: PromptProjectsRepositoryPort,
    @Inject(PROMPT_GENERATION_QUEUE) private readonly queue: PromptGenerationQueuePort,
    @Inject(ProviderRegistry) private readonly registry: ProviderRegistry,
    @Inject(CreditsService) private readonly credits: CreditsPort,
    @Inject(PricingCatalog) private readonly pricing: PricingCatalog,
  ) {}

  async estimateCost(
    actor: Auth0User,
    request: PromptCostEstimateRequest,
  ): Promise<PromptCostEstimate> {
    const report = await this.repository.findExtractionReportOwned(
      actor,
      request.wizard.extractionId,
    );
    if (!report?.investigation) throw notFound();

    let capabilities: ReturnType<ProviderRegistry['get']>;
    try {
      capabilities = this.registry.get(request.provider);
      this.registry.assertModel(request.provider, request.model);
    } catch (error) {
      throw mapProviderFailure(error);
    }
    if (!capabilities.enabled || capabilities.circuitBreakerOpen) {
      throw mapProviderFailure(new ProviderFailure('PROVIDER_NOT_CONFIGURED'));
    }

    const brief = new ReportNarrativeAssembler().assemble(report.investigation);
    const composed = new PromptComposer().compose({ wizard: request.wizard, brief });
    const maximumInputTokens = conservativeInputTokenUpperBound(composedPromptLayers(composed));
    const maximumOutputTokens = Math.min(
      capabilities.maxOutputTokens,
      capabilities.contextWindowTokens - maximumInputTokens,
    );
    if (maximumOutputTokens <= 0) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'The report and instructions exceed the selected model context limit.',
      });
    }

    try {
      const quote = this.pricing.quoteMaximum(
        request.provider,
        request.model,
        maximumInputTokens,
        maximumOutputTokens,
      );
      if (quote.amountMinor <= 0n || quote.amountMinor > MAXIMUM_COST_MINOR) {
        throw new PricingFailure('PRICING_NOT_CONFIGURED');
      }
      return PromptCostEstimateSchema.parse({
        provider: request.provider,
        model: request.model,
        maximumInputTokens,
        maximumOutputTokens,
        maximumCostMinor: quote.amountMinor.toString(),
        pricingVersion: quote.pricingVersion,
        quotedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof PricingFailure)) throw error;
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'A verified platform-credit quote is not available for this model.',
      });
    }
  }

  async estimateVersionCost(
    actor: Auth0User,
    sourceVersionId: string,
    request: PromptVersionCostEstimateRequest,
  ): Promise<PromptVersionCostEstimate> {
    const version = await this.repository.getVersionOwned(actor, sourceVersionId);
    if (!version) throw notFound();
    const project = await this.repository.findProjectOwned(actor, version.projectId);
    if (!project) throw notFound();
    const report = await this.repository.findExtractionReportOwned(actor, project.extractionId);
    if (!report?.investigation) throw notFound();

    let capabilities: ReturnType<ProviderRegistry['get']>;
    try {
      capabilities = this.registry.get(request.provider);
      this.registry.assertModel(request.provider, request.model);
    } catch (error) {
      throw mapProviderFailure(error);
    }
    if (!capabilities.enabled || capabilities.circuitBreakerOpen) {
      throw mapProviderFailure(new ProviderFailure('PROVIDER_NOT_CONFIGURED'));
    }
    if (request.operation === 'PREVIEW' && !capabilities.previewEligible) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'provider does not support preview',
      });
    }

    const wizard = {
      ...project.wizardInput,
      destination:
        request.operation === 'ADAPT' ? request.destination : project.wizardInput.destination,
    };
    const brief = new ReportNarrativeAssembler().assemble(report.investigation);
    const composed = new PromptComposer().compose({
      wizard,
      brief,
      sourcePrompt: version as PromptVersion,
    });
    const maximumInputTokens = conservativeInputTokenUpperBound(composedPromptLayers(composed));
    const maximumOutputTokens = Math.min(
      capabilities.maxOutputTokens,
      capabilities.contextWindowTokens - maximumInputTokens,
    );
    if (maximumOutputTokens <= 0) {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'The selected prompt exceeds the model context limit.',
      });
    }
    try {
      const quote = this.pricing.quoteMaximum(
        request.provider,
        request.model,
        maximumInputTokens,
        maximumOutputTokens,
      );
      if (quote.amountMinor <= 0n || quote.amountMinor > MAXIMUM_COST_MINOR) {
        throw new PricingFailure('PRICING_NOT_CONFIGURED');
      }
      return PromptVersionCostEstimateSchema.parse({
        provider: request.provider,
        model: request.model,
        sourceVersionId,
        operation: request.operation,
        reportSections: ['technologies', 'structure', 'evidence', 'limitations', 'confidence'],
        retentionNotice: 'Prompt, versão e prévia permanecem no histórico do projeto.',
        maximumInputTokens,
        maximumOutputTokens,
        maximumCostMinor: quote.amountMinor.toString(),
        pricingVersion: quote.pricingVersion,
        quotedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof PricingFailure)) throw error;
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'A verified platform-credit quote is not available for this model.',
      });
    }
  }

  async create(
    actor: Auth0User,
    wizard: PromptWizardInput,
    idempotencyKey: string,
  ): Promise<PromptProject> {
    if (wizard.destination !== 'universal') {
      throw new BadRequestException({
        code: 'VALIDATION',
        message: 'Initial prompt generation must use the universal destination.',
      });
    }
    const outcome = await this.repository.createProject(actor, wizard, idempotencyKey);
    if (!outcome) throw notFound();
    return PromptProjectSchema.parse(outcome.result);
  }

  async list(actor: Auth0User, query: PromptProjectListQuery): Promise<PromptProjectListResponse> {
    const result = await this.repository.listProjectsOwned(actor, query);
    if (!result) throw notFound();
    return PromptProjectListResponseSchema.parse(result);
  }

  async get(actor: Auth0User, id: string): Promise<PromptProject> {
    const project = await this.repository.findProjectOwned(actor, id);
    if (!project) throw notFound();
    return PromptProjectSchema.parse(project);
  }

  async listVersions(
    actor: Auth0User,
    projectId: string,
    query: PromptVersionListQuery,
  ): Promise<PromptVersionListResponse> {
    const result = await this.repository.listVersionsOwned(actor, projectId, query);
    if (!result) throw notFound();
    return PromptVersionListResponseSchema.parse(result);
  }

  async getVersion(actor: Auth0User, id: string): Promise<PromptVersionDetail> {
    const version = await this.repository.getVersionOwned(actor, id);
    if (!version) throw notFound();
    return PromptVersionDetailSchema.parse(version);
  }

  async getPreview(actor: Auth0User, jobId: string): Promise<PromptPreview> {
    const preview = await this.repository.findPreviewByJobOwned(actor, jobId);
    if (!preview) throw notFound();
    return PromptPreviewSchema.parse(preview);
  }

  async editVersion(
    actor: Auth0User,
    sourceVersionId: string,
    input: PromptVersionEditRequest,
    idempotencyKey: string,
  ): Promise<PromptVersionDetail> {
    const outcome = await this.repository.createEditedVersionOwned(
      actor,
      sourceVersionId,
      input,
      idempotencyKey,
    );
    if (!outcome) throw notFound();
    return PromptVersionDetailSchema.parse(outcome.result);
  }

  async generate(
    actor: Auth0User,
    projectId: string,
    request: PromptGenerationRequest,
    idempotencyKey: string,
  ): Promise<PromptGenerationJob> {
    if (!(await this.repository.findProjectOwned(actor, projectId))) throw notFound();
    return this.submit(
      actor,
      {
        projectId,
        operation: 'GENERATE',
        provider: request.provider,
        model: request.model,
        credentialMode: request.credentialMode,
        connectionId: request.connectionId,
        sourcePromptVersionId: null,
        requestMetadata: { destination: 'universal' },
      },
      request,
      idempotencyKey,
    );
  }

  async adapt(
    actor: Auth0User,
    versionId: string,
    request: PromptAdaptationRequest,
    idempotencyKey: string,
  ): Promise<PromptGenerationJob> {
    const version = await this.repository.findVersionOwned(actor, versionId);
    if (!version) throw notFound();
    return this.submit(
      actor,
      {
        projectId: version.projectId,
        operation: 'ADAPT',
        provider: request.provider,
        model: request.model,
        credentialMode: request.credentialMode,
        connectionId: request.connectionId,
        sourcePromptVersionId: version.id,
        requestMetadata: { destination: request.destination },
      },
      request,
      idempotencyKey,
    );
  }

  async preview(
    actor: Auth0User,
    versionId: string,
    request: PromptPreviewRequest,
    idempotencyKey: string,
  ): Promise<PromptGenerationJob> {
    const version = await this.repository.findVersionOwned(actor, versionId);
    if (!version) throw notFound();
    return this.submit(
      actor,
      {
        projectId: version.projectId,
        operation: 'PREVIEW',
        provider: request.provider,
        model: request.model,
        credentialMode: request.credentialMode,
        connectionId: request.connectionId,
        sourcePromptVersionId: version.id,
        requestMetadata: {},
      },
      request,
      idempotencyKey,
    );
  }

  async getJob(actor: Auth0User, id: string): Promise<PromptGenerationJob> {
    const job = await this.repository.findJobOwned(actor, id);
    if (!job) throw notFound();
    return PromptGenerationJobSchema.parse(job);
  }

  async cancel(actor: Auth0User, id: string, idempotencyKey: string): Promise<PromptGenerationJob> {
    const current = await this.repository.findJobOwned(actor, id);
    if (!current) throw notFound();
    const updated = await this.repository.requestCancellation(actor, id, idempotencyKey);
    if (!updated) {
      throw new ConflictException({ code: 'CONFLICT', message: 'job state changed' });
    }
    await this.queue.cancel(id);
    if (updated.status === 'CANCELLED' && updated.credentialMode === 'PLATFORM_CREDITS') {
      const reservationId = await this.repository.findOpenCreditReservationOwned(actor, id);
      if (reservationId) {
        await this.credits.reverse({ reservationId, reason: 'queued generation cancelled' });
      }
    }
    return PromptGenerationJobSchema.parse(updated);
  }

  private async submit(
    actor: Auth0User,
    command: JobCommand,
    request: ExecutionRequest,
    idempotencyKey: string,
  ): Promise<PromptGenerationJob> {
    await this.validateExecution(actor, request, command.operation);
    const outcome = await this.repository.createJob(actor, command, idempotencyKey, request);
    if (!outcome.created && outcome.result.status !== 'QUEUED') {
      if (
        outcome.result.status === 'FAILED' &&
        outcome.result.credentialMode === 'PLATFORM_CREDITS'
      ) {
        const reservationId = await this.repository.findOpenCreditReservationOwned(
          actor,
          outcome.result.id,
        );
        if (reservationId) {
          await this.credits.reverse({
            reservationId,
            reason: 'queue submission failed',
          });
        }
      }
      return PromptGenerationJobSchema.parse(outcome.result);
    }

    let reservationId: string | null = null;
    if (request.credentialMode === 'PLATFORM_CREDITS') {
      try {
        const maximum = BigInt(request.maximumCostMinor!);
        const reservation = await this.credits.reserve({
          ownerId: outcome.ownerId,
          jobId: outcome.result.id,
          amountMinor: maximum,
          maximumAcceptedAmountMinor: maximum,
          idempotencyKey: `prompt-job:${outcome.result.id}`,
        });
        reservationId = reservation.id;
      } catch (error) {
        await this.repository.failJob(actor, outcome.result.id, 'SUBMISSION_FAILED');
        throw mapCreditFailure(error);
      }
    }

    try {
      await this.queue.enqueue(outcome.result.id);
      return PromptGenerationJobSchema.parse(outcome.result);
    } catch {
      const failed = await this.repository.failJob(actor, outcome.result.id, 'QUEUE_UNAVAILABLE');
      if (failed && reservationId) {
        await this.credits.reverse({ reservationId, reason: 'queue submission failed' });
      }
      if (!failed) {
        const current = await this.repository.findJobOwned(actor, outcome.result.id);
        if (current && current.status !== 'QUEUED') {
          return PromptGenerationJobSchema.parse(current);
        }
      }
      throw new ServiceUnavailableException({
        code: 'QUEUE_UNAVAILABLE',
        message: 'generation queue is unavailable',
      });
    }
  }

  private async validateExecution(
    actor: Auth0User,
    request: ExecutionRequest,
    operation: JobCommand['operation'],
  ): Promise<void> {
    const runtime = loadRuntimeEnv(process.env);
    if (
      request.credentialMode === 'PLATFORM_CREDITS' &&
      request.provider !== 'FAKE' &&
      runtime.LLM_PROVIDER_MODE === 'live' &&
      !runtime.LLM_PLATFORM_CREDITS_ENABLED
    ) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'Platform credits are currently unavailable. Choose another credential mode.',
      });
    }
    if (request.credentialMode === 'PLATFORM_CREDITS' && !request.acceptPlatformCharge) {
      throw new ConflictException({
        code: 'COST_CONSENT_REQUIRED',
        message: 'Confirm the maximum platform credit charge before continuing.',
      });
    }
    let capabilities: ReturnType<ProviderRegistry['get']>;
    try {
      capabilities = this.registry.get(request.provider);
      this.registry.assertModel(request.provider, request.model);
    } catch (error) {
      throw mapProviderFailure(error);
    }
    if (
      !capabilities.enabled ||
      capabilities.circuitBreakerOpen ||
      !capabilities.credentialModes.includes(request.credentialMode)
    ) {
      throw new ServiceUnavailableException({
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The selected provider is currently unavailable. Try again later.',
      });
    }
    if (operation === 'PREVIEW' && !capabilities.previewEligible) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'provider does not support preview',
      });
    }
    if (request.credentialMode !== 'PLATFORM_CREDITS') {
      const found = await this.repository.findActiveConnectionOwned(
        actor,
        request.connectionId!,
        request.provider,
        request.credentialMode,
      );
      if (!found) throw notFound();
    }
  }
}

function mapProviderFailure(error: unknown): HttpException {
  if (error instanceof ProviderFailure && error.code === 'MODEL_UNAVAILABLE') {
    return new BadRequestException({
      code: 'MODEL_UNAVAILABLE',
      message: 'The selected model is unavailable. Choose a configured model and try again.',
    });
  }
  return new ServiceUnavailableException({
    code: 'PROVIDER_UNAVAILABLE',
    message: 'The selected provider is currently unavailable. Try again later.',
  });
}

function mapCreditFailure(error: unknown): HttpException {
  const code = error instanceof Error ? error.message : '';
  if (code === 'INSUFFICIENT_CREDITS') {
    return new HttpException(
      {
        code: 'INSUFFICIENT_CREDITS',
        message: 'There are not enough platform credits for this request.',
      },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
  if (code === 'CREDIT_COST_LIMIT_EXCEEDED') {
    return new ConflictException({
      code: 'COST_LIMIT_EXCEEDED',
      message: 'The estimated charge exceeds the confirmed maximum cost.',
    });
  }
  if (code === 'CREDIT_DAILY_BUDGET_EXCEEDED') {
    return new HttpException(
      { code: 'COST_LIMIT_EXCEEDED', message: 'The daily platform credit budget was reached.' },
      HttpStatus.PAYMENT_REQUIRED,
    );
  }
  if (code === 'CREDIT_AMOUNT_INVALID' || code === 'CREDIT_COMMAND_INVALID') {
    return new BadRequestException({
      code: 'VALIDATION',
      message: 'The platform credit amount is invalid.',
    });
  }
  return new ServiceUnavailableException({
    code: 'INTERNAL',
    message: 'Platform credits are temporarily unavailable. Try again later.',
  });
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'NOT_FOUND', message: 'resource not found' });
}
