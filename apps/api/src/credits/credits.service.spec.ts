import { describe, expect, it, vi } from 'vitest';
import { CreditsService } from './credits.service.js';
import type { CreditReservationRecord, ReserveCreditsRecord } from './credits.repository.js';

const ownerId = 'owner-1';
const jobId = 'job-1';

describe('CreditsService', () => {
  it('returns public credit amounts as decimal strings', async () => {
    const repository = repositoryStub();
    repository.reserve.mockResolvedValue(reservationRecord());
    repository.getAvailableBalance.mockResolvedValue(9_900n);
    const service = new CreditsService(repository);

    await expect(service.reserve(ownerId, jobId, 100n, 'job-1')).resolves.toMatchObject({
      amountMinor: '100',
      maximumAcceptedAmountMinor: '100',
    });
    await expect(service.getAvailableBalance(ownerId)).resolves.toBe('9900');
  });

  it('implements the command-based credits port without changing public serialization', async () => {
    const repository = repositoryStub();
    const service = new CreditsService(repository);

    await expect(
      service.reserve({ ownerId, jobId, amountMinor: 100n, idempotencyKey: 'job-command' }),
    ).resolves.toMatchObject({ amountMinor: '100' });
    await service.confirm({ reservationId: 'reservation-1', actualAmountMinor: 80n });
    await service.reverse({ reservationId: 'reservation-2', reason: 'cancelled' });

    expect(repository.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ maximumAcceptedAmountMinor: 100n }),
    );
    expect(repository.confirm).toHaveBeenCalledWith('reservation-1', 80n);
    expect(repository.reverse).toHaveBeenCalledWith('reservation-2', 'cancelled');
  });

  it.each([0n, -1n, 1_000_000_000_001n])(
    'rejects an invalid reservation amount %s before persistence',
    async (amount) => {
      const repository = repositoryStub();
      const service = new CreditsService(repository);

      await expect(service.reserve(ownerId, jobId, amount, 'job-1')).rejects.toThrow(
        'CREDIT_AMOUNT_INVALID',
      );
      expect(repository.reserve).not.toHaveBeenCalled();
    },
  );

  it.each([-1n, 1_000_000_000_001n])(
    'rejects an invalid actual cost %s before persistence',
    async (amount) => {
      const repository = repositoryStub();
      const service = new CreditsService(repository);

      await expect(service.confirm('reservation-1', amount)).rejects.toThrow(
        'CREDIT_AMOUNT_INVALID',
      );
      expect(repository.confirm).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed owner, job, reservation, idempotency, and reversal reason values', async () => {
    const repository = repositoryStub();
    const service = new CreditsService(repository);

    await expect(service.reserve('', jobId, 1n, 'key')).rejects.toThrow('CREDIT_COMMAND_INVALID');
    await expect(service.reserve(ownerId, '', 1n, 'key')).rejects.toThrow('CREDIT_COMMAND_INVALID');
    await expect(service.reserve(ownerId, jobId, 1n, '')).rejects.toThrow('CREDIT_COMMAND_INVALID');
    await expect(service.confirm('', 1n)).rejects.toThrow('CREDIT_COMMAND_INVALID');
    await expect(service.reverse('reservation-1', '')).rejects.toThrow('CREDIT_COMMAND_INVALID');
    expect(repository.reserve).not.toHaveBeenCalled();
    expect(repository.confirm).not.toHaveBeenCalled();
    expect(repository.reverse).not.toHaveBeenCalled();
  });
});

function reservationRecord(): CreditReservationRecord {
  return {
    id: 'reservation-1',
    ownerId,
    jobId,
    amountMinor: 100n,
    maximumAcceptedAmountMinor: 100n,
    createdAt: new Date('2026-07-17T12:00:00.000Z'),
  };
}

function repositoryStub() {
  const reserve = vi.fn(async (_command: ReserveCreditsRecord) => reservationRecord());
  const confirm = vi.fn(async (_reservationId: string, _actualAmountMinor: bigint) => undefined);
  const reverse = vi.fn(async (_reservationId: string, _reason: string) => undefined);
  const getAvailableBalance = vi.fn(async (_ownerId: string) => 0n);
  return { reserve, confirm, reverse, getAvailableBalance };
}
