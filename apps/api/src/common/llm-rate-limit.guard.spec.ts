import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { ServiceUnavailableException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import {
  LLM_RATE_LIMIT_METADATA,
  LlmRateLimitGuard,
  LlmRatePolicies,
  RedisLlmRateLimitStore,
  type LlmRateLimitStore,
} from './llm-rate-limit.guard.js';

const handler = () => undefined;
Reflect.defineMetadata(LLM_RATE_LIMIT_METADATA, LlmRatePolicies.GENERATE, handler);

function context(
  input: Partial<{
    ip: string;
    user: { sub: string };
    limited: boolean;
    path: string;
    headers: unknown;
  }> = {},
) {
  const request = {
    ip: input.ip ?? '203.0.113.5',
    user: input.user ?? { sub: 'auth0|owner-1' },
    path: input.path,
    headers: input.headers,
  };
  return {
    getHandler: () => (input.limited === false ? () => undefined : handler),
    getClass: () => class Controller {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

function guard(store: LlmRateLimitStore) {
  return new LlmRateLimitGuard(store, 'test-hmac-key-at-least-32-bytes', new Reflector());
}

describe('LlmRateLimitGuard', () => {
  it('defines a specific costly policy for immutable version edits', () => {
    expect(LlmRatePolicies.EDIT.operation).toBe('edit');
    expect(LlmRatePolicies.EDIT.costly).toBe(true);
    expect(LlmRatePolicies.EDIT).not.toBe(LlmRatePolicies.PROJECT_CREATE);
  });
  it('consumes separate opaque user and IP keys from route metadata', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }),
    };
    await expect(guard(store).canActivate(context({ path: '/API/ANY-CASE' }))).resolves.toBe(true);
    const [keys, selected] = vi.mocked(store.consume).mock.calls[0]!;
    expect(keys.user).toMatch(/^llm-rate:v2:user:[a-f0-9]{64}$/);
    expect(keys.ip).toMatch(/^llm-rate:v2:ip:[a-f0-9]{64}$/);
    expect(JSON.stringify(keys)).not.toMatch(/owner-1|203\.0\.113\.5/);
    expect(selected).toBe(LlmRatePolicies.GENERATE);
  });

  it('prevents user and IP rotation from resetting the other dimension', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }),
    };
    const instance = guard(store);
    await instance.canActivate(context({ ip: '203.0.113.5', user: { sub: 'owner-a' } }));
    await instance.canActivate(context({ ip: '203.0.113.6', user: { sub: 'owner-a' } }));
    await instance.canActivate(context({ ip: '203.0.113.5', user: { sub: 'owner-b' } }));
    const [first, second, third] = vi.mocked(store.consume).mock.calls.map(([keys]) => keys);
    expect(first!.user).toBe(second!.user);
    expect(first!.ip).not.toBe(second!.ip);
    expect(first!.user).not.toBe(third!.user);
    expect(first!.ip).toBe(third!.ip);
  });

  it('uses req.ip only and ignores spoofed forwarded headers', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockResolvedValue({ allowed: true, remaining: 1 }),
    };
    const instance = guard(store);
    await instance.canActivate(
      context({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '198.51.100.9' } }),
    );
    await instance.canActivate(
      context({ ip: '127.0.0.1', headers: { 'x-forwarded-for': '192.0.2.9' } }),
    );
    expect(vi.mocked(store.consume).mock.calls[0]![0].ip).toBe(
      vi.mocked(store.consume).mock.calls[1]![0].ip,
    );
  });

  it('rejects when either atomic dimension is exhausted', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockResolvedValue({ allowed: false, remaining: 0 }),
    };
    await expect(guard(store).canActivate(context())).rejects.toMatchObject({
      status: 429,
      response: { code: 'RATE_LIMITED' },
    });
  });

  it('fails closed for annotated costly mutations when Redis is unavailable', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockRejectedValue(new Error('redis://secret')),
    };
    await expect(guard(store).canActivate(context())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('does not invoke the dedicated limiter for unannotated reads', async () => {
    const store: LlmRateLimitStore = {
      consume: vi.fn().mockRejectedValue(new Error('redis://secret')),
    };
    await expect(guard(store).canActivate(context({ limited: false }))).resolves.toBe(true);
    expect(store.consume).not.toHaveBeenCalled();
  });

  it('increments both dimensions in one Redis script and rejects either overflow', async () => {
    const redis = { eval: vi.fn().mockResolvedValue([3, 13]) };
    const store = new RedisLlmRateLimitStore(redis as never);
    await expect(
      store.consume({ user: 'user-key', ip: 'ip-key' }, LlmRatePolicies.GENERATE),
    ).resolves.toEqual({ allowed: false, remaining: 0 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("INCR',KEYS[2]"),
      2,
      'user-key',
      'ip-key',
      '60000',
    );
  });
});
