import {
  ProviderFailure,
  type OAuthCredentialRefreshPort,
  type StoredProviderCredential,
} from '@extractionstack/llm-core';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import type { CredentialVault } from '../../api/src/ai-connections/credential-vault.js';
import {
  fromPrismaEnvelope,
  toPrismaEnvelope,
} from '../../api/src/ai-connections/ai-connections.repository.js';

const StoredTokenSchema = z
  .object({
    accessToken: z.string().min(1).max(16_384),
    refreshToken: z.string().min(1).max(16_384).nullable(),
    expiresAt: z.string().datetime({ offset: true }),
  })
  .strict();
const RefreshResponseSchema = z
  .object({
    access_token: z.string().min(1).max(16_384),
    refresh_token: z.string().min(1).max(16_384).optional(),
    expires_in: z.number().int().positive().max(31_536_000),
  })
  .passthrough();

export class GeminiOAuthRefreshService implements OAuthCredentialRefreshPort {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly vault: CredentialVault,
    private readonly env: NodeJS.ProcessEnv,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async refresh(
    connectionId: string,
    stored: StoredProviderCredential,
    serializedCredential: string,
  ): Promise<string> {
    const current = parseStored(serializedCredential);
    if (stored.provider !== 'GEMINI' || stored.credentialMode !== 'OAUTH' || !current.refreshToken)
      throw new ProviderFailure('AUTHENTICATION_FAILED');
    const clientId = required(this.env.LLM_GEMINI_OAUTH_CLIENT_ID, 512);
    const clientSecret = required(this.env.LLM_GEMINI_OAUTH_CLIENT_SECRET, 1_024);
    const tokenUrl = new URL(
      this.env.LLM_GEMINI_OAUTH_TOKEN_URL ?? 'https://oauth2.googleapis.com/token',
    );
    if (tokenUrl.protocol !== 'https:') throw new ProviderFailure('AUTHENTICATION_FAILED');
    const leaseToken = randomUUID();
    await this.acquireLease(connectionId, stored, leaseToken);
    try {
      const rotated = await this.readRotatedCredential(connectionId, stored);
      if (rotated) return rotated;
      return await this.refreshWithLease(
        connectionId,
        stored,
        current.refreshToken,
        clientId,
        clientSecret,
        tokenUrl,
        leaseToken,
      );
    } finally {
      await this.releaseLease(connectionId, leaseToken).catch(() => undefined);
    }
  }

  private async refreshWithLease(
    connectionId: string,
    stored: StoredProviderCredential,
    refreshToken: string,
    clientId: string,
    clientSecret: string,
    tokenUrl: URL,
    leaseToken: string,
  ): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(tokenUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: clientId,
          client_secret: clientSecret,
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      throw new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
    }
    if (response.status === 400 || response.status === 401 || response.status === 403)
      throw new ProviderFailure('AUTHENTICATION_FAILED');
    if (!response.ok)
      throw new ProviderFailure('PROVIDER_UNAVAILABLE', {
        retryable: response.status === 429 || response.status >= 500,
      });
    let responseBody: unknown;
    try {
      responseBody = JSON.parse(await readBounded(response, 64 * 1024));
    } catch (error) {
      if (error instanceof ProviderFailure) throw error;
      throw new ProviderFailure('INVALID_RESPONSE');
    }
    const parsed = RefreshResponseSchema.safeParse(responseBody);
    if (!parsed.success) throw new ProviderFailure('INVALID_RESPONSE');
    const expiresAt = new Date(Date.now() + parsed.data.expires_in * 1_000);
    const payload = JSON.stringify({
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token ?? refreshToken,
      expiresAt: expiresAt.toISOString(),
    });
    const envelope = await this.vault.encrypt(stored.encryptionOwnerId, 'GEMINI', payload);

