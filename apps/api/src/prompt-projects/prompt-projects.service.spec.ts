import { NotFoundException } from '@nestjs/common';
import { ProviderFailure } from '@extractionstack/llm-core';
import type {
  Auth0User,
  PromptGenerationJob,
  PromptProject,
  PromptPreview,
  PromptVersionDetail,
  PromptWizardInput,
} from '@extractionstack/shared';
import { describe, expect, it, vi } from 'vitest';
import {
  PromptProjectsService,
  type PromptProjectsRepositoryPort,
  type PromptGenerationQueuePort,
} from './prompt-projects.service.js';

const actor: Auth0User = { sub: 'auth0|owner', roles: ['user'] };
const now = '2026-07-17T10:00:00.000Z';
const projectId = 'cm1234567890project';
const versionId = 'cm1234567890version';
const version: PromptVersionDetail = {
  id: versionId,
  projectId,
  sequence: 1,
  sourceVersionId: null,
  kind: 'UNIVERSAL',
  destination: 'universal',
  content: 'Prompt natural original.',
  summary: 'Versao original.',
  provider: 'OPENAI',
  model: 'configured-model',
  createdAt: now,
};
const preview: PromptPreview = {
  id: 'cm1234567890preview',
  promptVersionId: versionId,
  status: 'SUCCEEDED',
  content: 'Previa natural.',
  summary: 'Resumo da previa.',
  provider: 'OPENAI',
  model: 'configured-model',
  finishReason: 'completed',
  latencyMs: 100,
  createdAt: now,
  completedAt: now,
};

const wizard: PromptWizardInput = {
  extractionId: 'cm1234567890extract',
  category: 'application',
  objective: 'Build a maintainable app',
  audience: 'Developers',
  technologies: ['TypeScript'],
  exclusions: [],
  requirements: [],
  language: 'en-US',
  detail: 'balanced',
  destination: 'universal',
  freeInstructions: '',
};

const project: PromptProject = {
  id: projectId,
  extractionId: wizard.extractionId,
  title: wizard.objective,
  category: wizard.category,
  language: wizard.language,
  wizardInput: wizard,
  currentVersionId: null,
  state: 'ACTIVE',
  createdAt: now,
  updatedAt: now,
};

const job: PromptGenerationJob = {
  id: 'cm1234567890jobid',
  projectId,
  operation: 'GENERATE',
  provider: 'OPENAI',
  model: 'configured-model',
  credentialMode: 'PLATFORM_CREDITS',
  status: 'QUEUED',
  attempts: 0,
  maxAttempts: 3,
  sourcePromptVersionId: null,
  resultPromptVersionId: null,
  message: 'Queued',
  queuedAt: now,
  startedAt: null,
  finishedAt: null,
  createdAt: now,
  updatedAt: now,
};

const paidRequest = {
  provider: 'OPENAI' as const,
  model: 'configured-model',
  credentialMode: 'PLATFORM_CREDITS' as const,
  connectionId: null,
  acceptPlatformCharge: true,
  maximumCostMinor: '100',
};

