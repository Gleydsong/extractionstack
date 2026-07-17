import { describe, expect, it, vi } from 'vitest';
import type { PromptProjectsService } from './prompt-projects.service.js';
import {
  PromptProjectsController,
  PromptJobsController,
  PromptVersionsController,
} from './prompt-projects.controller.js';

describe('prompt project controllers', () => {
  const user = { sub: 'auth0|owner', roles: ['user'] as ('user' | 'admin')[] };

  it('passes only the actor, strict DTO, resource id, and idempotency key', async () => {
    const generate = vi.fn();
    const service = { generate } as unknown as PromptProjectsService;
    const controller = new PromptProjectsController(service);
    const body = {
      provider: 'OPENAI',
      model: 'configured-model',
      credentialMode: 'PLATFORM_CREDITS',
      connectionId: null,
      acceptPlatformCharge: true,
      maximumCostMinor: '100',
    } as const;
    await controller.generate({ user }, 'cm1234567890project', body, 'generation:key');
    expect(generate).toHaveBeenCalledWith(user, 'cm1234567890project', body, 'generation:key');
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
});
