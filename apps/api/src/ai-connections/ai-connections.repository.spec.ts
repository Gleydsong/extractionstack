import type { PrismaClient } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import {
  AiConnectionsRepository,
  fromPrismaEnvelope,
  toPrismaEnvelope,
} from './ai-connections.repository.js';
import { CredentialVault } from './credential-vault.js';

describe('AiConnectionsRepository security boundaries', () => {
  it('includes the owner in the credential lookup predicate', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const repository = new AiConnectionsRepository({
      aiConnection: { findFirst },
    } as unknown as PrismaClient);

    await repository.findOwnedCredential(
      { sub: 'auth0|owner', roles: ['admin'] },
      'cm1234567890',
    );

    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'cm1234567890', owner: { auth0Sub: 'auth0|owner' } },
      }),
    );
  });

  it('revokes and audits inside one owner-scoped transaction', async () => {
    const revoked = {
      id: 'cm1234567890',
      ownerId: 'owner-id',
      provider: 'GEMINI',
      displayLabel: 'Gemini',
      credentialMode: 'OAUTH',
      state: 'REVOKED',
      maskedCredential: '…cret',
      scopes: [],
      expiresAt: null,
      validatedAt: null,
      lastUsedAt: null,
      createdAt: new Date('2026-07-16T12:00:00Z'),
      updatedAt: new Date('2026-07-16T12:00:00Z'),
    } as const;
    const findFirst = vi.fn().mockResolvedValue({ id: revoked.id, ownerId: revoked.ownerId });
    const transaction = {
      aiConnection: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(revoked),
      },
      providerCredential: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      auditEvent: { create: vi.fn().mockResolvedValue({ id: 'audit-id' }) },
    };
    const prisma = {
      aiConnection: { findFirst },
      $transaction: vi.fn(async (run: (client: typeof transaction) => unknown) => run(transaction)),
    } as unknown as PrismaClient;
    const repository = new AiConnectionsRepository(prisma);

    await expect(
      repository.revokeOwned({ sub: 'auth0|owner', roles: ['user'] }, revoked.id),
    ).resolves.toMatchObject({ state: 'REVOKED' });

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: revoked.id, owner: { auth0Sub: 'auth0|owner' } },
      select: { id: true, ownerId: true },
    });
    expect(transaction.aiConnection.updateMany).toHaveBeenCalledWith({
      where: { id: revoked.id, ownerId: revoked.ownerId },
      data: { state: 'REVOKED' },
    });
    expect(transaction.providerCredential.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          connectionId: revoked.id,
          connection: { ownerId: revoked.ownerId },
        }),
      }),
    );
    expect(transaction.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ actorId: revoked.ownerId, action: 'ai_connection.revoked' }),
      }),
    );
  });

  it('round-trips only the canonical encrypted envelope and never plaintext', async () => {
    const vault = new CredentialVault(Buffer.alloc(32, 9).toString('base64'), 'test-v1');
    const envelope = await vault.encrypt('auth0|owner', 'OPENAI', 'sk-plaintext-secret');

    const persisted = toPrismaEnvelope(envelope);
    const restored = fromPrismaEnvelope(persisted);

    expect(restored).toEqual(envelope);
    expect(JSON.stringify(persisted)).not.toContain('sk-plaintext-secret');
    await expect(vault.decrypt('auth0|owner', 'OPENAI', restored)).resolves.toBe(
      'sk-plaintext-secret',
    );
  });

  it('rejects non-canonical credential metadata', () => {
    expect(() =>
      fromPrismaEnvelope({
        ciphertext: Buffer.from('ciphertext'),
        encryptedDataKey: Buffer.alloc(32),
        algorithm: 'AES-256-GCM',
        keyVersion: 'test-v1',
        authenticatedMetadata: {
          schemaVersion: 1,
          wrappedKeyIv: Buffer.alloc(12).toString('base64'),
          wrappedKeyTag: Buffer.alloc(16).toString('base64'),
          iv: Buffer.alloc(12).toString('base64'),
          tag: Buffer.alloc(16).toString('base64'),
          unexpected: 'field',
        },
      }),
    ).toThrow('invalid credential envelope');
  });
});
