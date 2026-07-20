import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import { collectDefaultMetrics, Counter, Gauge, Registry } from 'prom-client';
import { loadRuntimeEnv } from '../common/runtime-env.js';
import { ProviderRegistry } from '@extractionstack/llm-core';

const WORKER_HEARTBEAT_KEY = 'llm-worker:v1:heartbeat';
const WORKER_METRICS_KEY = 'llm-worker:v1:metrics';
const LLM_QUEUE_PREFIX = 'bull:llm-generations-v1';
const READY_TIMEOUT_MS = 1_000;
const WORKER_HEARTBEAT_MAX_AGE_MS = 15_000;

export interface ReadinessResult {
  status: 'ok' | 'unavailable';
  checks: {
    database: boolean;
    redis: boolean;
    queue: boolean;
    configuration: boolean;
    pricing: boolean;
    worker: boolean;
  };
}

export type JobMetricRow = {
  provider: string;
  model: string;
  credentialMode: string;
  operation: string;
  status: string;
  errorCode: string | null;
  count: bigint;
  retries: bigint;
  tokens: bigint;
  cost: bigint;
};

@Injectable()
export class OperationsService implements OnModuleDestroy {
  private readonly registry = new Registry();
  private readonly redis: Redis;
  private readonly readinessFailures: Counter;
  private readonly queueDepth: Gauge;
  private readonly jobs: Gauge;
  private readonly tokens: Gauge;
  private readonly cost: Gauge;
  private readonly retries: Gauge;
  private readonly deadLetters: Gauge;
  private readonly guardrails: Gauge;
  private readonly creditInvariant: Gauge;
  private readonly reconciliationBacklog: Gauge;
  private readonly circuitBreaker: Gauge;

