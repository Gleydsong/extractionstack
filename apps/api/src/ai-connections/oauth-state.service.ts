import { createHash, randomBytes } from 'node:crypto';
import { ConflictException, Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import Redis from 'ioredis';

const STATE_BYTES = 32;
const STATE_TTL_SECONDS = 5 * 60;
const REDIS_PREFIX = 'ai-connections:oauth-state:';
const REDIS_USED_PREFIX = 'ai-connections:oauth-state-used:';
const IDEMPOTENCY_PREFIX = 'ai-connections:idempotency:';
const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;
const CONSUME_OAUTH_STATE_SCRIPT = `
local value = redis.call('GET', KEYS[1])
if not value then return false end
local record = cjson.decode(value)
local marker = cjson.encode({
  ownerSub = record.ownerSub,
  provider = record.provider,
  redirectUri = record.redirectUri,
  expiresAt = record.expiresAt,
  usedAt = tonumber(ARGV[1])
})
local stored = redis.call('SET', KEYS[2], marker, 'EX', ARGV[2], 'NX')
if not stored then return false end
redis.call('DEL', KEYS[1])
return value
`;
const COMPLETE_IDEMPOTENCY_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[3])
return 1
`;
const RELEASE_IDEMPOTENCY_SCRIPT = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`;

export type OAuthStateRecord = Readonly<{
  ownerSub: string;
  provider: 'GEMINI';
  redirectUri: string;
  verifier: string;
  expiresAt: number;
  usedAt: number | null;
}>;

export interface OAuthStateStorePort {
  create(record: Omit<OAuthStateRecord, 'expiresAt' | 'usedAt'>): Promise<string>;
  consume(state: string): Promise<OAuthStateRecord | null>;
}

interface RedisOAuthStateClient {
  connect(): Promise<void>;
  set(
    key: string,
    value: string,
    mode: 'EX',
    ttlSeconds: number,
    condition?: 'NX',
  ): Promise<'OK' | null>;
  getdel(key: string): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numberOfKeys: number, ...args: Array<string | number>): Promise<unknown>;
  quit(): Promise<'OK'>;
  disconnect(): void;
  readonly status: string;
}

export const OAUTH_STATE_REDIS = Symbol('OAUTH_STATE_REDIS');
export const IDEMPOTENCY_STORE = Symbol('IDEMPOTENCY_STORE');

export interface IdempotencyStorePort {
  execute<T>(input: {
    ownerSub: string;
    operation: string;
    key: string;
    fingerprint: string;
    run: () => Promise<T>;
    parse: (value: unknown) => T | Promise<T>;
    encodeResult?: (value: T) => unknown | Promise<unknown>;
    cacheRequired?: boolean;
  }): Promise<T>;
}

@Injectable()
export class RedisIdempotencyService implements IdempotencyStorePort {
  constructor(@Inject(OAUTH_STATE_REDIS) private readonly redis: RedisOAuthStateClient) {}

  async execute<T>(input: {
    ownerSub: string;
    operation: string;
    key: string;
    fingerprint: string;
    run: () => Promise<T>;
    parse: (value: unknown) => T | Promise<T>;
    encodeResult?: (value: T) => unknown | Promise<unknown>;
    cacheRequired?: boolean;
  }): Promise<T> {
    const redisKey = idempotencyKey(input.ownerSub, input.operation, input.key);
    const leaseToken = randomBytes(32).toString('base64url');
    const pending = JSON.stringify({
      status: 'PENDING',
      fingerprint: input.fingerprint,
      leaseToken,
    });
    let acquired: 'OK' | null;
    try {
      if (this.redis.status === 'wait') await this.redis.connect();
      acquired = await this.redis.set(redisKey, pending, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX');
    } catch (error) {
      if (input.cacheRequired) throw error;
      return input.run();
    }
    if (acquired !== 'OK') {
      let existing: ReturnType<typeof parseIdempotencyRecord> = null;
      try {
        existing = parseIdempotencyRecord(await this.redis.get(redisKey));
      } catch (error) {
        if (input.cacheRequired) throw error;
        return input.run();
      }
      if (existing?.status === 'COMPLETE' && existing.fingerprint === input.fingerprint) {
        return input.parse(existing.result);
      }
      if (input.cacheRequired && (!existing || existing.fingerprint !== input.fingerprint)) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: 'idempotency key was already used for another request',
        });
      }
      if (input.cacheRequired) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: 'request is already in progress',
        });
      }
      return input.run();
    }
    let result: T;
    try {
      result = await input.run();
    } catch (error) {
      await this.redis
        .eval(RELEASE_IDEMPOTENCY_SCRIPT, 1, redisKey, pending)
        .catch(() => undefined);
      throw error;
    }
    const storedResult = input.encodeResult ? await input.encodeResult(result) : result;
    const completed = JSON.stringify({
      status: 'COMPLETE',
      fingerprint: input.fingerprint,
      result: storedResult,
    });
    let stored: unknown;
    try {
      stored = await this.redis.eval(
        COMPLETE_IDEMPOTENCY_SCRIPT,
        1,
        redisKey,
        pending,
        completed,
        IDEMPOTENCY_TTL_SECONDS,
      );
    } catch (error) {
      if (input.cacheRequired) throw error;
      return result;
    }
    if (stored !== 1 && input.cacheRequired) {
      throw new ConflictException({
        code: 'CONFLICT',
        message: 'idempotency lease was not retained',
      });
    }
    return result;
  }
}

