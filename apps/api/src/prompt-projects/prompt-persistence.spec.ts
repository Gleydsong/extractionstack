import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

describe('prompt persistence schema', () => {
  const schema = readFileSync(path.resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const normalizedSchema = schema.replace(/\s+/g, ' ');

  it('keeps prompt versions immutable and ledger entries append-only by shape', () => {
    expect(normalizedSchema).toContain('model PromptVersion');
    expect(normalizedSchema).toContain('@@unique([projectId, sequence])');
    expect(normalizedSchema).toContain('model CreditLedgerEntry');
    expect(normalizedSchema).toContain('idempotencyKey String @unique');
  });
});
