import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';

type WorkerChecks = Readonly<{
  database(): Promise<boolean>;
  redis(): Promise<boolean>;
  queue(): Promise<boolean>;
  publishHeartbeat(timestamp: number): Promise<void>;
  publishSnapshot?: (metrics: string) => Promise<void>;
  configuration?: () => boolean;
  close?: () => Promise<void>;
}>;

type JobMetric = Readonly<{
  provider: string;
  model: string;
  mode: string;
  operation: string;
  status: string;
  errorCategory: string;
  durationSeconds: number;
  retries: number;
}>;
type Labels = Readonly<Record<string, string>>;
type Sample = { name: string; labels: Labels; value: number };

const PROVIDERS = new Set(['OPENAI', 'GEMINI', 'FAKE']);
const OPERATIONS = new Set(['GENERATE', 'ADAPT', 'PREVIEW']);
const STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'AMBIGUOUS']);
const ERRORS = new Set([
  'none',
  'authentication',
  'access_denied',
  'timeout',
  'provider_unavailable',
  'invalid_output',
  'guardrail',
  'credits',
  'internal',
]);
const MODELS = new Set(['gpt-5-mini', 'gemini-2.5-flash', 'fake-deterministic-v1']);

export class LlmWorkerOperationsService implements OnModuleInit, OnModuleDestroy {
  private readonly samples = new Map<string, Sample>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly checks: WorkerChecks) {}

  onModuleInit(): void {
    void this.heartbeat().catch(() => undefined);
    this.timer = setInterval(() => void this.heartbeat().catch(() => undefined), 5_000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.samples.clear();
    await this.checks.close?.();
  }

  async heartbeat(): Promise<void> {
    const readiness = await this.readiness();
    if (readiness.status !== 'ok') throw new Error('LLM_WORKER_NOT_READY');
    await withTimeout(this.checks.publishHeartbeat(Date.now()), 1_000);
    set(this.samples, 'extractionstack_llm_worker_up', {}, 1);
    if (this.checks.publishSnapshot)
      await withTimeout(
        this.checks.publishSnapshot((await this.metrics()).slice(0, 65_536)),
        1_000,
      );
  }

  async readiness(): Promise<{
    status: 'ok' | 'unavailable';
    checks: { database: boolean; redis: boolean; queue: boolean; configuration: boolean };
  }> {
    const [database, redis, queue] = await Promise.all([
      safeCheck(this.checks.database),
      safeCheck(this.checks.redis),
      safeCheck(this.checks.queue),
    ]);
    const configuration = this.checks.configuration?.() ?? true;
    return {
      status: database && redis && queue && configuration ? 'ok' : 'unavailable',
      checks: { database, redis, queue, configuration },
    };
  }

  recordJob(metric: JobMetric): void {
    const labels = {
      provider: allow(metric.provider, PROVIDERS),
      model: allow(metric.model, MODELS),
      mode: metricMode(metric.mode),
      operation: allow(metric.operation, OPERATIONS),
      status: allow(metric.status, STATUSES),
      error_category: allow(metric.errorCategory, ERRORS, 'internal'),
    };
    increment(this.samples, 'extractionstack_llm_worker_jobs_total', labels, 1);
    increment(
      this.samples,
      'extractionstack_llm_worker_job_duration_seconds_sum',
      pick(labels, ['provider', 'model', 'operation', 'status']),
      bounded(metric.durationSeconds, 0, 300),
    );
    increment(
      this.samples,
      'extractionstack_llm_worker_job_duration_seconds_count',
      pick(labels, ['provider', 'model', 'operation', 'status']),
      1,
    );
    if (metric.retries > 0)
      increment(
        this.samples,
        'extractionstack_llm_worker_retries_total',
        pick(labels, ['provider', 'operation', 'error_category']),
        Math.trunc(bounded(metric.retries, 0, 10)),
      );
  }

  recordQueueState(state: { deadLetters: number; reconciliationBacklog: number }): void {
    set(
      this.samples,
      'extractionstack_llm_worker_dead_letter_jobs',
      {},
      bounded(state.deadLetters, 0, 1_000_000),
    );
    set(
      this.samples,
      'extractionstack_llm_worker_reconciliation_backlog',
      {},
      bounded(state.reconciliationBacklog, 0, 1_000_000),
    );
  }

  recordCircuitBreaker(provider: string, open: boolean): void {
    set(
      this.samples,
      'extractionstack_llm_worker_circuit_breaker_open',
      { provider: allow(provider, PROVIDERS) },
      open ? 1 : 0,
    );
  }
  recordGuardrail(action: string, reason: string): void {
    increment(
      this.samples,
      'extractionstack_llm_worker_guardrail_decisions_total',
      {
        action: allow(action, new Set(['ALLOW', 'REDACT', 'BLOCK'])),
        reason_category: guardrailReason(reason),
      },
      1,
    );
  }
  recordUsage(metric: {
    provider: string;
    model: string;
    mode: string;
    inputTokens: number;
    outputTokens: number;
    costMinor: number;
  }): void {
    const labels = {
      provider: allow(metric.provider, PROVIDERS),
      model: allow(metric.model, MODELS),
      mode: metricMode(metric.mode),
    };
    increment(
      this.samples,
      'extractionstack_llm_worker_usage_units_total',
      { ...labels, kind: 'input' },
      bounded(metric.inputTokens, 0, 1_000_000_000),
    );
    increment(
      this.samples,
      'extractionstack_llm_worker_usage_units_total',
      { ...labels, kind: 'output' },
      bounded(metric.outputTokens, 0, 1_000_000_000),
    );
    increment(
      this.samples,
      'extractionstack_llm_worker_cost_minor_total',
      labels,
      bounded(metric.costMinor, 0, 1_000_000_000),
    );
  }
  recordCreditInvariant(violations: number): void {
    set(
      this.samples,
      'extractionstack_llm_worker_credit_invariant_violations',
      {},
      bounded(violations, 0, 1_000_000),
    );
  }

  async metrics(): Promise<string> {
    const families = [...new Set([...this.samples.values()].map((sample) => sample.name))].sort();
    const lines: string[] = [];
    for (const family of families) {
      lines.push(`# HELP ${family} Bounded ExtractionStack LLM operational metric`);
      lines.push(`# TYPE ${family} ${family.endsWith('_total') ? 'counter' : 'gauge'}`);
      for (const sample of this.samples.values())
        if (sample.name === family)
          lines.push(`${family}${formatLabels(sample.labels)} ${sample.value}`);
    }
    return `${lines.join('\n')}\n`;
  }
}