    return this.prisma.$transaction(async (transaction) => {
      const connection = await transaction.aiConnection.findFirst({
        where: {
          id: connectionId,
          ownerId: stored.ownerId,
          provider: 'GEMINI',
          credentialMode: 'OAUTH',
          state: 'ACTIVE',
          refreshLeaseToken: leaseToken,
          refreshLeaseExpiresAt: { gt: new Date() },
        },
        include: {
          credentials: { where: { deletedAt: null }, orderBy: { version: 'desc' }, take: 1 },
        },
      });
      const latest = connection?.credentials[0];
      if (!connection || !latest) throw new ProviderFailure('AUTHORIZATION_FAILED');
      if (latest.version !== stored.credentialVersion)
        throw new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
      await transaction.providerCredential.create({
        data: { connectionId, version: latest.version + 1, ...toPrismaEnvelope(envelope) },
      });
      await transaction.providerCredential.update({
        where: { id: latest.id },
        data: { rotatedAt: new Date() },
      });
      const released = await transaction.aiConnection.updateMany({
        where: { id: connectionId, refreshLeaseToken: leaseToken },
        data: {
          expiresAt,
          validatedAt: new Date(),
          lastUsedAt: new Date(),
          refreshLeaseToken: null,
          refreshLeaseExpiresAt: null,
        },
      });
      if (released.count !== 1)
        throw new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
      return parsed.data.access_token;
    });
  }

  private async acquireLease(
    connectionId: string,
    stored: StoredProviderCredential,
    leaseToken: string,
  ): Promise<void> {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const now = new Date();
      const acquired = await this.prisma.aiConnection.updateMany({
        where: {
          id: connectionId,
          ownerId: stored.ownerId,
          provider: 'GEMINI',
          credentialMode: 'OAUTH',
          state: 'ACTIVE',
          OR: [
            { refreshLeaseToken: null },
            { refreshLeaseExpiresAt: null },
            { refreshLeaseExpiresAt: { lte: now } },
          ],
        },
        data: {
          refreshLeaseToken: leaseToken,
          refreshLeaseExpiresAt: new Date(now.getTime() + 45_000),
        },
      });
      if (acquired.count === 1) return;
      if (await this.readRotatedCredential(connectionId, stored)) return;
      await delay(50);
    }
    throw new ProviderFailure('PROVIDER_UNAVAILABLE', { retryable: true });
  }

  private async readRotatedCredential(
    connectionId: string,
    stored: StoredProviderCredential,
  ): Promise<string | null> {
    const latest = await this.prisma.providerCredential.findFirst({
      where: { connectionId, deletedAt: null, version: { gt: stored.credentialVersion } },
      orderBy: { version: 'desc' },
    });
    if (!latest) return null;
    try {
      const plaintext = await this.vault.decrypt(
        stored.encryptionOwnerId,
        'GEMINI',
        fromPrismaEnvelope(latest),
      );
      return parseStored(plaintext).accessToken;
    } catch {
      throw new ProviderFailure('AUTHENTICATION_FAILED');
    }
  }

  private async releaseLease(connectionId: string, leaseToken: string): Promise<void> {
    await this.prisma.aiConnection.updateMany({
      where: { id: connectionId, refreshLeaseToken: leaseToken },
      data: { refreshLeaseToken: null, refreshLeaseExpiresAt: null },
    });
  }
}

function parseStored(value: string) {
  try {
    return StoredTokenSchema.parse(JSON.parse(value));
  } catch {
    throw new ProviderFailure('AUTHENTICATION_FAILED');
  }
}
function required(value: string | undefined, max: number): string {
  const parsed = z.string().trim().min(1).max(max).safeParse(value);
  if (!parsed.success) throw new ProviderFailure('AUTHENTICATION_FAILED');
  return parsed.data;
}
async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderFailure('INVALID_RESPONSE');
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let total = 0;
  let output = '';
  let complete = false;
  try {
    while (!complete) {
      const part = await reader.read();
      if (part.done) {
        complete = true;
        continue;
      }
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new ProviderFailure('INVALID_RESPONSE');
      }
      output += decoder.decode(part.value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    if (error instanceof ProviderFailure) throw error;
    throw new ProviderFailure('INVALID_RESPONSE');
  } finally {
    reader.releaseLock();
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
