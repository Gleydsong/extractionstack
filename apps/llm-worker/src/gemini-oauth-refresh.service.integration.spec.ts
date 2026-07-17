import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CredentialVault } from '../../api/src/ai-connections/credential-vault';
import { toPrismaEnvelope } from '../../api/src/ai-connections/ai-connections.repository';
import { GeminiOAuthRefreshService } from './gemini-oauth-refresh.service';

const databaseUrl = process.env.TEST_DATABASE_URL;
const describePostgres = databaseUrl ? describe : describe.skip;
const prisma = new PrismaClient({
  datasources: { db: { url: databaseUrl ?? 'postgresql://skip:skip@127.0.0.1:1/skip' } },
});

describePostgres('GeminiOAuthRefreshService PostgreSQL integration', () => {
  afterAll(async () => prisma.$disconnect());

  it('uses one provider refresh for concurrent workers and returns the rotated token to both', async () => {
    const suffix = randomUUID();
    const auth0Sub = `auth0|oauth-refresh-${suffix}`;
    const vault = new CredentialVault(Buffer.alloc(32, 23).toString('base64'), 'oauth-test-v1');
    const serialized = JSON.stringify({
      accessToken: 'expired-access',
      refreshToken: 'refresh-secret',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const envelope = await vault.encrypt(auth0Sub, 'GEMINI', serialized);
    const user = await prisma.user.create({
      data: { auth0Sub, email: `oauth-refresh-${suffix}@example.test` },
    });
    const connection = await prisma.aiConnection.create({
      data: {
        ownerId: user.id,
        provider: 'GEMINI',
        displayLabel: `OAuth ${suffix}`,
        credentialMode: 'OAUTH',
        state: 'ACTIVE',
        scopes: [],
        credentials: { create: { version: 1, ...toPrismaEnvelope(envelope) } },
      },
    });
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return new Response(JSON.stringify({ access_token: 'rotated-access', expires_in: 3600 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    const service = new GeminiOAuthRefreshService(
      prisma,
      vault,
      { LLM_GEMINI_OAUTH_CLIENT_ID: 'client-id', LLM_GEMINI_OAUTH_CLIENT_SECRET: 'client-secret' },
      fetchImpl as typeof fetch,
    );
    const stored = {
      ownerId: user.id,
      encryptionOwnerId: auth0Sub,
      provider: 'GEMINI' as const,
      credentialMode: 'OAUTH' as const,
      credentialVersion: 1,
      state: 'ACTIVE' as const,
      expiresAt: new Date(Date.now() - 60_000),
      encryptedCredential: envelope,
    };

    const results = await Promise.all([
      service.refresh(connection.id, stored, serialized),
      service.refresh(connection.id, stored, serialized),
    ]);

    expect(results).toEqual(['rotated-access', 'rotated-access']);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(await prisma.providerCredential.count({ where: { connectionId: connection.id } })).toBe(
      2,
    );
    await expect(
      prisma.aiConnection.findUniqueOrThrow({ where: { id: connection.id } }),
    ).resolves.toMatchObject({
      refreshLeaseToken: null,
      refreshLeaseExpiresAt: null,
    });
    await prisma.user.delete({ where: { id: user.id } });
  });
});
