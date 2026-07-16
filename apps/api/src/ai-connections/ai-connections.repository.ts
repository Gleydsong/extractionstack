import { Inject, Injectable } from '@nestjs/common';
import type { Auth0User } from '@extractionstack/shared';
import { PrismaClient, type AiConnection as PrismaAiConnection, type Prisma } from '@prisma/client';
import type { CredentialEnvelope } from './credential-vault.js';
import type {
  AiConnectionsRepositoryPort,
  StoredAiConnection,
} from './ai-connections.service.js';

type EnvelopeMetadata = Readonly<{
  schemaVersion: 1;
  wrappedKeyIv: string;
  wrappedKeyTag: string;
  iv: string;
  tag: string;
}>;

@Injectable()
export class AiConnectionsRepository implements AiConnectionsRepositoryPort {
  constructor(@Inject(PrismaClient) private readonly prisma: PrismaClient) {}

  async listOwned(actor: Auth0User): Promise<StoredAiConnection[]> {
    const connections = await this.prisma.aiConnection.findMany({
      where: { owner: { auth0Sub: actor.sub } },
      orderBy: { createdAt: 'desc' },
    });
    return connections.map(mapConnection);
  }

  async createApiKey(
    actor: Auth0User,
    input: Parameters<AiConnectionsRepositoryPort['createApiKey']>[1],
  ): Promise<StoredAiConnection> {
    return this.createConnection(actor, {
      ...input,
      provider: input.provider,
      credentialMode: 'API_KEY',
      auditAction: 'ai_connection.api_key_created',
    });
  }

  async createOAuth(
    ownerSub: string,
    input: Parameters<AiConnectionsRepositoryPort['createOAuth']>[1],
  ): Promise<StoredAiConnection> {
    const owner = await this.prisma.user.findUnique({ where: { auth0Sub: ownerSub } });
    if (!owner) throw new Error('OAuth owner no longer exists');
    return this.persistConnection(owner.id, {
      ...input,
      provider: 'GEMINI',
      credentialMode: 'OAUTH',
      auditAction: 'ai_connection.oauth_created',
    });
  }

  async findOwnedCredential(
    actor: Auth0User,
    id: string,
  ): Promise<{ connection: StoredAiConnection; envelope: CredentialEnvelope | null } | null> {
    const persisted = await this.findPersistedOwned(actor, id);
    if (!persisted) return null;
    const credential = persisted.credentials[0];
    return {
      connection: mapConnection(persisted),
      envelope: credential ? fromPrismaEnvelope(credential) : null,
    };
  }

