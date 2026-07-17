import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LlmQueueWorkerService } from './llm-queue-worker.service';
import { LLM_QUEUE_NAME } from './llm-worker.types';

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('LLM BullMQ worker Redis integration', () => {
  const resources: Array<{ close(): Promise<unknown> }> = [];
  afterEach(async () => {
    for (const resource of resources.splice(0).reverse()) await resource.close();
  });

  it('processes one domain job when Bull receives duplicate delivery', async () => {
    const connection = new IORedis(redisUrl!, { maxRetriesPerRequest: null });
    const queue = new Queue(LLM_QUEUE_NAME, { connection });
    resources.push(queue, { close: () => connection.quit() });
    await queue.obliterate({ force: true }).catch(() => undefined);
    const process = vi.fn().mockResolvedValue(undefined);
    const worker = new LlmQueueWorkerService({ process } as never, {
      redisUrl: redisUrl!,
      concurrency: 1,
      random: () => 0.5,
    });
    worker.onModuleInit();
    resources.push({ close: () => worker.onModuleDestroy() });

    const options = {
      jobId: 'worker-integration-job',
      attempts: 3,
      backoff: { type: 'llm-bounded-jitter' },
    };
    await Promise.all([
      queue.add(LLM_QUEUE_NAME, { jobId: 'worker-integration-job' }, options),
      queue.add(LLM_QUEUE_NAME, { jobId: 'worker-integration-job' }, options),
    ]);
    await waitFor(() => process.mock.calls.length === 1);
    expect(process).toHaveBeenCalledOnce();
    expect(process).toHaveBeenCalledWith('worker-integration-job', 1, 3);
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('integration timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
