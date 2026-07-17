import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import {
  LlmReconciliationCommandSchema,
  LlmReconciliationController,
} from './llm-reconciliation.controller';

describe('LLM reconciliation admin boundary', () => {
  it('is admin-only and forwards bounded actor/job/evidence/idempotency', async () => {
    expect(Reflect.getMetadata(ROLES_KEY, LlmReconciliationController)).toEqual(['admin']);
    const reconcile = vi
      .fn()
      .mockResolvedValue({ jobId: 'job-1', status: 'accepted', replayed: false });
    const controller = new LlmReconciliationController({ reconcile } as never);
    const actor = { sub: 'auth0|admin', roles: ['admin'] as ('user' | 'admin')[] };
    const body = {
      command: 'REVERSE_NOT_CHARGED' as const,
      reason: 'provider confirms no charge',
      evidence: 'ticket-123456',
    };
    await controller.reconcile({ user: actor }, 'job-1', body, 'reconcile-key');
    expect(reconcile).toHaveBeenCalledWith(actor, 'job-1', body, 'reconcile-key');
  });

  it('rejects unknown fields and cost on reverse commands', () => {
    expect(
      LlmReconciliationCommandSchema.safeParse({
        command: 'REVERSE_NOT_CHARGED',
        reason: 'provider confirms no charge',
        evidence: 'ticket-123456',
        secret: 'x',
      }).success,
    ).toBe(false);
    expect(
      LlmReconciliationCommandSchema.safeParse({
        command: 'REVERSE_NOT_CHARGED',
        reason: 'provider confirms no charge',
        evidence: 'ticket-123456',
        actualCostMinor: '1',
      }).success,
    ).toBe(false);
  });

  it('returns forbidden semantics for a non-admin actor', () => {
    const guard = new RolesGuard(new Reflector());
    const context = {
      getHandler: () => LlmReconciliationController.prototype.reconcile,
      getClass: () => LlmReconciliationController,
      switchToHttp: () => ({ getRequest: () => ({ user: { roles: ['user'] } }) }),
    };
    try {
      guard.canActivate(context as never);
      throw new Error('expected forbidden');
    } catch (error) {
      expect(error).toMatchObject({ status: 403 });
    }
  });
});