  async updateValidation(
    actor: Auth0User,
    id: string,
    validation: Parameters<AiConnectionsRepositoryPort['updateValidation']>[2],
  ): Promise<StoredAiConnection | null> {
    const candidate = await this.prisma.aiConnection.findFirst({
      where: { id, owner: { auth0Sub: actor.sub }, state: { not: 'REVOKED' } },
      select: { id: true, ownerId: true },
    });
    if (!candidate) return null;
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.aiConnection.updateMany({
        where: { id, ownerId: candidate.ownerId, state: { not: 'REVOKED' } },
        data: { ...validation, scopes: [...validation.scopes] },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: candidate.ownerId,
          action: 'ai_connection.validated',
          entityType: 'AiConnection',
          entityId: id,
          metadata: { state: validation.state },
        },
      });
      return transaction.aiConnection.findFirst({ where: { id, ownerId: candidate.ownerId } });
    });
    return updated ? mapConnection(updated) : null;
  }

  async revokeOwned(actor: Auth0User, id: string): Promise<StoredAiConnection | null> {
    const candidate = await this.prisma.aiConnection.findFirst({
      where: { id, owner: { auth0Sub: actor.sub } },
      select: { id: true, ownerId: true },
    });
    if (!candidate) return null;
    const updated = await this.prisma.$transaction(async (transaction) => {
      await transaction.aiConnection.updateMany({
        where: { id, ownerId: candidate.ownerId },
        data: { state: 'REVOKED' },
      });
      await transaction.providerCredential.updateMany({
        where: { connectionId: id, connection: { ownerId: candidate.ownerId }, deletedAt: null },
        data: { deletedAt: new Date() },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: candidate.ownerId,
          action: 'ai_connection.revoked',
          entityType: 'AiConnection',
          entityId: id,
          metadata: {},
        },
      });
      return transaction.aiConnection.findFirst({ where: { id, ownerId: candidate.ownerId } });
    });
    return updated ? mapConnection(updated) : null;
  }

  async ensureOwner(actor: Auth0User): Promise<void> {
    await this.upsertActor(actor);
  }

  private findPersistedOwned(actor: Auth0User, id: string) {
    return this.prisma.aiConnection.findFirst({
      where: { id, owner: { auth0Sub: actor.sub } },
      include: {
        credentials: {
          where: { deletedAt: null },
          orderBy: { version: 'desc' },
          take: 1,
        },
      },
    });
  }

  private async createConnection(
    actor: Auth0User,
    input: {
      provider: 'OPENAI' | 'GEMINI';
      credentialMode: 'API_KEY' | 'OAUTH';
      displayLabel: string;
      maskedCredential: string;
      envelope: CredentialEnvelope;
      scopes: readonly string[];
      expiresAt: Date | null;
      validatedAt: Date;
      auditAction: string;
    },
  ): Promise<StoredAiConnection> {
    const owner = await this.upsertActor(actor);
    return this.persistConnection(owner.id, input);
  }

  private async persistConnection(
    ownerId: string,
    input: {
      provider: 'OPENAI' | 'GEMINI';
      credentialMode: 'API_KEY' | 'OAUTH';
      displayLabel: string;
      maskedCredential: string;
      envelope: CredentialEnvelope;
      scopes: readonly string[];
      expiresAt: Date | null;
      validatedAt: Date;
      auditAction: string;
    },
  ): Promise<StoredAiConnection> {
    const envelope = toPrismaEnvelope(input.envelope);
    const created = await this.prisma.$transaction(async (transaction) => {
      const connection = await transaction.aiConnection.create({
        data: {
          ownerId,
          provider: input.provider,
          displayLabel: input.displayLabel,
          credentialMode: input.credentialMode,
          state: 'ACTIVE',
          maskedCredential: input.maskedCredential,
          scopes: [...input.scopes],
          expiresAt: input.expiresAt,
          validatedAt: input.validatedAt,
          credentials: { create: { version: 1, ...envelope } },
        },
      });
      await transaction.auditEvent.create({
        data: {
          actorId: ownerId,
          action: input.auditAction,
          entityType: 'AiConnection',
          entityId: connection.id,
          metadata: { provider: input.provider, credentialMode: input.credentialMode },
        },
      });
      return connection;
    });
    return mapConnection(created);
  }

  private upsertActor(actor: Auth0User) {
    return this.prisma.user.upsert({
      where: { auth0Sub: actor.sub },
      create: {
        auth0Sub: actor.sub,
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
      update: {
        email: actor.email,
        name: actor.name,
        role: actor.roles.includes('admin') ? 'ADMIN' : 'USER',
      },
    });
  }
}

function mapConnection(connection: PrismaAiConnection): StoredAiConnection {
  return {
    id: connection.id,
    ownerId: connection.ownerId,
    provider: connection.provider,
    displayLabel: connection.displayLabel,
    credentialMode: connection.credentialMode,
    state: connection.state,
    maskedCredential: connection.maskedCredential,
    scopes: connection.scopes,
    expiresAt: connection.expiresAt,
    validatedAt: connection.validatedAt,
    lastUsedAt: connection.lastUsedAt,
    createdAt: connection.createdAt,
    updatedAt: connection.updatedAt,
  };
}

