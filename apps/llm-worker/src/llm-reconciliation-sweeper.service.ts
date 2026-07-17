import { Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { LlmJobRepository } from './llm-job.repository';

export interface LlmRecoveryQueuePort {
  enqueue(jobId: string): Promise<void>;
}

export class LlmReconciliationSweeperService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LlmReconciliationSweeperService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly repository: LlmJobRepository,
    private readonly deliveryQueue: LlmRecoveryQueuePort,
    private readonly intervalMs = 5_000,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref();
    void this.runOnce();
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.repository.sweepRecoverable(50);
      for (const delivery of result.deliveries) {
        await this.deliveryQueue.enqueue(delivery.jobId);
        await this.repository.acknowledgeRecoveryEnqueued(
          delivery.jobId,
          delivery.recoveryToken,
        );
      }
      if (result.completed || result.ambiguous || result.requeued || result.failed)
        this.logger.log(
          `llm reconciliation completed=${result.completed} ambiguous=${result.ambiguous} requeued=${result.requeued} failed=${result.failed}`,
        );
    } catch {
      this.logger.warn('llm reconciliation sweep failed errorType=Error');
    } finally {
      this.running = false;
    }
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
