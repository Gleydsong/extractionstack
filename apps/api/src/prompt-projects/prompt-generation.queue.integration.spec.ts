import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  BullMqPromptGenerationQueue,
  LLM_QUEUE_NAME,
  type LlmQueuePayload,
} from './prompt-generation.queue.js';

const redisUrl = process.env.TEST_REDIS_URL;
const describeRedis = redisUrl ? describe : describe.skip;

describeRedis('BullMqPromptGenerationQueue Redis integration', () => {
  let queue: Queue<LlmQueuePayload>;
  let subject: BullMqPromptGenerationQueue;

  beforeAll(() => {
    const url = new URL(redisUrl!);
    queue = new Queue<LlmQueuePayload>(LLM_QUEUE_NAME, {
      prefix: `test:prompt-generation:${randomUUID()}`,
      connection: {
        host: url.hostname,
        port: Number(url.port || 6379),
        username: url.username || undefined,
        password: url.password || undefined,
        db: url.pathname.length > 1 ? Number(url.pathname.slice(1)) : 0,
      },
    });
    subject = new BullMqPromptGenerationQueue(queue);
  });

  afterAll(async () => {
    await queue.obliterate({ force: true });
    await subject.onModuleDestroy();
  });

  it('deduplicates replay by domain job id and stores only the bounded payload', async () => {
    const jobId = `cm${randomUUID().replaceAll('-', '')}`;
    await subject.enqueue(jobId);
    await subject.enqueue(jobId);

    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: jobId, name: LLM_QUEUE_NAME, data: { jobId } });
    expect(jobs[0]!.opts).toMatchObject({
      attempts: 10,
      backoff: { type: 'llm-bounded-jitter' },
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: false,
    });
  });

  it('removes waiting and delayed jobs during cancellation', async () => {
    const waitingId = `cm${randomUUID().replaceAll('-', '')}`;
    const delayedId = `cm${randomUUID().replaceAll('-', '')}`;
    await subject.enqueue(waitingId);
    await queue.add(LLM_QUEUE_NAME, { jobId: delayedId }, { jobId: delayedId, delay: 60_000 });

    await subject.cancel(waitingId);
    await subject.cancel(delayedId);
    expect(await queue.getJob(waitingId)).toBeUndefined();
    expect(await queue.getJob(delayedId)).toBeUndefined();
  });
});
