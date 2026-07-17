import { describe, expect, it, vi } from 'vitest';
import { BullMqPromptGenerationQueue, LLM_QUEUE_NAME } from './prompt-generation.queue.js';

describe('BullMqPromptGenerationQueue', () => {
  it('enqueues only the domain job id with bounded retry and retention settings', async () => {
    const add = vi.fn().mockResolvedValue(undefined);
    const queue = new BullMqPromptGenerationQueue({
      add,
      getJob: vi.fn().mockResolvedValue(null),
      close: vi.fn(),
    } as never);

    await queue.enqueue('cm1234567890abcdef');

    expect(add).toHaveBeenCalledWith(
      LLM_QUEUE_NAME,
      { jobId: 'cm1234567890abcdef' },
      {
        jobId: 'cm1234567890abcdef',
        attempts: 3,
        backoff: { type: 'llm-bounded-jitter' },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: false,
      },
    );
  });

  it('does not duplicate a transport job when a durable request is replayed', async () => {
    const add = vi.fn();
    const queue = new BullMqPromptGenerationQueue({
      add,
      getJob: vi.fn().mockResolvedValue({ id: 'cm1234567890abcdef' }),
      close: vi.fn(),
    } as never);
    await queue.enqueue('cm1234567890abcdef');
    expect(add).not.toHaveBeenCalled();
  });

  it.each(['waiting', 'delayed'])('removes only a %s job on cancellation', async (state) => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const queue = new BullMqPromptGenerationQueue({
      add: vi.fn(),
      getJob: vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue(state), remove }),
      close: vi.fn(),
    } as never);

    await queue.cancel('cm1234567890abcdef');
    expect(remove).toHaveBeenCalledOnce();
  });

  it.each(['active', 'completed', 'failed'])('does not remove a %s job', async (state) => {
    const remove = vi.fn();
    const queue = new BullMqPromptGenerationQueue({
      add: vi.fn(),
      getJob: vi.fn().mockResolvedValue({ getState: vi.fn().mockResolvedValue(state), remove }),
      close: vi.fn(),
    } as never);

    await queue.cancel('cm1234567890abcdef');
    expect(remove).not.toHaveBeenCalled();
  });
});
