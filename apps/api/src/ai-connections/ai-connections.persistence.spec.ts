import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('AI connection durable mutation idempotency schema', () => {
  it('defines an owner-scoped durable idempotency record and migration', () => {
    const root = join(__dirname, '../..');
    const schema = readFileSync(join(root, 'prisma/schema.prisma'), 'utf8');
    const migration = readFileSync(
      join(root, 'prisma/migrations/20260717010000_add_mutation_idempotency/migration.sql'),
      'utf8',
    );

    expect(schema).toContain('model MutationIdempotency');
    expect(schema).toContain('@@unique([ownerId, operation, keyHash])');
    expect(migration).toContain('CREATE TABLE "MutationIdempotency"');
    expect(migration).toContain('UNIQUE');
  });
});