function setup() {
  const repository: PromptProjectsRepositoryPort = {
    createProject: vi.fn().mockResolvedValue({ result: project, created: true }),
    findProjectOwned: vi.fn().mockResolvedValue(project),
    listProjectsOwned: vi.fn().mockResolvedValue({ items: [project], nextCursor: null }),
    findVersionOwned: vi.fn().mockResolvedValue({ id: versionId, projectId }),
    listVersionsOwned: vi.fn().mockResolvedValue({
      items: [
        {
          id: version.id,
          projectId: version.projectId,
          sequence: version.sequence,
          sourceVersionId: version.sourceVersionId,
          kind: version.kind,
          destination: version.destination,
          summary: version.summary,
          provider: version.provider,
          model: version.model,
          createdAt: version.createdAt,
        },
      ],
      nextCursor: null,
    }),
    getVersionOwned: vi.fn().mockResolvedValue(version),
    findPreviewByJobOwned: vi.fn().mockResolvedValue(preview),
    createEditedVersionOwned: vi.fn().mockResolvedValue({ result: version, created: true }),
    findActiveConnectionOwned: vi.fn().mockResolvedValue(true),
    createJob: vi
      .fn()
      .mockResolvedValue({ result: job, ownerId: 'cm1234567890owner', created: true }),
    findJobOwned: vi.fn().mockResolvedValue(job),
    failJob: vi.fn().mockResolvedValue(job),
    requestCancellation: vi.fn().mockResolvedValue(job),
    findOpenCreditReservationOwned: vi.fn().mockResolvedValue(null),
    findExtractionReportOwned: vi.fn().mockResolvedValue({
      url: 'https://example.com',
      finalUrl: 'https://example.com',
      fetchedAt: now,
      durationMs: 100,
      sections: {},
      investigation: investigationFixture(),
    }),
  };
  const queue: PromptGenerationQueuePort = { enqueue: vi.fn(), cancel: vi.fn() };
  const registry = {
    get: vi.fn().mockReturnValue({
      enabled: true,
      circuitBreakerOpen: false,
      credentialModes: ['API_KEY', 'PLATFORM_CREDITS'],
      previewEligible: true,
      contextWindowTokens: 10_000,
      maxOutputTokens: 1_000,
    }),
    assertModel: vi.fn((_provider, model: string) => model),
  };
  const credits = {
    reserve: vi.fn().mockResolvedValue({ id: 'cm1234567890reservation' }),
    reverse: vi.fn(),
  };
  const pricing = {
    quoteMaximum: vi.fn().mockReturnValue({
      pricingVersion: 'pricing-2026-07',
      amountMicros: 370_000n,
      amountMinor: 37n,
    }),
  };
  return {
    service: new PromptProjectsService(
      repository,
      queue,
      registry as never,
      credits as never,
      pricing as never,
    ),
    repository,
    queue,
    credits,
    registry,
    pricing,
  };
}

function investigationFixture() {
  const section = (title: string) => ({ title, summary: 'Resumo observável.', findings: [] });
  return {
    executiveSummary: {
      systemOverview: 'Sistema analisado.',
      constructionOverview: 'Construção baseada em evidências.',
      mainTechnologies: [],
      limitations: [],
      overallConfidence: 'probable',
      accessType: 'source_code',
    },
    technologyTable: [],
    sections: {
      frontend: section('Frontend'),
      designSystem: section('Design system'),
      backend: section('Backend'),
      apisCommunication: section('APIs'),
      authenticationSecurity: section('Segurança'),
      cmsContent: section('CMS'),
      infrastructureDeploy: section('Infraestrutura'),
      integrations: section('Integrações'),
      performanceAccessibility: section('Performance'),
    },
    diagramMermaid: 'flowchart TD\nU --> FE',
    estimatedProjectStructure: { disclaimer: 'Estimativa.', tree: 'src/' },
    risks: [],
    recommendations: [],
    conclusion: 'Conclusão.',
    confidenceMatrix: [],
    technicalEvidence: {
      analyzedUrls: ['https://example.com'],
      relevantHeaders: {},
      scripts: [],
      stylesheets: [],
      externalDomains: [],
      publicEndpoints: [],
      cookies: [],
      cssVariables: [],
      fonts: [],
      metadata: {},
      manifests: [],
      serviceWorkers: [],
    },
  } as const;
}