function key(name: string, labels: Labels): string {
  return `${name}|${Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|')}`;
}
function increment(
  samples: Map<string, Sample>,
  name: string,
  labels: Labels,
  amount: number,
): void {
  const id = key(name, labels);
  const current = samples.get(id);
  samples.set(id, { name, labels, value: (current?.value ?? 0) + amount });
}
function set(samples: Map<string, Sample>, name: string, labels: Labels, value: number): void {
  samples.set(key(name, labels), { name, labels, value });
}
function pick(labels: Labels, names: readonly string[]): Labels {
  return Object.fromEntries(names.map((name) => [name, labels[name] ?? 'other']));
}
function formatLabels(labels: Labels): string {
  const values = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return values.length
    ? `{${values.map(([name, value]) => `${name}="${value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')}"`).join(',')}}`
    : '';
}
function allow(value: string, values: ReadonlySet<string>, fallback = 'other'): string {
  return values.has(value) ? value : fallback;
}
function metricMode(value: string): string {
  return (
    (
      { OAUTH: 'oauth', API_KEY: 'user_key', PLATFORM_CREDITS: 'platform_credits' } as Record<
        string,
        string
      >
    )[value] ?? 'other'
  );
}
function guardrailReason(value: string): string {
  if (/injection/i.test(value)) return 'injection';
  if (/secret|credential/i.test(value)) return 'sensitive_data';
  if (/url|ssrf/i.test(value)) return 'unsafe_url';
  if (/policy|guard/i.test(value)) return 'policy';
  return 'other';
}
function bounded(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.max(min, Math.min(max, value)) : min;
}
async function safeCheck(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return Boolean(await withTimeout(check(), 1_000));
  } catch {
    return false;
  }
}
async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('DEPENDENCY_TIMEOUT')), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
