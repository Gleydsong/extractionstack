import { describe, expect, it, vi } from 'vitest';
import { LlmReconciliationService } from './llm-reconciliation.service';

const actor = { sub: 'auth0|admin', roles: ['admin'] } as never;
const command = {
  command: 'REVERSE_NOT_CHARGED' as const,
  reason: 'provider confirmed no charge',
  evidence: 'support-ticket-123456',
};

describe('LlmReconciliationService', () => {
  it('returns the same public 404 when the job does not exist', async () => {
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
      mutationIdempotency: { findUnique: vi.fn().mockResolvedValue(null) },
      promptGenerationJob: { findUnique: vi.fn().mockResolvedValue(null) },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const service = new LlmReconciliationService(prisma as never);

    await expect(service.reconcile(actor, 'missing-job', command, 'key-1')).rejects.toMatchObject({
      status: 404,
      response: { code: 'NOT_FOUND' },
    });
  });

  it('replays a completed idempotent command without touching the job or ledger', async () => {
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
      mutationIdempotency: {
        findUnique: vi.fn().mockResolvedValue({
          requestHash: 'f2c6542d0315c3a25676050c66849fdf84ba581dbc4171730ac194aed7179dda',
        }),
      },
      promptGenerationJob: { findUnique: vi.fn() },
      creditLedgerEntry: { create: vi.fn() },
    };
    const prisma = {
      $transaction: vi.fn((callback) => callback(transaction)),
    };
    const service = new LlmReconciliationService(prisma as never);

    const result = await service.reconcile(actor, 'job-1', command, 'key-1');
    expect(result).toEqual({ jobId: 'job-1', status: 'accepted', replayed: true });
    expect(transaction.promptGenerationJob.findUnique).not.toHaveBeenCalled();
    expect(transaction.creditLedgerEntry.create).not.toHaveBeenCalled();
  });

  it('records zero-delta confirmation, audit, and idempotency in one transaction', async () => {
    const transaction = {
      user: { findUnique: vi.fn().mockResolvedValue({ id: 'admin-1' }) },
      mutationIdempotency: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
      promptGenerationJob: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'job-1',
          ownerId: 'owner-1',
          status: 'AMBIGUOUS',
          providerStage: 'STARTED',
          providerSnapshot: null,
          creditLedgerEntries: [
            {
              id: 'reservation-1',
              ownerId: 'owner-1',
              amountMinor: -100n,
              currency: 'CREDITS',
              metadata: { maximumAcceptedAmountMinor: '100' },
            },
          ],
        }),
        update: vi.fn().mockResolvedValue({}),
      },
      creditLedgerEntry: { create: vi.fn().mockResolvedValue({}) },
      auditEvent: { create: vi.fn().mockResolvedValue({}) },
    };
    const prisma = { $transaction: vi.fn((callback) => callback(transaction)) };
    const service = new LlmReconciliationService(prisma as never);

    await expect(
      service.reconcile(
        actor,
        'job-1',
        {
          command: 'CONFIRM_ACTUAL_COST',
          reason: 'provider invoice confirmed',
          evidence: 'invoice-reference-12345',
          actualCostMinor: '100',
        },
        'key-confirm',
      ),
    ).resolves.toEqual({ jobId: 'job-1', status: 'accepted', replayed: false });
    expect(transaction.creditLedgerEntry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ kind: 'CONFIRMATION', amountMinor: 0n }),
    });
    expect(transaction.auditEvent.create).toHaveBeenCalledOnce();
    expect(transaction.mutationIdempotency.create).toHaveBeenCalledOnce();
  });
});
