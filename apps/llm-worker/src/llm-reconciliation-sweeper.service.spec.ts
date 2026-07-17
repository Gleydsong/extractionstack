import { describe, expect, it, vi } from 'vitest';
import { LlmReconciliationSweeperService } from './llm-reconciliation-sweeper.service';

describe('LlmReconciliationSweeperService', () => {
  it('runs bounded repository recovery and suppresses overlapping runs', async () => {
    let release!: () => void;
    const repository = {
      sweepRecoverable: vi.fn(
        () =>
          new Promise<{
            completed: number;
            ambiguous: number;
            requeued: number;
            failed: number;
            deliveries: [];
          }>((resolve) => {
            release = () =>
              resolve({ completed: 1, ambiguous: 0, requeued: 0, failed: 0, deliveries: [] });
          }),
      ),
    };
    const service = new LlmReconciliationSweeperService(repository as never, { enqueue: vi.fn() });
    const first = service.runOnce();
    await service.runOnce();
    expect(repository.sweepRecoverable).toHaveBeenCalledOnce();
    release();
    await first;
  });

  it('acknowledges durable recovery only after queue delivery exists', async () => {
    const repository = {
      sweepRecoverable: vi.fn().mockResolvedValue({
        completed: 0,
        ambiguous: 0,
        requeued: 1,
        failed: 0,
        deliveries: [{ jobId: 'job-1', recoveryToken: 'token-1' }],
      }),
      acknowledgeRecoveryEnqueued: vi.fn().mockResolvedValue(true),
    };
    const queue = { enqueue: vi.fn().mockResolvedValue(undefined) };
    const service = new LlmReconciliationSweeperService(repository as never, queue);

    await service.runOnce();

    expect(queue.enqueue).toHaveBeenCalledWith('job-1');
    expect(repository.acknowledgeRecoveryEnqueued).toHaveBeenCalledWith('job-1', 'token-1');
  });

  it('keeps the database recovery marker when queue delivery fails', async () => {
    const repository = {
      sweepRecoverable: vi.fn().mockResolvedValue({
        completed: 0,
        ambiguous: 0,
        requeued: 1,
        failed: 0,
        deliveries: [{ jobId: 'job-1', recoveryToken: 'token-1' }],
      }),
      acknowledgeRecoveryEnqueued: vi.fn(),
    };
    const queue = { enqueue: vi.fn().mockRejectedValue(new Error('redis unavailable')) };
    const service = new LlmReconciliationSweeperService(repository as never, queue);

    await service.runOnce();

    expect(repository.acknowledgeRecoveryEnqueued).not.toHaveBeenCalled();
  });
});
