import { describe, expect, it } from 'vitest';
import {
  aggregateBoundedJobMetrics,
  parseWorkerMetricsSnapshot,
  type JobMetricRow,
} from './operations.service.js';

describe('aggregateBoundedJobMetrics', () => {
  it('sums rows collapsing into the same final bounded labels', () => {
    const base: JobMetricRow = {
      provider: 'OPENAI',
      model: 'user-model-a',
      credentialMode: 'API_KEY',
      operation: 'GENERATE',
      status: 'FAILED',
      errorCode: 'SECRET_A',
      count: 2n,
      retries: 3n,
      tokens: 5n,
      cost: 7n,
    };
    const totals = aggregateBoundedJobMetrics(
      [
        base,
        {
          ...base,
          model: 'user-model-b',
          errorCode: 'SECRET_B',
          count: 11n,
          retries: 13n,
          tokens: 17n,
          cost: 19n,
        },
      ],
      new Set(['gpt-5-mini']),
    );
    expect(totals.jobs).toEqual([
      {
        labels: expect.objectContaining({ model: 'other', error_category: 'internal' }),
        count: 13,
      },
    ]);
    expect(totals.usage).toEqual([
      { labels: expect.objectContaining({ model: 'other' }), tokens: 22, cost: 26 },
    ]);
    expect(totals.retries).toEqual([
      { labels: expect.objectContaining({ error_category: 'internal' }), retries: 16 },
    ]);
    expect(JSON.stringify(totals)).not.toMatch(/user-model|SECRET/);
  });
});

describe('parseWorkerMetricsSnapshot', () => {
  const valid =
    '# HELP extractionstack_llm_worker_up Worker metric\n# TYPE extractionstack_llm_worker_up gauge\nextractionstack_llm_worker_up 1\n';

  it('renders only exact worker families without colliding with API families', () => {
    expect(parseWorkerMetricsSnapshot(valid)).toContain('extractionstack_llm_worker_up 1');
    expect(
      parseWorkerMetricsSnapshot(
        '# HELP extractionstack_llm_jobs_total x\n# TYPE extractionstack_llm_jobs_total gauge\nextractionstack_llm_jobs_total 1\n',
      ),
    ).toBe('');
  });

  it.each([
    valid.replace('Worker metric', 'password=hidden'),
    valid.replace(
      'extractionstack_llm_worker_up 1',
      'extractionstack_llm_worker_up{unknown="other"} 1',
    ),
    valid.replace(
      '# TYPE extractionstack_llm_worker_up gauge',
      '# TYPE extractionstack_llm_worker_up gauge\n# TYPE extractionstack_llm_worker_up gauge',
    ),
    `${valid}extractionstack_llm_worker_up 1\n`,
    valid.replace(' 1\n', ' NaN\n'),
  ])(
    'rejects secrets, unknown labels, duplicate metadata/samples, and nonfinite values',
    (payload) => {
      expect(parseWorkerMetricsSnapshot(payload)).toBe('');
    },
  );
});
