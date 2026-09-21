import { describe, expect, it } from 'vitest';
import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { Auth0User } from '@extractionstack/shared';
import { ExtractionsRepository } from './extractions.repository.js';

type UserRole = 'USER' | 'ADMIN';
type JobStatus =
  | 'QUEUED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCEL_REQUESTED'
  | 'CANCELLED';

type FakeUser = {
  id: string;
  email: string;
  auth0Sub: string | null;
  name: string | null;
  role: UserRole;
};

type FakeJob = {
  id: string;
  ownerId: string;
  requestedUrl: string;
  normalizedUrl: string;
  idempotencyKey: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  errorCode: string | null;
  errorMessage: string | null;
  queuedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  report: null;
};

type SeedJob = {
  id: string;
  ownerId: string;
  idempotencyKey?: string;
  requestedUrl?: string;
  normalizedUrl?: string;
  status?: JobStatus;
};

type FakeState = {
  users: FakeUser[];
  jobs: FakeJob[];
  auditEvents: unknown[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/**
 * Minimal in-memory Prisma emulation with the DB semantics the repository
 * relies on: users keyed by `id`/`auth0Sub`, a unique constraint on `email`,
 * jobs keyed by `id` and by `[ownerId, idempotencyKey]`, an `owner` relation,
 * and a nullable `report` relation.
 */
function createFakePrisma(seed: { users?: FakeUser[]; jobs?: SeedJob[] } = {}) {
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_${++counter}`;
  const now = new Date();

  const state: FakeState = {
    users: (seed.users ?? []).map((user) => ({ ...user })),
    jobs: (seed.jobs ?? []).map((job) => ({
      id: job.id,
      ownerId: job.ownerId,
      requestedUrl: job.requestedUrl ?? 'https://example.com',
      normalizedUrl: job.normalizedUrl ?? 'https://example.com/',
      idempotencyKey: job.idempotencyKey ?? nextId('key'),
      status: job.status ?? 'QUEUED',
      attempts: 0,
      maxAttempts: 3,
      errorCode: null,
      errorMessage: null,
      queuedAt: now,
      startedAt: null,
      finishedAt: null,
      createdAt: now,
      updatedAt: now,
      report: null,
    })),
    auditEvents: [],
  };

  const uniqueError = (target: string[]) =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: '5.22.0',
      meta: { target },
    });

  const findUser = (where: Record<string, unknown>): FakeUser | undefined =>
    state.users.find((user) =>
      Object.entries(where).every(([key, value]) => (user as Record<string, unknown>)[key] === value),
    );

  const assertEmailFree = (email: string) => {
    if (state.users.some((user) => user.email === email)) throw uniqueError(['email']);
  };

  const ownerMatches = (job: FakeJob, ownerWhere: unknown): boolean => {
    const owner = state.users.find((user) => user.id === job.ownerId);
    if (!owner) return false;
    if (!isRecord(ownerWhere)) return false;
    const or = ownerWhere['OR'];
    if (Array.isArray(or)) {
      return or.some(
        (clause) =>
          isRecord(clause) &&
          Object.entries(clause).every(
            ([key, value]) => (owner as Record<string, unknown>)[key] === value,
          ),
      );
    }
    return Object.entries(ownerWhere).every(
      ([key, value]) => (owner as Record<string, unknown>)[key] === value,
    );
  };

  const statusMatches = (status: JobStatus, statusWhere: unknown): boolean => {
    if (isRecord(statusWhere) && Array.isArray(statusWhere['in'])) {
      return (statusWhere['in'] as unknown[]).includes(status);
    }
    return status === statusWhere;
  };

  const matchesJob = (job: FakeJob, where: Record<string, unknown> = {}): boolean => {
    const composite = where['ownerId_idempotencyKey'];
    if (isRecord(composite)) {
      if (
        job.ownerId !== composite['ownerId'] ||
        job.idempotencyKey !== composite['idempotencyKey']
      ) {
        return false;
      }
    }
    if (where['id'] !== undefined && job.id !== where['id']) return false;
    if (where['status'] !== undefined && !statusMatches(job.status, where['status'])) return false;
    if (where['owner'] !== undefined && !ownerMatches(job, where['owner'])) return false;
    return true;
  };

  const user = {
    async upsert({
      where,
      create,
      update,
    }: {
      where: Record<string, unknown>;
      create: Partial<FakeUser>;
      update: Partial<FakeUser>;
    }) {
      const existing = findUser(where);
      if (existing) {
        Object.assign(existing, update);
        return existing;
      }
      if (typeof create.email !== 'string') throw new Error('fake-prisma: email required');
      assertEmailFree(create.email);
      const row: FakeUser = {
        id: nextId('user'),
        email: create.email,
        auth0Sub: create.auth0Sub ?? null,
        name: create.name ?? null,
        role: create.role ?? 'USER',
      };
      state.users.push(row);
      return row;
    },
    async create({ data }: { data: Partial<FakeUser> }) {
      if (typeof data.email !== 'string') throw new Error('fake-prisma: email required');
      assertEmailFree(data.email);
      const row: FakeUser = {
        id: data.id ?? nextId('user'),
        email: data.email,
        auth0Sub: data.auth0Sub ?? null,
        name: data.name ?? null,
        role: data.role ?? 'USER',
      };
      state.users.push(row);
      return row;
    },
    async findUnique({ where }: { where: Record<string, unknown> }) {
      return findUser(where) ?? null;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      const or = where['OR'];
      if (Array.isArray(or)) {
        return (
          state.users.find((candidate) =>
            or.some((clause) => isRecord(clause) && findUser(clause) === candidate),
          ) ?? null
        );
      }
      return findUser(where) ?? null;
    },
  };

  const extractionJob = {
    async findUnique({ where }: { where: Record<string, unknown> }) {
      return state.jobs.find((job) => matchesJob(job, where)) ?? null;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return state.jobs.find((job) => matchesJob(job, where)) ?? null;
    },
    async findMany({
      where = {},
      orderBy,
      cursor,
      take,
    }: {
      where?: Record<string, unknown>;
      orderBy?: { createdAt?: 'asc' | 'desc' };
      cursor?: { id: string };
      take?: number;
    } = {}) {
      let rows = state.jobs.filter((job) => matchesJob(job, where));
      if (orderBy?.createdAt) {
        const direction = orderBy.createdAt === 'asc' ? 1 : -1;
        rows = [...rows].sort(
          (a, b) => (a.createdAt.getTime() - b.createdAt.getTime()) * direction,
        );
      }
      if (cursor) {
        const index = rows.findIndex((job) => job.id === cursor.id);
        rows = index >= 0 ? rows.slice(index + 1) : rows;
      }
      return typeof take === 'number' ? rows.slice(0, take) : rows;
    },
    async create({ data }: { data: Partial<FakeJob> }) {
      if (
        state.jobs.some(
          (job) => job.ownerId === data.ownerId && job.idempotencyKey === data.idempotencyKey,
        )
      ) {
        throw uniqueError(['ownerId', 'idempotencyKey']);
      }
      const timestamp = new Date();
      const row: FakeJob = {
        id: data.id ?? nextId('job'),
        ownerId: data.ownerId!,
        requestedUrl: data.requestedUrl!,
        normalizedUrl: data.normalizedUrl!,
        idempotencyKey: data.idempotencyKey!,
        status: 'QUEUED',
        attempts: 0,
        maxAttempts: 3,
        errorCode: null,
        errorMessage: null,
        queuedAt: timestamp,
        startedAt: null,
        finishedAt: null,
        createdAt: timestamp,
        updatedAt: timestamp,
        report: null,
      };
      state.jobs.push(row);
      return row;
    },
    async updateMany({
      where = {},
      data,
    }: {
      where?: Record<string, unknown>;
      data: Partial<FakeJob>;
    }) {
      const targets = state.jobs.filter((job) => matchesJob(job, where));
      for (const job of targets) Object.assign(job, data);
      return { count: targets.length };
    },
  };

  const auditEvent = {
    async create({ data }: { data: unknown }) {
      state.auditEvents.push(data);
      return data;
    },
  };

  const prisma = {
    user,
    extractionJob,
    auditEvent,
    $transaction: async <T>(callback: (tx: unknown) => Promise<T>): Promise<T> =>
      callback({ extractionJob, auditEvent }),
  };

  return { prisma: prisma as unknown as PrismaClient, state };
}

const localActor: Auth0User = { sub: 'user_local_1', email: 'a@b.com', roles: ['user'] };
const legacyActor: Auth0User = { sub: 'auth0|legacy', roles: ['user'] };

describe('ExtractionsRepository identity resolution', () => {
  it('createOrGet resolves owner by user id for local users without creating a shadow user', async () => {
    const { prisma, state } = createFakePrisma({
      users: [{ id: 'user_local_1', email: 'a@b.com', auth0Sub: null, name: 'A', role: 'USER' }],
    });
    const repository = new ExtractionsRepository(prisma);

    const result = await repository.createOrGet({
      actor: localActor,
      command: { url: 'https://example.com' },
      normalizedUrl: 'https://example.com/',
      idempotencyKey: 'k1',
    });

    expect(result.created).toBe(true);
    expect(state.users).toHaveLength(1);
    expect(state.jobs).toHaveLength(1);
    expect(state.jobs[0]!.ownerId).toBe('user_local_1');
  });

  it('findOwned returns the local user job and not another user job', async () => {
    const { prisma } = createFakePrisma({
      users: [
        { id: 'user_local_1', email: 'a@b.com', auth0Sub: null, name: 'A', role: 'USER' },
        { id: 'user_other', email: 'c@d.com', auth0Sub: null, name: 'C', role: 'USER' },
      ],
      jobs: [
        { id: 'job_local', ownerId: 'user_local_1' },
        { id: 'job_other', ownerId: 'user_other' },
      ],
    });
    const repository = new ExtractionsRepository(prisma);

    const mine = await repository.findOwned(localActor, 'job_local');
    const theirs = await repository.findOwned(localActor, 'job_other');

    expect(mine?.id).toBe('job_local');
    expect(theirs).toBeNull();
  });

  it('findOwned resolves a legacy Auth0 user by auth0Sub', async () => {
    const { prisma } = createFakePrisma({
      users: [
        { id: 'user_legacy', email: 'legacy@x.com', auth0Sub: 'auth0|legacy', name: 'L', role: 'USER' },
      ],
      jobs: [{ id: 'job_legacy', ownerId: 'user_legacy' }],
    });
    const repository = new ExtractionsRepository(prisma);

    const job = await repository.findOwned(legacyActor, 'job_legacy');

    expect(job?.id).toBe('job_legacy');
  });

  it('listOwned returns only the local user jobs', async () => {
    const { prisma } = createFakePrisma({
      users: [
        { id: 'user_local_1', email: 'a@b.com', auth0Sub: null, name: 'A', role: 'USER' },
        { id: 'user_other', email: 'c@d.com', auth0Sub: null, name: 'C', role: 'USER' },
      ],
      jobs: [
        { id: 'job_local_a', ownerId: 'user_local_1' },
        { id: 'job_local_b', ownerId: 'user_local_1' },
        { id: 'job_other', ownerId: 'user_other' },
      ],
    });
    const repository = new ExtractionsRepository(prisma);

    const { items } = await repository.listOwned(localActor, {
      limit: 20,
      sort: 'createdAt:desc',
    });

    expect(items.map((item) => item.id).sort()).toEqual(['job_local_a', 'job_local_b']);
  });

  it('requestCancellation cancels the local user job and refuses another user job', async () => {
    const { prisma, state } = createFakePrisma({
      users: [
        { id: 'user_local_1', email: 'a@b.com', auth0Sub: null, name: 'A', role: 'USER' },
        { id: 'user_other', email: 'c@d.com', auth0Sub: null, name: 'C', role: 'USER' },
      ],
      jobs: [
        { id: 'job_local_queued', ownerId: 'user_local_1', status: 'QUEUED' },
        { id: 'job_other_queued', ownerId: 'user_other', status: 'QUEUED' },
      ],
    });
    const repository = new ExtractionsRepository(prisma);

    const cancelled = await repository.requestCancellation(localActor, 'job_local_queued');
    const blocked = await repository.requestCancellation(localActor, 'job_other_queued');

    expect(cancelled?.status).toBe('CANCEL_REQUESTED');
    expect(blocked).toBeNull();
    expect(state.jobs.find((job) => job.id === 'job_local_queued')?.status).toBe(
      'CANCEL_REQUESTED',
    );
    expect(state.jobs.find((job) => job.id === 'job_other_queued')?.status).toBe('QUEUED');
  });

  it('createOrGet does not rewrite an existing local user role from token claims', async () => {
    const { prisma, state } = createFakePrisma({
      users: [{ id: 'user_local_1', email: 'a@b.com', auth0Sub: null, name: 'A', role: 'USER' }],
    });
    const repository = new ExtractionsRepository(prisma);

    await repository.createOrGet({
      actor: { sub: 'user_local_1', email: 'a@b.com', roles: ['admin'] },
      command: { url: 'https://example.com' },
      normalizedUrl: 'https://example.com/',
      idempotencyKey: 'k1',
    });

    expect(state.users).toHaveLength(1);
    expect(state.users[0]!.role).toBe('USER');
  });
});