@Injectable()
export class OAuthStateService implements OAuthStateStorePort, OnModuleDestroy {
  constructor(
    @Inject(OAUTH_STATE_REDIS) private readonly redis: RedisOAuthStateClient,
    private readonly now: () => number = Date.now,
  ) {}

  async create(record: Omit<OAuthStateRecord, 'expiresAt' | 'usedAt'>): Promise<string> {
    await this.ensureConnected();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const state = randomBytes(STATE_BYTES).toString('base64url');
      const stored: OAuthStateRecord = {
        ...record,
        expiresAt: this.now() + STATE_TTL_SECONDS * 1_000,
        usedAt: null,
      };
      const result = await this.redis.set(
        keyFor(state),
        JSON.stringify(stored),
        'EX',
        STATE_TTL_SECONDS,
        'NX',
      );
      if (result === 'OK') return state;
    }
    throw new Error('OAUTH_STATE_STORAGE_FAILED');
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    if (!isValidState(state)) return null;
    await this.ensureConnected();
    const serialized = await this.redis.eval(
      CONSUME_OAUTH_STATE_SCRIPT,
      2,
      keyFor(state),
      usedKeyFor(state),
      this.now(),
      STATE_TTL_SECONDS,
    );
    if (typeof serialized !== 'string') return null;
    const record = parseRecord(serialized);
    if (!record || record.expiresAt <= this.now()) return null;
    return record;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status !== 'end') {
      await this.redis.quit().catch(() => this.redis.disconnect());
    }
  }

  private async ensureConnected(): Promise<void> {
    if (this.redis.status === 'wait') await this.redis.connect();
  }
}

export class InMemoryOAuthStateStore implements OAuthStateStorePort {
  readonly #records = new Map<string, OAuthStateRecord>();
  #offset = 0;

  constructor(private readonly options: { now?: () => number } = {}) {}

  advanceBy(milliseconds: number): void {
    this.#offset += milliseconds;
  }

  async create(record: Omit<OAuthStateRecord, 'expiresAt' | 'usedAt'>): Promise<string> {
    const state = randomBytes(STATE_BYTES).toString('base64url');
    this.#records.set(keyFor(state), {
      ...record,
      expiresAt: this.now() + STATE_TTL_SECONDS * 1_000,
      usedAt: null,
    });
    return state;
  }

  async consume(state: string): Promise<OAuthStateRecord | null> {
    if (!isValidState(state)) return null;
    const key = keyFor(state);
    const record = this.#records.get(key) ?? null;
    this.#records.delete(key);
    if (!record || record.expiresAt <= this.now()) return null;
    this.#records.set(usedKeyFor(state), { ...record, usedAt: this.now() });
    return record;
  }

  private now(): number {
    return (this.options.now?.() ?? Date.now()) + this.#offset;
  }
}

export function createOAuthRedis(url: string): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 1_000,
  });
  redis.on('error', () => undefined);
  return redis;
}

function keyFor(state: string): string {
  return `${REDIS_PREFIX}${createHash('sha256').update(state, 'utf8').digest('hex')}`;
}

function usedKeyFor(state: string): string {
  return `${REDIS_USED_PREFIX}${createHash('sha256').update(state, 'utf8').digest('hex')}`;
}

function idempotencyKey(ownerSub: string, operation: string, key: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify({ ownerSub, operation, key }), 'utf8')
    .digest('hex');
  return `${IDEMPOTENCY_PREFIX}${digest}`;
}

function parseIdempotencyRecord(
  value: string | null,
):
  | { status: 'PENDING'; fingerprint: string }
  | { status: 'COMPLETE'; fingerprint: string; result: unknown }
  | null {
  if (!value) return null;
  try {
    const record = JSON.parse(value) as Record<string, unknown>;
    if (typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint))
      return null;
    if (record.status === 'PENDING') return { status: 'PENDING', fingerprint: record.fingerprint };
    if (record.status === 'COMPLETE' && 'result' in record) {
      return { status: 'COMPLETE', fingerprint: record.fingerprint, result: record.result };
    }
    return null;
  } catch {
    return null;
  }
}

function isValidState(state: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(state);
}

function parseRecord(value: string): OAuthStateRecord | null {
  try {
    const record = JSON.parse(value) as Partial<OAuthStateRecord>;
    const keys = Object.keys(record).sort();
    if (
      JSON.stringify(keys) !==
        JSON.stringify([
          'expiresAt',
          'ownerSub',
          'provider',
          'redirectUri',
          'usedAt',
          'verifier',
        ]) ||
      record.provider !== 'GEMINI' ||
      typeof record.ownerSub !== 'string' ||
      record.ownerSub.length < 1 ||
      record.ownerSub.length > 256 ||
      typeof record.redirectUri !== 'string' ||
      typeof record.verifier !== 'string' ||
      !/^[A-Za-z0-9_-]{43}$/.test(record.verifier) ||
      typeof record.expiresAt !== 'number' ||
      !Number.isSafeInteger(record.expiresAt) ||
      record.usedAt !== null
    ) {
      return null;
    }
    return record as OAuthStateRecord;
  } catch {
    return null;
  }
}
