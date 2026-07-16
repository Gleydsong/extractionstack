import { createHash } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { Auth0User } from '@extractionstack/shared';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AiConnectionsRepository } from './ai-connections.repository.js';
import {
  AiConnectionsService,
  type DurableMutationInput,
  type OAuthTokenClientPort,
  type ProviderCredentialVerifierPort,
} from './ai-connections.service.js';
import { CredentialVault } from './credential-vault.js';
import { InMemoryOAuthStateStore, RedisIdempotencyService } from './oauth-state.service.js';

const databaseUrl = process.env.TEST_DATABASE_URL;
const prismaUrl = databaseUrl ?? 'postgresql://skip:skip@127.0.0.1:1/skip';
const describePostgres = databaseUrl ? describe : describe.skip;
const actor: Auth0User = { sub: 'auth0|postgres-owner', roles: ['user'] };
const otherActor: Auth0User = { sub: 'auth0|postgres-other', roles: ['user'] };
const now = new Date('2026-07-17T10:00:00.000Z');
const apiKey = 'sk-postgres-integration-secret';

describePostgres('AiConnectionsRepository PostgreSQL integration', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: prismaUrl } } });
  const repository = new AiConnectionsRepository(prisma);
  const vault = new CredentialVault(Buffer.alloc(32, 19).toString('base64'), 'integration-v1');

  beforeEach(async () => {
    await prisma.auditEvent.deleteMany();
    await prisma.mutationIdempotency.deleteMany();
    await prisma.providerCredential.deleteMany();
    await prisma.aiConnection.deleteMany();
    await prisma.user.deleteMany();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('reconciles a retry from PostgreSQL when Redis cannot cache the committed result', async () => {
    const service = createService(repository, vault);

    const first = await service.addApiKey(
      actor,
      { provider: 'OPENAI', displayLabel: 'Postgres key', apiKey },
      'integration-add-0001',
    );
    const replay = await service.addApiKey(
      actor,
      { provider: 'OPENAI', displayLabel: 'Postgres key', apiKey },
      'integration-add-0001',
    );

    expect(replay).toEqual(first);
    expect(await prisma.aiConnection.count()).toBe(1);
    expect(
      await prisma.auditEvent.count({ where: { action: 'ai_connection.api_key_created' } }),
    ).toBe(1);
    expect(await prisma.mutationIdempotency.findFirst()).toMatchObject({
      operation: 'add-api-key',
      status: 'COMPLETE',
      entityId: first.id,
    });

    const stored = await repository.findOwnedCredential(actor, first.id);
    expect(stored?.envelope).not.toBeNull();
    expect(JSON.stringify(stored?.envelope)).not.toContain(apiKey);
    expect(await vault.decrypt(actor.sub, 'OPENAI', stored!.envelope!)).toBe(apiKey);
    expect(await repository.findOwnedCredential(otherActor, first.id)).toBeNull();
    await expect(
      service.remove(otherActor, first.id, 'integration-remove-other'),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it('serializes concurrent use of one durable mutation key without duplicate connection or audit', async () => {
    const envelope = await vault.encrypt(actor.sub, 'OPENAI', apiKey);
    const input = {
      provider: 'OPENAI' as const,
      displayLabel: 'Concurrent key',
      maskedCredential: '…cret',
      envelope,
      scopes: [] as const,
      expiresAt: null,
      validatedAt: now,
      idempotency: durable('add-api-key', 'integration-concurrent', { apiKey }),
    };

    const [left, right] = await Promise.all([
      repository.createApiKey(actor, input),
      repository.createApiKey(actor, input),
    ]);

    expect(left.result).toEqual(right.result);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(await prisma.aiConnection.count()).toBe(1);
    expect(await prisma.providerCredential.count()).toBe(1);
    expect(await prisma.auditEvent.count()).toBe(1);
    expect(await prisma.mutationIdempotency.count()).toBe(1);
  });

  it('keeps validation and revocation atomic and never writes an audit for a failed state transition', async () => {
    const service = createService(repository, vault);
    const created = await service.addApiKey(
      actor,
      { provider: 'OPENAI', displayLabel: 'Lifecycle key', apiKey },
      'integration-lifecycle-add',
    );

    const [validation, revocation] = await Promise.all([
      repository.updateValidation(actor, created.id, {
        state: 'ACTIVE',
        scopes: ['models.read'],
        expiresAt: null,
        validatedAt: now,
        idempotency: durable(`validate:${created.id}`, 'integration-lifecycle-validate', {
          id: created.id,
        }),
      }),
      repository.revokeOwned(
        actor,
        created.id,
        durable(`remove:${created.id}`, 'integration-lifecycle-remove', { id: created.id }),
      ),
    ]);

    expect(revocation?.result.state).toBe('REVOKED');
    expect((await prisma.aiConnection.findUniqueOrThrow({ where: { id: created.id } })).state).toBe(
      'REVOKED',
    );
    expect(
      await prisma.auditEvent.count({
        where: { action: 'ai_connection.validated', entityId: created.id },
      }),
    ).toBe(validation ? 1 : 0);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'ai_connection.revoked', entityId: created.id },
      }),
    ).toBe(1);
    expect((await prisma.providerCredential.findFirstOrThrow()).deletedAt).not.toBeNull();

    const replay = await repository.revokeOwned(
      actor,
      created.id,
      durable(`remove:${created.id}`, 'integration-lifecycle-remove', { id: created.id }),
    );
    expect(replay?.replayed).toBe(true);
    expect(
      await prisma.auditEvent.count({
        where: { action: 'ai_connection.revoked', entityId: created.id },
      }),
    ).toBe(1);
  });
});

function createService(repository: AiConnectionsRepository, vault: CredentialVault) {
  const verifier: ProviderCredentialVerifierPort = {
    verify: async () => ({ valid: true, scopes: [], expiresAt: null }),
  };
  const oauth: OAuthTokenClientPort = {
    exchangeGeminiCode: async () => {
      throw new Error('not used');
    },
    revokeGemini: async () => undefined,
  };
  let cachedLease: string | null = null;
  const failingCompletionCache = {
    status: 'ready',
    get: async () => cachedLease,
    set: async (_key: string, value: string) => {
      if (cachedLease) return null;
      cachedLease = value;
      return 'OK' as const;
    },
    del: async () => 0,
    eval: async () => {
      throw new Error('redis completion unavailable');
    },
  };
  const idempotency = new RedisIdempotencyService(failingCompletionCache as never);
  return new AiConnectionsService(
    repository,
    vault,
    verifier,
    new InMemoryOAuthStateStore(),
    oauth,
    {
      geminiClientId: 'unused',
      geminiAuthorizationUrl: 'https://accounts.example.test/oauth',
      allowedRedirectUris: [],
      now: () => now,
    },
    idempotency,
  );
}

function durable(operation: string, key: string, request: unknown): DurableMutationInput {
  return {
    operation,
    keyHash: hash(key),
    requestHash: hash(JSON.stringify(request)),
  };
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
