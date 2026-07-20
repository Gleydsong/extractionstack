import { describe, expect, it, vi } from 'vitest';
import type { PromptCostEstimateRequest, PromptGenerationRequest } from '@extractionstack/shared';
import type { PromptProjectsService } from './prompt-projects.service.js';
import {
  PromptProjectsController,
  PromptJobsController,
  PromptVersionsController,
} from './prompt-projects.controller.js';
import { LLM_RATE_LIMIT_METADATA, LlmRatePolicies } from '../common/llm-rate-limit.guard.js';

describe('prompt project controllers', () => {
  const user = { sub: 'auth0|owner', roles: ['user'] as ('user' | 'admin')[] };

  it('passes only the actor, strict DTO, resource id, and idempotency key', async () => {
    const generate = vi.fn();
    const service = { generate } as unknown as PromptProjectsService;
    const controller = new PromptProjectsController(service);
    const body: PromptGenerationRequest = {
      provider: 'OPENAI',
      model: 'configured-model',
      credentialMode: 'PLATFORM_CREDITS',
      connectionId: null,
      acceptPlatformCharge: true,
      maximumCostMinor: '100',
    };
    await controller.generate({ user }, 'cm1234567890project', body, 'generation:key');
    expect(generate).toHaveBeenCalledWith(user, 'cm1234567890project', body, 'generation:key');
  });

  it('forwards owner-bound cost estimate inputs without an idempotency mutation key', async () => {
    const estimateCost = vi.fn();
    const controller = new PromptProjectsController({ estimateCost } as never);
    const body: PromptCostEstimateRequest = {
      wizard: {
        extractionId: 'cm1234567890extract',
        category: 'application',
        objective: 'Criar uma aplicação acessível.',
        audience: 'Desenvolvedores',
        technologies: [],
        exclusions: [],
        requirements: [],
        language: 'pt-BR',
        detail: 'balanced',
        destination: 'universal',
        freeInstructions: '',
      },
      provider: 'OPENAI',
      model: 'configured-model',
    };
    await controller.estimate({ user }, body);
    expect(estimateCost).toHaveBeenCalledWith(user, body);
  });

  it('keeps version and job routes on dedicated controllers', () => {
    expect(new PromptVersionsController({} as never)).toBeDefined();
    expect(new PromptJobsController({} as never)).toBeDefined();
  });

  it('requires and forwards idempotency for cancellation', async () => {
    const cancel = vi.fn();
    const controller = new PromptJobsController({ cancel } as unknown as PromptProjectsService);
    await controller.cancel({ user }, 'cm1234567890jobid', 'cancel:key');
    expect(cancel).toHaveBeenCalledWith(user, 'cm1234567890jobid', 'cancel:key');
  });

  it('forwards immutable edits and owner-scoped reads', async () => {
    const editVersion = vi.fn();
    const getVersion = vi.fn();
    const getPreview = vi.fn();
    const versions = new PromptVersionsController({ editVersion, getVersion } as never);
    const jobs = new PromptJobsController({ getPreview } as never);
    await versions.get({ user }, 'cm1234567890version');
    await versions.edit(
      { user },
      'cm1234567890version',
      { content: 'Prompt natural editado.' },
      'edit:key',
    );
    await jobs.preview({ user }, 'cm1234567890jobid');
    expect(getVersion).toHaveBeenCalledWith(user, 'cm1234567890version');
    expect(editVersion).toHaveBeenCalledWith(
      user,
      'cm1234567890version',
      { content: 'Prompt natural editado.' },
      'edit:key',
    );
    expect(getPreview).toHaveBeenCalledWith(user, 'cm1234567890jobid');
  });

  it('forwards an owner-scoped quote bound to the exact immutable version', async () => {
    const estimateVersionCost = vi.fn();
    const versions = new PromptVersionsController({ estimateVersionCost } as never);
    const body = {
      provider: 'OPENAI',
      model: 'configured-model',
      operation: 'PREVIEW',
    } as const;
    await versions.estimate({ user }, 'cm1234567890version', body);
    expect(estimateVersionCost).toHaveBeenCalledWith(user, 'cm1234567890version', body);
  });

  it('applies the specific LLM edit rate policy metadata to immutable edits', () => {
    expect(
      Reflect.getMetadata(LLM_RATE_LIMIT_METADATA, PromptVersionsController.prototype.edit),
    ).toBe(LlmRatePolicies.EDIT);
  });
});
