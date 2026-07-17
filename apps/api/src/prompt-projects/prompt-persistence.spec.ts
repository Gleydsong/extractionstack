import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const prismaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
const migrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260716120000_add_llm_prompt_generation/migration.sql',
);
const schema = readFileSync(prismaPath, 'utf8');
const migration = readFileSync(migrationPath, 'utf8');
const taskNineMigrationPath = path.resolve(
  __dirname,
  '../../prisma/migrations/20260717040000_enforce_prompt_version_invariants/migration.sql',
);

function modelBlock(name: string): string {
  const match = schema.match(new RegExp(`model ${name} \\{([\\s\\S]*?)\\n\\}`));
  expect(match, `missing Prisma model ${name}`).not.toBeNull();
  return match?.[1] ?? '';
}

function tableBlock(name: string): string {
  const match = migration.match(new RegExp(`CREATE TABLE "${name}" \\(([\\s\\S]*?)\\n\\);`));
  expect(match, `missing migration table ${name}`).not.toBeNull();
  return (match?.[1] ?? '').replace(/\s+/g, ' ');
}

describe('prompt persistence schema', () => {
  it('keeps prompt versions immutable by shape and relation policy', () => {
    const version = modelBlock('PromptVersion');

    expect(version).toContain('@@unique([projectId, sequence])');
    expect(version).toMatch(
      /project\s+PromptProject\s+@relation\("ProjectPromptVersions",[^\n]*onDelete: Cascade\)/,
    );
    expect(version).toMatch(
      /sourceVersion\s+PromptVersion\?\s+@relation\("PromptVersionAdaptations",[^\n]*onDelete: Restrict\)/,
    );
    expect(version).not.toMatch(/^\s*(updatedAt|deletedAt)\s/m);
  });

  it('keeps credit entries append-only by shape and preserves financial history', () => {
    const ledger = modelBlock('CreditLedgerEntry');

    expect(ledger.replace(/\s+/g, ' ')).toContain('idempotencyKey String @unique');
    expect(ledger).toMatch(/owner\s+User\s+@relation\([^\n]*onDelete: Restrict\)/);
    expect(ledger).toMatch(/job\s+PromptGenerationJob\?\s+@relation\([^\n]*onDelete: Restrict\)/);
    expect(ledger).not.toMatch(/^\s*(updatedAt|deletedAt)\s/m);
  });

  it('enforces bounded signed balance deltas for every ledger kind', () => {
    const ledger = tableBlock('CreditLedgerEntry');

    expect(ledger).toContain('CONSTRAINT "CreditLedgerEntry_amount_bounds_check" CHECK');
    expect(ledger).toContain('"amountMinor" >= -1000000000000');
    expect(ledger).toContain('"amountMinor" <= 1000000000000');
    expect(ledger).toContain('CONSTRAINT "CreditLedgerEntry_kind_sign_check" CHECK');
    expect(ledger).toContain(
      "\"kind\" IN ('GRANT', 'PURCHASE', 'REVERSAL') AND \"amountMinor\" > 0",
    );
    expect(ledger).toContain('"kind" = \'RESERVATION\' AND "amountMinor" < 0');
    expect(ledger).toContain('"kind" = \'CONFIRMATION\'');
    expect(ledger).toContain('"kind" = \'ADJUSTMENT\' AND "amountMinor" <> 0');
  });

  it.each(['AiConnection', 'PromptGenerationJob', 'LlmUsage'])(
    'enforces provider credential compatibility on %s',
    (name) => {
      const table = tableBlock(name);

      expect(table).toContain(`CONSTRAINT "${name}_provider_credential_check" CHECK`);
      expect(table).toContain('"provider" = \'FAKE\' AND "credentialMode" = \'PLATFORM_CREDITS\'');
      expect(table).toContain(
        "\"provider\" = 'OPENAI' AND \"credentialMode\" IN ('API_KEY', 'PLATFORM_CREDITS')",
      );
      expect(table).toContain(
        "\"provider\" = 'GEMINI' AND \"credentialMode\" IN ('OAUTH', 'API_KEY', 'PLATFORM_CREDITS')",
      );
    },
  );

  it('enforces non-negative normalized usage counts in SQL', () => {
    const usage = tableBlock('LlmUsage');

    for (const field of ['inputTokens', 'outputTokens', 'cachedTokens', 'totalTokens']) {
      expect(usage).toContain(
        `CONSTRAINT "LlmUsage_${field}_check" CHECK ("${field}" IS NULL OR "${field}" >= 0)`,
      );
    }
  });

  it('contains required unique constraints for versions, credentials, jobs, usage, and ledger', () => {
    expect(schema).toContain('@@unique([projectId, sequence])');
    expect(schema).toContain('@@unique([connectionId, version])');
    expect(schema).toContain('@@unique([ownerId, idempotencyKey])');
    expect(modelBlock('LlmUsage')).toMatch(/jobId\s+String\s+@unique/);
    expect(modelBlock('CreditLedgerEntry')).toMatch(/idempotencyKey\s+String\s+@unique/);
  });

  it('never defines plaintext credential or OAuth token columns', () => {
    const forbiddenColumn =
      /^(apiKey|accessToken|refreshToken|oauthToken|clientSecret|plaintextCredential|credentialValue|secret|token)$/i;
    const prismaFields = [...schema.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]*)\s+[A-Za-z]/gm)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name));
    const sqlColumns = [...migration.matchAll(/^\s+"([A-Za-z][A-Za-z0-9]*)"\s+[A-Z]/gm)]
      .map((match) => match[1])
      .filter((name): name is string => Boolean(name));

    expect([...prismaFields, ...sqlColumns].filter((name) => forbiddenColumn.test(name))).toEqual(
      [],
    );
  });

  it('enforces prompt version immutability and same-project references in PostgreSQL', () => {
    const taskNineMigration = readFileSync(taskNineMigrationPath, 'utf8');
    expect(taskNineMigration).toContain('PromptVersion_append_only_check');
    expect(taskNineMigration).toContain('BEFORE UPDATE OR DELETE ON "PromptVersion"');
    expect(taskNineMigration).toContain('PromptProject_current_version_scope_check');
    expect(taskNineMigration).toContain('PromptVersion_source_scope_check');
    expect(taskNineMigration).toContain('PromptGenerationJob_source_scope_check');
  });

  it('stores only bounded internal job metadata needed by the worker', () => {
    expect(modelBlock('PromptGenerationJob')).toMatch(/requestMetadata\s+Json/);
  });
});
