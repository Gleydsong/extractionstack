import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const prismaRoot = join(process.cwd(), 'prisma');

describe('credit settlement persistence invariants', () => {
  it('enforces one typed settlement per reservation in Prisma and PostgreSQL', () => {
    const schema = readFileSync(join(prismaRoot, 'schema.prisma'), 'utf8');
    const migration = readFileSync(
      join(prismaRoot, 'migrations/20260717020000_add_credit_settlement/migration.sql'),
      'utf8',
    );

    const model = schema.match(/model CreditLedgerEntry \{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(model).toMatch(/reservationId\s+String\?\s+@unique/);
    expect(model).toContain('@relation("CreditSettlement"');
    expect(migration).toContain('"CreditLedgerEntry_reservationId_key"');
    expect(migration).toContain('"CreditLedgerEntry_settlement_kind_check"');
    expect(migration).toContain('"CreditLedgerEntry_settlement_scope_check"');
    expect(migration).toContain('CREATE CONSTRAINT TRIGGER');
    expect(migration).toContain('FOREIGN KEY ("reservationId")');
  });
});
