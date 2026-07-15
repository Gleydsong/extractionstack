import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { ExtractionsRepository } from './extractions.repository.js';

describe('ExtractionsRepository ownership query', () => {
  it('keeps a malicious identifier as an exact query value', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { extractionJob: { findFirst } } as unknown as PrismaClient;
    const repository = new ExtractionsRepository(prisma);
    const maliciousId = "x' OR 1=1 --";

    await repository.findOwned(
      { sub: 'auth0|user-1', roles: ['user'] },
      maliciousId,
    );

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: maliciousId, owner: { auth0Sub: 'auth0|user-1' } },
      include: { report: true },
    });
  });

  it('allows an administrator query without an owner predicate', async () => {
    const findFirst = vi.fn().mockResolvedValue(null);
    const prisma = { extractionJob: { findFirst } } as unknown as PrismaClient;
    const repository = new ExtractionsRepository(prisma);

    await repository.findOwned({ sub: 'auth0|admin', roles: ['admin'] }, 'cm1234567890');

    expect(findFirst).toHaveBeenCalledWith({
      where: { id: 'cm1234567890' },
      include: { report: true },
    });
  });
});