describe('PromptProjectsService', () => {
  it('quotes a conservative owner-scoped report cost with catalog metadata', async () => {
    const { service, repository, pricing } = setup();
    await expect(
      service.estimateCost(actor, { wizard, provider: 'OPENAI', model: 'configured-model' }),
    ).resolves.toMatchObject({
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: expect.any(String),
    });
    expect(repository.findExtractionReportOwned).toHaveBeenCalledWith(actor, wizard.extractionId);
    expect(pricing.quoteMaximum).toHaveBeenCalledWith(
      'OPENAI',
      'configured-model',
      expect.any(Number),
      1_000,
    );
  });

  it('does not reveal whether an extraction report belongs to another owner', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findExtractionReportOwned).mockResolvedValue(null);
    await expect(
      service.estimateCost(actor, { wizard, provider: 'OPENAI', model: 'configured-model' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('quotes the exact owner-scoped immutable version for adaptation and preview', async () => {
    const { service, repository, pricing } = setup();
    await expect(
      service.estimateVersionCost(actor, versionId, {
        provider: 'OPENAI',
        model: 'configured-model',
        operation: 'ADAPT',
        destination: 'codex',
      }),
    ).resolves.toMatchObject({
      sourceVersionId: versionId,
      operation: 'ADAPT',
      reportSections: expect.arrayContaining(['technologies', 'evidence']),
      maximumInputTokens: expect.any(Number),
      maximumOutputTokens: 1_000,
      maximumCostMinor: '37',
      pricingVersion: 'pricing-2026-07',
      quotedAt: expect.any(String),
      retentionNotice: expect.any(String),
    });
    expect(repository.getVersionOwned).toHaveBeenCalledWith(actor, versionId);
    expect(pricing.quoteMaximum).toHaveBeenCalledWith(
      'OPENAI',
      'configured-model',
      expect.any(Number),
      1_000,
    );
  });

  it('does not reveal whether a quoted version belongs to another owner', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.getVersionOwned).mockResolvedValue(null);
    await expect(
      service.estimateVersionCost(actor, versionId, {
        provider: 'OPENAI',
        model: 'configured-model',
        operation: 'PREVIEW',
      }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
  it('reads only owner-scoped version and preview projections', async () => {
    const { service, repository } = setup();
    await expect(service.listVersions(actor, projectId, { limit: 20 })).resolves.toMatchObject({
      items: [expect.objectContaining({ id: versionId })],
    });
    await expect(service.getVersion(actor, versionId)).resolves.toMatchObject({
      content: 'Prompt natural original.',
    });
    await expect(service.getPreview(actor, job.id)).resolves.toMatchObject({
      content: 'Previa natural.',
    });
    expect(repository.findPreviewByJobOwned).toHaveBeenCalledWith(actor, job.id);
  });

  it('creates a new immutable edited version through durable persistence', async () => {
    const { service, repository } = setup();
    await service.editVersion(actor, versionId, { content: 'Prompt natural editado.' }, 'edit:key');
    expect(repository.createEditedVersionOwned).toHaveBeenCalledWith(
      actor,
      versionId,
      { content: 'Prompt natural editado.' },
      'edit:key',
    );
  });

  it('does not distinguish absent and cross-owner version detail', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.getVersionOwned).mockResolvedValue(null);
    await expect(service.getVersion(actor, versionId)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND', message: 'resource not found' },
    });
  });

  it('returns the same public not-found response for inaccessible previews and edit sources', async () => {
    const previewCase = setup();
    vi.mocked(previewCase.repository.findPreviewByJobOwned).mockResolvedValue(null);
    await expect(previewCase.service.getPreview(actor, job.id)).rejects.toMatchObject({
      response: { code: 'NOT_FOUND', message: 'resource not found' },
    });
    const editCase = setup();
    vi.mocked(editCase.repository.createEditedVersionOwned).mockResolvedValue(null);
    await expect(
      editCase.service.editVersion(actor, versionId, { content: 'Prompt seguro.' }, 'edit:key'),
    ).rejects.toMatchObject({ response: { code: 'NOT_FOUND', message: 'resource not found' } });
  });

  it('cannot create a project from another user extraction', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.createProject).mockResolvedValue(null);
    await expect(service.create(actor, wizard, 'project:key')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('keeps initial generation universal and reserves destinations for adaptations', async () => {
    const { service, repository } = setup();
    await expect(
      service.create(actor, { ...wizard, destination: 'codex' }, 'project:key'),
    ).rejects.toMatchObject({ response: { code: 'VALIDATION' } });
    expect(repository.createProject).not.toHaveBeenCalled();
  });

  it('reuses the durable job for a repeated generation idempotency key', async () => {
    const { service, repository, queue, credits } = setup();
    const first = await service.generate(actor, projectId, paidRequest, 'generation:key');
    expect(repository.createJob).toHaveBeenCalledWith(
      actor,
      expect.objectContaining({ projectId, operation: 'GENERATE' }),
      'generation:key',
      paidRequest,
    );
    vi.mocked(repository.createJob).mockResolvedValue({
      result: job,
      ownerId: 'cm1234567890owner',
      created: false,
    });
    const second = await service.generate(actor, projectId, paidRequest, 'generation:key');
    expect(second.id).toBe(first.id);
    expect(queue.enqueue).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenLastCalledWith(job.id);
    expect(credits.reserve).toHaveBeenCalledTimes(2);
    expect(credits.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        idempotencyKey: `prompt-job:${job.id}`,
      }),
    );
  });

  it('recovers a durable queued job after a crash before credit reservation', async () => {
    const { service, repository, queue, credits } = setup();
    vi.mocked(repository.createJob).mockResolvedValue({
      result: job,
      ownerId: 'cm1234567890owner',
      created: false,
    });

    await expect(
      service.generate(actor, projectId, paidRequest, 'generation:after-job-commit'),
    ).resolves.toMatchObject({ id: job.id, status: 'QUEUED' });

    expect(credits.reserve).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: job.id,
        idempotencyKey: `prompt-job:${job.id}`,
        amountMinor: 100n,
      }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it('recovers a durable queued job after a crash following credit reservation', async () => {
    const { service, repository, queue, credits } = setup();
    vi.mocked(repository.createJob).mockResolvedValue({
      result: job,
      ownerId: 'cm1234567890owner',
      created: false,
    });
    vi.mocked(credits.reserve).mockResolvedValue({ id: 'cmexistingreservation0001' });

    await expect(
      service.generate(actor, projectId, paidRequest, 'generation:after-reservation'),
    ).resolves.toMatchObject({ id: job.id, status: 'QUEUED' });

    expect(credits.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: `prompt-job:${job.id}` }),
    );
    expect(queue.enqueue).toHaveBeenCalledWith(job.id);
  });

  it('requires explicit consent for platform credits before persistence', async () => {
    const { service, repository } = setup();
    await expect(
      service.preview(
        actor,
        versionId,
        { ...paidRequest, acceptPlatformCharge: false },
        'preview:key',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'COST_CONSENT_REQUIRED',
        message: 'Confirm the maximum platform credit charge before continuing.',
      },
    });
    expect(repository.createJob).not.toHaveBeenCalled();
  });

  it('requires an owned active compatible connection for user credentials', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.findActiveConnectionOwned).mockResolvedValue(false);
    await expect(
      service.generate(
        actor,
        projectId,
        {
          provider: 'OPENAI',
          model: 'configured-model',
          credentialMode: 'API_KEY',
          connectionId: 'cm1234567890connection',
          acceptPlatformCharge: false,
          maximumCostMinor: null,
        },
        'generation:key',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('binds adaptation and preview jobs to the exact owned source version', async () => {
    const { service, repository } = setup();
    await service.adapt(actor, versionId, { ...paidRequest, destination: 'codex' }, 'adapt:key');
    await service.preview(actor, versionId, paidRequest, 'preview:key');
    expect(repository.createJob).toHaveBeenNthCalledWith(
      1,
      actor,
      expect.objectContaining({
        operation: 'ADAPT',
        projectId,
        sourcePromptVersionId: versionId,
      }),
      'adapt:key',
      { ...paidRequest, destination: 'codex' },
    );
    expect(repository.createJob).toHaveBeenNthCalledWith(
      2,
      actor,
      expect.objectContaining({
        operation: 'PREVIEW',
        projectId,
        sourcePromptVersionId: versionId,
      }),
      'preview:key',
      paidRequest,
    );
  });

  it('fails the job and reverses its reservation when queue submission fails', async () => {
    const { service, repository, queue, credits } = setup();
    vi.mocked(queue.enqueue).mockRejectedValue(new Error('redis password=secret'));
    await expect(
      service.generate(actor, projectId, paidRequest, 'generation:key'),
    ).rejects.toMatchObject({ status: 503 });
    expect(repository.failJob).toHaveBeenCalledWith(actor, job.id, 'QUEUE_UNAVAILABLE');
    expect(credits.reverse).toHaveBeenCalledWith(
      expect.objectContaining({
        reservationId: 'cm1234567890reservation',
      }),
    );
  });

  it.each(['RUNNING', 'SUCCEEDED'] as const)(
    'preserves the reservation when queue add rejects after the job became %s',
    async (status) => {
      const { service, repository, queue, credits } = setup();
      vi.mocked(queue.enqueue).mockRejectedValue(new Error('ambiguous queue result'));
      vi.mocked(repository.failJob).mockResolvedValue(null);
      vi.mocked(repository.findJobOwned).mockResolvedValue({
        ...job,
        status,
        message: status === 'RUNNING' ? 'Running' : 'Completed',
        ...(status === 'SUCCEEDED' ? { finishedAt: now } : {}),
      });

      await expect(
        service.generate(actor, projectId, paidRequest, `generation:${status}`),
      ).resolves.toMatchObject({ status });
      expect(credits.reverse).not.toHaveBeenCalled();
    },
  );

  it('reconciles an open reservation when queue-failure reversal is replayed', async () => {
    const { service, repository, queue, credits } = setup();
    vi.mocked(queue.enqueue).mockRejectedValue(new Error('redis unavailable'));
    vi.mocked(credits.reverse).mockRejectedValueOnce(new Error('ledger temporarily unavailable'));

    await expect(
      service.generate(actor, projectId, paidRequest, 'generation:reconcile'),
    ).rejects.toThrow('ledger temporarily unavailable');
    vi.mocked(repository.createJob).mockResolvedValue({
      result: {
        ...job,
        status: 'FAILED',
        errorCode: 'QUEUE_UNAVAILABLE',
        message: 'generation submission failed',
        retryable: true,
        finishedAt: now,
      },
      ownerId: 'cm1234567890owner',
      created: false,
    });
    vi.mocked(repository.findOpenCreditReservationOwned).mockResolvedValue(
      'cm1234567890reservation',
    );
    vi.mocked(credits.reverse).mockResolvedValue(undefined);

    await expect(
      service.generate(actor, projectId, paidRequest, 'generation:reconcile'),
    ).resolves.toMatchObject({ status: 'FAILED' });
    expect(credits.reverse).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it('sanitizes queue failure for user credentials without paid fallback', async () => {
    const { service, repository, queue, credits } = setup();
    vi.mocked(queue.enqueue).mockRejectedValue(new Error('redis password=secret'));
    await expect(
      service.generate(
        actor,
        projectId,
        {
          provider: 'OPENAI',
          model: 'configured-model',
          credentialMode: 'API_KEY',
          connectionId: 'cm1234567890connection',
          acceptPlatformCharge: false,
          maximumCostMinor: null,
        },
        'generation:api-key-failure',
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(repository.failJob).toHaveBeenCalledWith(actor, job.id, 'QUEUE_UNAVAILABLE');
    expect(credits.reserve).not.toHaveBeenCalled();
  });

  it('returns not found for a list cursor outside the owner scope', async () => {
    const { service, repository } = setup();
    vi.mocked(repository.listProjectsOwned).mockResolvedValue(null as never);
    await expect(
      service.list(actor, { cursor: 'cm1234567890project', limit: 20 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('guards cancellation and removes only the queued transport job', async () => {
    const { service, repository, queue } = setup();
    await service.cancel(actor, job.id, 'cancel:key');
    expect(repository.requestCancellation).toHaveBeenCalledWith(actor, job.id, 'cancel:key');
    expect(queue.cancel).toHaveBeenCalledWith(job.id);
  });

  it('replays durable cancellation while reconciling external effects without a second transition', async () => {
    const { service, repository, queue, credits } = setup();
    const cancelled = {
      ...job,
      status: 'CANCELLED' as const,
      finishedAt: now,
      message: 'Cancelled',
    };
    vi.mocked(repository.requestCancellation).mockResolvedValue(cancelled);
    vi.mocked(repository.findOpenCreditReservationOwned)
      .mockResolvedValueOnce('cm1234567890reservation')
      .mockResolvedValueOnce(null);

    await service.cancel(actor, job.id, 'cancel:durable');
    vi.mocked(repository.findJobOwned).mockResolvedValue(cancelled);
    await service.cancel(actor, job.id, 'cancel:durable');

    expect(repository.requestCancellation).toHaveBeenCalledTimes(2);
    expect(queue.cancel).toHaveBeenCalledTimes(2);
    expect(credits.reverse).toHaveBeenCalledTimes(1);
  });

  it('maps model, provider, and credit failures to allowed actionable public errors', async () => {
    const modelCase = setup();
    modelCase.registry.assertModel.mockImplementation(() => {
      throw new ProviderFailure('MODEL_UNAVAILABLE');
    });
    await expect(
      modelCase.service.generate(actor, projectId, paidRequest, 'generation:model-error'),
    ).rejects.toMatchObject({
      response: {
        code: 'MODEL_UNAVAILABLE',
        message: 'The selected model is unavailable. Choose a configured model and try again.',
      },
    });

    const providerCase = setup();
    providerCase.registry.get.mockImplementation(() => {
      throw new ProviderFailure('PROVIDER_NOT_CONFIGURED');
    });
    await expect(
      providerCase.service.generate(actor, projectId, paidRequest, 'generation:provider-error'),
    ).rejects.toMatchObject({
      response: {
        code: 'PROVIDER_UNAVAILABLE',
        message: 'The selected provider is currently unavailable. Try again later.',
      },
    });

    const creditsCase = setup();
    creditsCase.credits.reserve.mockRejectedValue(new Error('INSUFFICIENT_CREDITS'));
    await expect(
      creditsCase.service.generate(actor, projectId, paidRequest, 'generation:credits-error'),
    ).rejects.toMatchObject({
      response: {
        code: 'INSUFFICIENT_CREDITS',
        message: 'There are not enough platform credits for this request.',
      },
    });

    const dailyBudgetCase = setup();
    dailyBudgetCase.credits.reserve.mockRejectedValue(new Error('CREDIT_DAILY_BUDGET_EXCEEDED'));
    await expect(
      dailyBudgetCase.service.generate(actor, projectId, paidRequest, 'generation:daily-budget'),
    ).rejects.toMatchObject({ status: 402, response: { code: 'COST_LIMIT_EXCEEDED' } });
    expect(dailyBudgetCase.queue.enqueue).not.toHaveBeenCalled();
  });

  it('reverses a queued platform-credit reservation and retries reconciliation idempotently', async () => {
    const { service, repository, credits } = setup();
    vi.mocked(repository.findOpenCreditReservationOwned).mockResolvedValue(
      'cm1234567890reservation',
    );
    vi.mocked(repository.requestCancellation).mockResolvedValue({
      ...job,
      status: 'CANCELLED',
      finishedAt: now,
      message: 'Cancelled',
    });
    vi.mocked(credits.reverse).mockRejectedValueOnce(new Error('temporary ledger error'));

    await expect(service.cancel(actor, job.id, 'cancel:key')).rejects.toThrow(
      'temporary ledger error',
    );
    vi.mocked(repository.findJobOwned).mockResolvedValue({
      ...job,
      status: 'CANCELLED',
      finishedAt: now,
      message: 'Cancelled',
    });
    vi.mocked(credits.reverse).mockResolvedValue(undefined);
    await expect(service.cancel(actor, job.id, 'cancel:key')).resolves.toMatchObject({
      status: 'CANCELLED',
    });
    expect(credits.reverse).toHaveBeenCalledTimes(2);
  });
});
