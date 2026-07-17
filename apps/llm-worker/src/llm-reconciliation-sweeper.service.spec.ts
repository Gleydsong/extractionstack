import { describe, expect, it, vi } from 'vitest';
import { LlmReconciliationSweeperService } from './llm-reconciliation-sweeper.service';

describe('LlmReconciliationSweeperService', () => {
  it('runs bounded repository recovery and suppresses overlapping runs', async () => {
    let release!: () => void;
    const repository = {
      sweepRecoverable: vi.fn(
        () =>
          new Promise<{ completed: number; ambiguous: number }>((resolve) => {
            release = () => resolve({ completed: 1, ambiguous: 0 });
          }),
      ),
    };
    const service = new LlmReconciliationSweeperService(repository as never);
    const first = service.runOnce();
    await service.runOnce();
    expect(repository.sweepRecoverable).toHaveBeenCalledOnce();
    release();
    await first;
  });
});