  constructor(
    @Inject(PrismaClient) private readonly prisma: PrismaClient,
    @Inject(ProviderRegistry) private readonly providers: ProviderRegistry,
  ) {
    const env = loadRuntimeEnv(process.env);
    this.redis = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: READY_TIMEOUT_MS,
    });
    this.redis.on('error', () => undefined);
    collectDefaultMetrics({ register: this.registry, prefix: 'extractionstack_' });
    this.readinessFailures = new Counter({
      name: 'extractionstack_readiness_failures_total',
      help: 'Failed readiness checks',
      labelNames: ['dependency'] as const,
      registers: [this.registry],
    });
    this.queueDepth = new Gauge({
      name: 'extractionstack_llm_queue_depth',
      help: 'LLM queue depth',
      labelNames: ['state'] as const,
      registers: [this.registry],
    });
    this.jobs = new Gauge({
      name: 'extractionstack_llm_jobs',
      help: 'Bounded LLM job state totals',
      labelNames: ['provider', 'model', 'mode', 'operation', 'status', 'error_category'] as const,
      registers: [this.registry],
    });
    this.tokens = new Gauge({
      name: 'extractionstack_llm_tokens_total',
      help: 'Persisted LLM token usage',
      labelNames: ['provider', 'model', 'mode'] as const,
      registers: [this.registry],
    });
    this.cost = new Gauge({
      name: 'extractionstack_llm_cost_minor_total',
      help: 'Persisted LLM cost in minor units',
      labelNames: ['provider', 'model', 'mode'] as const,
      registers: [this.registry],
    });
    this.retries = new Gauge({
      name: 'extractionstack_llm_retries',
      help: 'Persisted LLM retry count',
      labelNames: ['provider', 'operation', 'error_category'] as const,
      registers: [this.registry],
    });
    this.deadLetters = new Gauge({
      name: 'extractionstack_llm_dead_letter_jobs',
      help: 'Failed transport jobs',
      registers: [this.registry],
    });
    this.guardrails = new Gauge({
      name: 'extractionstack_llm_guardrail_decisions',
      help: 'Persisted guardrail decisions',
      labelNames: ['action', 'reason_category'] as const,
      registers: [this.registry],
    });
    this.creditInvariant = new Gauge({
      name: 'extractionstack_credit_invariant_violations',
      help: 'Open terminal-job credit reservations',
      registers: [this.registry],
    });
    this.reconciliationBacklog = new Gauge({
      name: 'extractionstack_llm_reconciliation_backlog',
      help: 'Ambiguous job backlog',
      registers: [this.registry],
    });
    this.circuitBreaker = new Gauge({
      name: 'extractionstack_llm_circuit_breaker_open',
      help: 'Configured provider circuit state',
      labelNames: ['provider'] as const,
      registers: [this.registry],
    });
  }

  async readiness(): Promise<ReadinessResult> {
    const env = loadRuntimeEnv(process.env);
    const [database, redis, worker] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      check(() => this.pingRedis()),
      check(() => this.workerHeartbeatFresh()),
    ]);
    const configuration = env.LLM_RATE_LIMIT_HMAC_KEY.length >= 32 && env.LLM_TIMEOUT_MS > 0;
    const pricing = pricingCoverage(env);
    const queue = redis && (await check(() => this.redis.type(`${LLM_QUEUE_PREFIX}:wait`)));
    const checks = { database, redis, queue, configuration, pricing, worker };
    for (const [dependency, ready] of Object.entries(checks)) {
      if (!ready) this.readinessFailures.inc({ dependency });
    }
    return { status: Object.values(checks).every(Boolean) ? 'ok' : 'unavailable', checks };
  }

  async metrics(): Promise<string> {
    await this.refreshMetrics();
    const [apiMetrics, workerMetrics] = await Promise.all([
      this.registry.metrics(),
      this.workerMetricsSnapshot(),
    ]);
    return `${apiMetrics}${workerMetrics}`;
  }

  contentType(): string {
    return this.registry.contentType;
  }

  async onModuleDestroy(): Promise<void> {
    this.registry.clear();
    if (this.redis.status !== 'end') await this.redis.quit().catch(() => this.redis.disconnect());
  }

  private async pingRedis(): Promise<boolean> {
    if (this.redis.status === 'wait') await this.redis.connect();
    return (await withTimeout(this.redis.ping(), READY_TIMEOUT_MS)) === 'PONG';
  }

  private async workerHeartbeatFresh(): Promise<boolean> {
    if (!(await this.pingRedis())) return false;
    const value = await withTimeout(this.redis.get(WORKER_HEARTBEAT_KEY), READY_TIMEOUT_MS);
    const timestamp = value && /^(0|[1-9]\d{0,15})$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(timestamp) && Date.now() - timestamp <= WORKER_HEARTBEAT_MAX_AGE_MS;
  }

  private async refreshMetrics(): Promise<void> {
    this.jobs.reset();
    this.tokens.reset();
    this.cost.reset();
    this.retries.reset();
    this.guardrails.reset();
    const env = loadRuntimeEnv(process.env);
    const models = new Set([
      ...env.LLM_OPENAI_MODEL_ALLOWLIST,
      ...env.LLM_GEMINI_MODEL_ALLOWLIST,
      ...(env.LLM_PROVIDER_MODE === 'fake' ? ['fake-deterministic-v1'] : []),
    ]);
    const rows = await withTimeout(
      this.prisma.$queryRaw<JobMetricRow[]>`
      SELECT job."provider"::text, job."model", job."credentialMode"::text,
             job."operation"::text, job."status"::text, job."errorCode",
             COUNT(*)::bigint AS count, COALESCE(SUM(job."attempts"), 0)::bigint AS retries,
             COALESCE(SUM(usage."totalTokens"), 0)::bigint AS tokens,
             COALESCE(SUM(usage."confirmedAmountMinor"), 0)::bigint AS cost
      FROM "PromptGenerationJob" job
      LEFT JOIN "LlmUsage" usage ON usage."jobId" = job."id"
      GROUP BY job."provider", job."model", job."credentialMode", job."operation", job."status", job."errorCode"
    `,
      READY_TIMEOUT_MS,
    );
    const totals = aggregateBoundedJobMetrics(rows, models);
    for (const total of totals.jobs) this.jobs.set(total.labels, total.count);
    for (const total of totals.usage) {
      this.tokens.set(total.labels, total.tokens);
      this.cost.set(total.labels, total.cost);
    }
    for (const total of totals.retries) this.retries.set(total.labels, total.retries);
    const security = await withTimeout(
      this.prisma.securityDecision.groupBy({
        by: ['action', 'reasonCode'],
        _count: { _all: true },
      }),
      READY_TIMEOUT_MS,
    );
    for (const row of security)
      this.guardrails.inc(
        {
          action: allow(row.action, ['ALLOW', 'REDACT', 'BLOCK']),
          reason_category: securityCategory(row.reasonCode),
        },
        row._count._all,
      );
    this.circuitBreaker.reset();
    for (const provider of this.providers.listPublic())
      this.circuitBreaker.set(
        { provider: allow(provider.provider, ['OPENAI', 'GEMINI', 'FAKE']) },
        provider.circuitBreakerOpen ? 1 : 0,
      );
    const [waiting, active, delayed, failed, ambiguous, invariant] = await Promise.all([
      safeNumber(() => this.redis.llen(`${LLM_QUEUE_PREFIX}:wait`)),
      safeNumber(() => this.redis.llen(`${LLM_QUEUE_PREFIX}:active`)),
      safeNumber(() => this.redis.zcard(`${LLM_QUEUE_PREFIX}:delayed`)),
      safeNumber(() => this.redis.zcard(`${LLM_QUEUE_PREFIX}:failed`)),
      safeNumber(() => this.prisma.promptGenerationJob.count({ where: { status: 'AMBIGUOUS' } })),
      safeNumber(() =>
        this.prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count FROM "CreditLedgerEntry" reservation
        JOIN "PromptGenerationJob" job ON job."id" = reservation."jobId"
        LEFT JOIN "CreditLedgerEntry" settlement ON settlement."reservationId" = reservation."id"
        WHERE reservation."kind" = 'RESERVATION' AND settlement."id" IS NULL
          AND job."status" IN ('SUCCEEDED','FAILED','CANCELLED')
      `.then((values) => number(values[0]?.count ?? 0n)),
      ),
    ]);
    for (const [state, value] of Object.entries({ waiting, active, delayed }))
      this.queueDepth.set({ state }, value);
    this.deadLetters.set(failed);
    this.reconciliationBacklog.set(ambiguous);
    this.creditInvariant.set(invariant);
  }

  private async workerMetricsSnapshot(): Promise<string> {
    try {
      const raw = await withTimeout(this.redis.get(WORKER_METRICS_KEY), READY_TIMEOUT_MS);
      return raw ? parseWorkerMetricsSnapshot(raw) : '';
    } catch {
      return '';
    }
  }
}

type WorkerMetricDefinition = Readonly<{
  type: 'counter' | 'gauge';
  labels: Readonly<Record<string, ReadonlySet<string>>>;
}>;
const values = (...items: string[]): ReadonlySet<string> => new Set(items);
const PROVIDER_VALUES = values('OPENAI', 'GEMINI', 'FAKE', 'other');
const MODEL_VALUES = values('gpt-5-mini', 'gemini-2.5-flash', 'fake-deterministic-v1', 'other');
const MODE_VALUES = values('oauth', 'user_key', 'platform_credits', 'other');
const OPERATION_VALUES = values('GENERATE', 'ADAPT', 'PREVIEW', 'other');
const STATUS_VALUES = values('SUCCEEDED', 'FAILED', 'CANCELLED', 'AMBIGUOUS', 'other');
const ERROR_VALUES = values(
  'none',
  'authentication',
  'access_denied',
  'timeout',
  'provider_unavailable',
  'invalid_output',
  'guardrail',
  'credits',
  'internal',
);
const WORKER_METRICS: Readonly<Record<string, WorkerMetricDefinition>> = Object.freeze({
  extractionstack_llm_worker_up: { type: 'gauge', labels: {} },
  extractionstack_llm_worker_jobs_total: {
    type: 'counter',
    labels: {
      provider: PROVIDER_VALUES,
      model: MODEL_VALUES,
      mode: MODE_VALUES,
      operation: OPERATION_VALUES,
      status: STATUS_VALUES,
      error_category: ERROR_VALUES,
    },
  },
  extractionstack_llm_worker_job_duration_seconds_sum: {
    type: 'gauge',
    labels: {
      provider: PROVIDER_VALUES,
      model: MODEL_VALUES,
      operation: OPERATION_VALUES,
      status: STATUS_VALUES,
    },
  },
  extractionstack_llm_worker_job_duration_seconds_count: {
    type: 'gauge',
    labels: {
      provider: PROVIDER_VALUES,
      model: MODEL_VALUES,
      operation: OPERATION_VALUES,
      status: STATUS_VALUES,
    },
  },
  extractionstack_llm_worker_retries_total: {
    type: 'counter',
    labels: {
      provider: PROVIDER_VALUES,
      operation: OPERATION_VALUES,
      error_category: ERROR_VALUES,
    },
  },
  extractionstack_llm_worker_dead_letter_jobs: { type: 'gauge', labels: {} },
  extractionstack_llm_worker_reconciliation_backlog: { type: 'gauge', labels: {} },
  extractionstack_llm_worker_circuit_breaker_open: {
    type: 'gauge',
    labels: { provider: PROVIDER_VALUES },
  },
  extractionstack_llm_worker_guardrail_decisions_total: {
    type: 'counter',
    labels: {
      action: values('ALLOW', 'REDACT', 'BLOCK', 'other'),
      reason_category: values('injection', 'sensitive_data', 'unsafe_url', 'policy', 'other'),
    },
  },
  extractionstack_llm_worker_usage_units_total: {
    type: 'counter',
    labels: {
      provider: PROVIDER_VALUES,
      model: MODEL_VALUES,
      mode: MODE_VALUES,
      kind: values('input', 'output'),
    },
  },
  extractionstack_llm_worker_cost_minor_total: {
    type: 'counter',
    labels: { provider: PROVIDER_VALUES, model: MODEL_VALUES, mode: MODE_VALUES },
  },
  extractionstack_llm_worker_credit_invariant_violations: { type: 'gauge', labels: {} },
});

export function parseWorkerMetricsSnapshot(raw: string): string {
  if (
    Buffer.byteLength(raw, 'utf8') > 65_536 ||
    /api_key|password|token|secret|bearer|authorization/i.test(raw)
  )
    return '';
  const help = new Set<string>();
  const types = new Set<string>();
  const samples = new Map<
    string,
    { family: string; labels: Record<string, string>; value: number }
  >();
  for (const line of raw.split('\n').filter(Boolean)) {
    if (line.length > 2_048) return '';
    const helpMatch = /^# HELP ([a-z0-9_]+) .+$/.exec(line);
    if (helpMatch) {
      const family = helpMatch[1]!;
      if (!WORKER_METRICS[family] || help.has(family)) return '';
      help.add(family);
      continue;
    }
    const typeMatch = /^# TYPE ([a-z0-9_]+) (counter|gauge)$/.exec(line);
    if (typeMatch) {
      const family = typeMatch[1]!;
      const definition = WORKER_METRICS[family];
      if (!definition || definition.type !== typeMatch[2] || types.has(family)) return '';
      types.add(family);
      continue;
    }
    const sampleMatch = /^([a-z0-9_]+)(?:\{(.*)\})? ([^\s]+)$/.exec(line);
    if (!sampleMatch) return '';
    const family = sampleMatch[1]!;
    const definition = WORKER_METRICS[family];
    if (!definition) return '';
    const labels = parseMetricLabels(sampleMatch[2] ?? '', definition);
    if (!labels) return '';
    const value = Number(sampleMatch[3]);
    if (!Number.isFinite(value) || value < 0) return '';
    const sampleKey = `${family}|${JSON.stringify(labels)}`;
    if (samples.has(sampleKey)) return '';
    samples.set(sampleKey, { family, labels, value });
  }
  const usedFamilies = new Set([...samples.values()].map((sample) => sample.family));
  if (
    [...usedFamilies].some((family) => !help.has(family) || !types.has(family)) ||
    [...help].some((family) => !usedFamilies.has(family)) ||
    [...types].some((family) => !usedFamilies.has(family))
  )
    return '';
  const output: string[] = [];
  for (const family of [...usedFamilies].sort()) {
    output.push(
      `# HELP ${family} Bounded worker operational metric`,
      `# TYPE ${family} ${WORKER_METRICS[family]!.type}`,
    );
    for (const sample of [...samples.values()]
      .filter((entry) => entry.family === family)
      .sort((left, right) =>
        JSON.stringify(left.labels).localeCompare(JSON.stringify(right.labels)),
      )) {
      const rendered = Object.entries(sample.labels)
        .map(([name, value]) => `${name}="${value}"`)
        .join(',');
      output.push(`${family}${rendered ? `{${rendered}}` : ''} ${sample.value}`);
    }
  }
  return output.length ? `${output.join('\n')}\n` : '';
}

function parseMetricLabels(
  raw: string,
  definition: WorkerMetricDefinition,
): Record<string, string> | null {
  const expected = Object.keys(definition.labels).sort();
  if (!raw) return expected.length === 0 ? {} : null;
  const labels: Record<string, string> = {};
  for (const part of raw.split(',')) {
    const match = /^([a-z0-9_]+)="([A-Za-z0-9_.:-]+)"$/.exec(part);
    if (!match || labels[match[1]!]) return null;
    labels[match[1]!] = match[2]!;
  }
  if (JSON.stringify(Object.keys(labels).sort()) !== JSON.stringify(expected)) return null;
  for (const [name, allowed] of Object.entries(definition.labels))
    if (!allowed.has(labels[name]!)) return null;
  return Object.fromEntries(expected.map((name) => [name, labels[name]!]));
}

export function aggregateBoundedJobMetrics(
  rows: readonly JobMetricRow[],
  models: ReadonlySet<string>,
) {
  const jobs = new Map<string, { labels: ReturnType<typeof boundedLabels>; count: number }>();
  const usage = new Map<
    string,
    { labels: { provider: string; model: string; mode: string }; tokens: number; cost: number }
  >();
  const retries = new Map<
    string,
    { labels: { provider: string; operation: string; error_category: string }; retries: number }
  >();
  for (const row of rows) {
    const labels = boundedLabels(row, models);
    const jobKey = JSON.stringify(labels);
    jobs.set(jobKey, { labels, count: (jobs.get(jobKey)?.count ?? 0) + number(row.count) });
    const usageLabels = { provider: labels.provider, model: labels.model, mode: labels.mode };
    const usageKey = JSON.stringify(usageLabels);
    const priorUsage = usage.get(usageKey);
    usage.set(usageKey, {
      labels: usageLabels,
      tokens: (priorUsage?.tokens ?? 0) + number(row.tokens),
      cost: (priorUsage?.cost ?? 0) + number(row.cost),
    });
    const retryLabels = {
      provider: labels.provider,
      operation: labels.operation,
      error_category: labels.error_category,
    };
    const retryKey = JSON.stringify(retryLabels);
    retries.set(retryKey, {
      labels: retryLabels,
      retries: (retries.get(retryKey)?.retries ?? 0) + number(row.retries),
    });
  }
  return { jobs: [...jobs.values()], usage: [...usage.values()], retries: [...retries.values()] };
}

function boundedLabels(row: JobMetricRow, models: ReadonlySet<string>) {
  return {
    provider: allow(row.provider, ['OPENAI', 'GEMINI', 'FAKE']),
    model: models.has(row.model) ? row.model : 'other',
    mode: allow(row.credentialMode, ['OAUTH', 'API_KEY', 'PLATFORM_CREDITS']),
    operation: allow(row.operation, ['GENERATE', 'ADAPT', 'PREVIEW']),
    status: allow(row.status, [
      'QUEUED',
      'RUNNING',
      'SUCCEEDED',
      'FAILED',
      'CANCEL_REQUESTED',
      'CANCELLED',
      'AMBIGUOUS',
    ]),
    error_category: errorCategory(row.errorCode),
  };
}
function errorCategory(value: string | null): string {
  if (!value) return 'none';
  if (/AUTH/.test(value)) return 'authentication';
  if (/TIMEOUT/.test(value)) return 'timeout';
  if (/PROVIDER|QUEUE/.test(value)) return 'unavailable';
  if (/GUARD|INJECTION/.test(value)) return 'guardrail';
  if (/CREDIT|COST/.test(value)) return 'credits';
  if (/OUTPUT|RESPONSE/.test(value)) return 'invalid_output';
  return 'internal';
}
function securityCategory(value: string): string {
  if (/INJECTION/i.test(value)) return 'injection';
  if (/SECRET|CREDENTIAL/i.test(value)) return 'secret';
  if (/URL|SSRF/i.test(value)) return 'unsafe_url';
  if (/POLICY|GUARD/i.test(value)) return 'policy';
  return 'other';
}
function allow(value: string, values: readonly string[]): string {
  return values.includes(value) ? value : 'other';
}
function number(value: bigint | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, parsed)) : 0;
}
async function check(operation: () => Promise<unknown>): Promise<boolean> {
  try {
    return Boolean(await withTimeout(operation(), READY_TIMEOUT_MS));
  } catch {
    return false;
  }
}
async function safeNumber(operation: () => Promise<number>): Promise<number> {
  try {
    return number(await withTimeout(operation(), READY_TIMEOUT_MS));
  } catch {
    return 0;
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
function pricingCoverage(env: ReturnType<typeof loadRuntimeEnv>): boolean {
  try {
    const entries = JSON.parse(env.LLM_PRICING_CATALOG_JSON) as unknown;
    if (!Array.isArray(entries)) return false;
    const keys = new Set(
      entries.flatMap((entry) =>
        entry &&
        typeof entry === 'object' &&
        typeof Reflect.get(entry, 'provider') === 'string' &&
        typeof Reflect.get(entry, 'model') === 'string'
          ? [`${Reflect.get(entry, 'provider')}:${Reflect.get(entry, 'model')}`]
          : [],
      ),
    );
    if (env.LLM_PROVIDER_MODE === 'fake') {
      return !env.LLM_PROMPT_GENERATION_ENABLED || keys.has('FAKE:fake-deterministic-v1');
    }
    return (
      env.LLM_OPENAI_MODEL_ALLOWLIST.every((model) => keys.has(`OPENAI:${model}`)) &&
      env.LLM_GEMINI_MODEL_ALLOWLIST.every((model) => keys.has(`GEMINI:${model}`))
    );
  } catch {
    return false;
  }
}
