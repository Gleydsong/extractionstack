import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadRuntimeEnv } from './runtime-env.js';

const validMasterKey = Buffer.alloc(32, 7).toString('base64');

const productionBase = {
  NODE_ENV: 'production',
  AUTH0_DOMAIN: 'tenant.eu.auth0.com',
  AUTH0_AUDIENCE: 'https://api.extractionstack.example',
  CORS_ORIGIN: 'https://app.extractionstack.example',
  DATABASE_URL: 'postgresql://app:secret@postgres:5432/extractionstack',
  REDIS_URL: 'redis://redis:6379',
  LLM_CREDENTIAL_MASTER_KEY: validMasterKey,
  LLM_CREDENTIAL_KEY_VERSION: 'production-v1',
  LLM_OPENAI_BASE_URL: 'https://api.openai.com/v1',
  LLM_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
  LLM_OPENAI_MODEL_ALLOWLIST: 'gpt-5-mini,gpt-5',
  LLM_GEMINI_MODEL_ALLOWLIST: 'gemini-2.5-flash,gemini-2.5-pro',
  LLM_TIMEOUT_MS: '30000',
  LLM_MAX_INPUT_TOKENS: '32000',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_MAX_COST_MINOR_UNITS: '500',
};

describe('loadRuntimeEnv', () => {
  it('parses bounded operational defaults', () => {
    const env = loadRuntimeEnv({ AUTH_DEV_MODE: 'true', VITE_AUTH_DEV_MODE: 'true' });

    expect(env.API_PORT).toBe(3001);
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.CRAWLER_TIMEOUT_MS).toBe(25_000);
    expect(env.AUTH_DEV_MODE).toBe(true);
    expect(env.LLM_TIMEOUT_MS).toBe(30_000);
    expect(env.LLM_OPENAI_MODEL_ALLOWLIST).toEqual(['gpt-5-mini']);
  });

  it.each([
    { ...productionBase, AUTH_DEV_MODE: 'true' },
    { ...productionBase, CORS_ORIGIN: '*' },
    { ...productionBase, AUTH0_DOMAIN: 'your-tenant.us.auth0.com' },
    { ...productionBase, WORKER_CONCURRENCY: '0' },
  ])('rejects an unsafe production environment', (input) => {
    expect(() => loadRuntimeEnv(input)).toThrow();
  });

  it('accepts a complete production environment', () => {
    expect(loadRuntimeEnv(productionBase).NODE_ENV).toBe('production');
  });

  it('keeps the master key accessible but absent from serialization and enumeration', () => {
    const env = loadRuntimeEnv(productionBase);

    expect(env.LLM_CREDENTIAL_MASTER_KEY).toBe(validMasterKey);
    expect(JSON.stringify(env)).not.toContain(validMasterKey);
    expect(JSON.stringify({ ...env })).not.toContain(validMasterKey);
    expect(Object.keys(env)).not.toContain('LLM_CREDENTIAL_MASTER_KEY');
    expect(Object.values(env)).not.toContain(validMasterKey);
    expect(inspect(env)).not.toContain(validMasterKey);
  });

  it('never includes a rejected master key in validation errors', () => {
    const rejectedSecret = `unsafe-secret-${'x'.repeat(80)}`;
    let failure: unknown;

    try {
      loadRuntimeEnv({ ...productionBase, LLM_CREDENTIAL_MASTER_KEY: rejectedSecret });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain(rejectedSecret);
    expect(JSON.stringify(failure)).not.toContain(rejectedSecret);
  });

  it.each([
    { LLM_CREDENTIAL_MASTER_KEY: '' },
    { LLM_CREDENTIAL_MASTER_KEY: Buffer.alloc(31).toString('base64') },
    { LLM_CREDENTIAL_MASTER_KEY: 'not-base64!' },
    { LLM_CREDENTIAL_KEY_VERSION: '' },
  ])('rejects missing or malformed credential encryption configuration in production', (patch) => {
    expect(() => loadRuntimeEnv({ ...productionBase, ...patch })).toThrow();
  });

  it('requires an explicit key version in production but defaults it outside production', () => {
    const withoutKeyVersion = Object.fromEntries(
      Object.entries(productionBase).filter(([key]) => key !== 'LLM_CREDENTIAL_KEY_VERSION'),
    );

    expect(() => loadRuntimeEnv(withoutKeyVersion)).toThrow();
    expect(loadRuntimeEnv({ NODE_ENV: 'development' }).LLM_CREDENTIAL_KEY_VERSION).toBe('local-v1');
  });

  it('normalizes configured model allowlists', () => {
    const env = loadRuntimeEnv({
      LLM_OPENAI_MODEL_ALLOWLIST: ' gpt-5-mini, gpt-5 ,gpt-5-mini ',
      LLM_GEMINI_MODEL_ALLOWLIST: 'gemini-2.5-flash',
    });

    expect(env.LLM_OPENAI_MODEL_ALLOWLIST).toEqual(['gpt-5-mini', 'gpt-5']);
    expect(env.LLM_GEMINI_MODEL_ALLOWLIST).toEqual(['gemini-2.5-flash']);
  });

  it.each([
    { LLM_OPENAI_BASE_URL: 'http://api.openai.invalid/v1' },
    { LLM_GEMINI_BASE_URL: 'not-a-url' },
    { LLM_OPENAI_MODEL_ALLOWLIST: '' },
    { LLM_TIMEOUT_MS: '999' },
    { LLM_MAX_INPUT_TOKENS: '0' },
    { LLM_MAX_OUTPUT_TOKENS: '1000001' },
    { LLM_MAX_COST_MINOR_UNITS: '-1' },
  ])('rejects unsafe LLM runtime configuration', (patch) => {
    expect(() => loadRuntimeEnv({ ...productionBase, ...patch })).toThrow();
  });

  it.each(['', ' ', '1e3', '0x10', '1.5', 'NaN', 'Infinity', '+1', '-0'])(
    'rejects a non-canonical LLM integer: %s',
    (invalidInteger) => {
      expect(() => loadRuntimeEnv({ ...productionBase, LLM_TIMEOUT_MS: invalidInteger })).toThrow();
      expect(() =>
        loadRuntimeEnv({ ...productionBase, LLM_MAX_COST_MINOR_UNITS: invalidInteger }),
      ).toThrow();
    },
  );
});
