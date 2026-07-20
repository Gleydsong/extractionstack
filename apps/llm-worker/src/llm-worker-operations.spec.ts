import { describe, expect, it, vi } from 'vitest';
import { LlmWorkerOperationsService } from './llm-worker-operations.service.js';

describe('LlmWorkerOperationsService', () => {
  it('publishes heartbeat and reports readiness without provider calls', async () => {
    const dependencies = {
      database: vi.fn().mockResolvedValue(true),
      redis: vi.fn().mockResolvedValue(true),
      queue: vi.fn().mockResolvedValue(true),
      publishHeartbeat: vi.fn().mockResolvedValue(undefined),
      publishSnapshot: vi.fn().mockResolvedValue(undefined),
    };
    const service = new LlmWorkerOperationsService(dependencies);
    await service.heartbeat();
    await expect(service.readiness()).resolves.toEqual({
      status: 'ok',
      checks: { database: true, redis: true, queue: true, configuration: true },
    });
    expect(dependencies.publishHeartbeat).toHaveBeenCalledOnce();
    expect(dependencies.publishSnapshot).toHaveBeenCalledWith(
      expect.stringContaining('extractionstack_'),
    );
  });

  it('uses bounded metric labels and excludes identifiers and raw data', async () => {
    const service = new LlmWorkerOperationsService({
      database: async () => true,
      redis: async () => true,
      queue: async () => true,
      publishHeartbeat: async () => undefined,
    });
    service.recordJob({
      provider: 'OPENAI',
      model: 'not-allowlisted-user-model',
      mode: 'API_KEY',
      operation: 'GENERATE',
      status: 'FAILED',
      errorCategory: 'secret-provider-body',
      durationSeconds: 1,
      retries: 2,
    });
    const metrics = await service.metrics();
    expect(metrics).toContain('extractionstack_llm_worker_jobs_total');
    expect(metrics).toContain('model="other"');
    expect(metrics).toContain('error_category="internal"');
    expect(metrics).not.toMatch(/owner|job_id|prompt|requested_url|exception|connection/i);
    expect(metrics).not.toContain('secret-provider-body');
  });

  it('does not publish a ready heartbeat while a required dependency is unavailable', async () => {
    const publishHeartbeat = vi.fn();
    const service = new LlmWorkerOperationsService({
      database: async () => false,
      redis: async () => true,
      queue: async () => true,
      publishHeartbeat,
    });

    await expect(service.heartbeat()).rejects.toThrow('LLM_WORKER_NOT_READY');
    expect(publishHeartbeat).not.toHaveBeenCalled();
  });
});