export function toPrismaEnvelope(envelope: CredentialEnvelope): {
  ciphertext: Buffer;
  encryptedDataKey: Buffer;
  algorithm: string;
  keyVersion: string;
  authenticatedMetadata: Prisma.InputJsonValue;
} {
  if (
    envelope.algorithm !== 'AES-256-GCM' ||
    envelope.keyVersion.length < 1 ||
    envelope.keyVersion.length > 64 ||
    envelope.keyVersion.trim() !== envelope.keyVersion
  ) {
    throw new Error('invalid credential envelope');
  }
  assertCanonicalBase64(envelope.ciphertext, 1, 64 * 1024);
  assertCanonicalBase64(envelope.wrappedKey, 32, 32);
  assertCanonicalBase64(envelope.wrappedKeyIv, 12, 12);
  assertCanonicalBase64(envelope.wrappedKeyTag, 16, 16);
  assertCanonicalBase64(envelope.iv, 12, 12);
  assertCanonicalBase64(envelope.tag, 16, 16);
  const metadata: EnvelopeMetadata = {
    schemaVersion: 1,
    wrappedKeyIv: envelope.wrappedKeyIv,
    wrappedKeyTag: envelope.wrappedKeyTag,
    iv: envelope.iv,
    tag: envelope.tag,
  };
  return {
    ciphertext: decodeCanonical(envelope.ciphertext),
    encryptedDataKey: decodeCanonical(envelope.wrappedKey),
    algorithm: envelope.algorithm,
    keyVersion: envelope.keyVersion,
    authenticatedMetadata: metadata,
  };
}

export function fromPrismaEnvelope(credential: {
  ciphertext: Uint8Array;
  encryptedDataKey: Uint8Array;
  algorithm: string;
  keyVersion: string;
  authenticatedMetadata: unknown;
}): CredentialEnvelope {
  const metadata = parseMetadata(credential.authenticatedMetadata);
  if (
    credential.algorithm !== 'AES-256-GCM' ||
    credential.keyVersion.length < 1 ||
    credential.keyVersion.length > 64 ||
    credential.keyVersion.trim() !== credential.keyVersion ||
    credential.encryptedDataKey.byteLength !== 32 ||
    credential.ciphertext.byteLength < 1 ||
    credential.ciphertext.byteLength > 64 * 1024
  ) throw new Error('invalid credential envelope');
  return Object.freeze({
    algorithm: credential.algorithm,
    keyVersion: credential.keyVersion,
    wrappedKey: Buffer.from(credential.encryptedDataKey).toString('base64'),
    wrappedKeyIv: metadata.wrappedKeyIv,
    wrappedKeyTag: metadata.wrappedKeyTag,
    ciphertext: Buffer.from(credential.ciphertext).toString('base64'),
    iv: metadata.iv,
    tag: metadata.tag,
  });
}

function parseMetadata(value: unknown): EnvelopeMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid credential envelope');
  const metadata = value as Record<string, unknown>;
  const keys = Object.keys(metadata).sort();
  const expected = ['iv', 'schemaVersion', 'tag', 'wrappedKeyIv', 'wrappedKeyTag'];
  if (JSON.stringify(keys) !== JSON.stringify(expected) || metadata.schemaVersion !== 1) {
    throw new Error('invalid credential envelope');
  }
  for (const key of ['wrappedKeyIv', 'wrappedKeyTag', 'iv', 'tag'] as const) {
    assertCanonicalBase64(
      metadata[key],
      key.endsWith('Tag') || key === 'tag' ? 16 : 12,
      key.endsWith('Tag') || key === 'tag' ? 16 : 12,
    );
  }
  return metadata as EnvelopeMetadata;
}

function assertCanonicalBase64(
  value: unknown,
  minimumBytes = 1,
  maximumBytes = 64 * 1024,
): asserts value is string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new Error('invalid credential envelope');
  }
  const decoded = Buffer.from(value, 'base64');
  if (
    decoded.length < minimumBytes ||
    decoded.length > maximumBytes ||
    decoded.toString('base64') !== value
  ) throw new Error('invalid credential envelope');
}

function decodeCanonical(value: string): Buffer {
  assertCanonicalBase64(value);
  return Buffer.from(value, 'base64');
}
