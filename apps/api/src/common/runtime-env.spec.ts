import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { loadRuntimeEnv } from './runtime-env.js';

const validMasterKey = Buffer.alloc(32, 7).toString('base64');

const productionBase = {
  NODE_ENV: 'production',
  LLM_PROVIDER_MODE: 'live',
  AUTH0_DOMAIN: 'tenant.eu.auth0.com',
  AUTH0_AUDIENCE: 'https://api.extractionstack.example',
  CORS_ORIGIN: 'https://app.extractionstack.example',
  DATABASE_URL: 'postgresql://app:secret@postgres:5432/extractionstack',
  REDIS_URL: 'redis://redis:6379',
  LLM_CREDENTIAL_MASTER_KEY: validMasterKey,
  LLM_CREDENTIAL_KEY_VERSION: 'production-v1',
  LLM_RATE_LIMIT_HMAC_KEY: 'production-rate-limit-key-with-32-bytes',
  LLM_OPENAI_BASE_URL: 'https://api.openai.com/v1',
  LLM_GEMINI_BASE_URL: 'https://generativelanguage.googleapis.com/v1beta',
  LLM_OPENAI_MODEL_ALLOWLIST: 'gpt-5-mini,gpt-5',
  LLM_GEMINI_MODEL_ALLOWLIST: 'gemini-2.5-flash,gemini-2.5-pro',
  LLM_TIMEOUT_MS: '30000',
  LLM_MAX_INPUT_TOKENS: '32000',
  LLM_MAX_OUTPUT_TOKENS: '4096',
  LLM_MAX_COST_MINOR_UNITS: '500',
  LLM_PRICING_VERSION: 'production-2026-07-17',
  LLM_PRICING_CATALOG_JSON: JSON.stringify([{ provider: 'OPENAI', model: 'gpt-5-mini' }]),
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
    expect(env.API_TRUST_PROXY).toBe('false');
    expect(env.LLM_PROVIDER_MODE).toBe('fake');
  });

  it.each([
    { ...productionBase, AUTH_DEV_MODE: 'true' },
    { ...productionBase, CORS_ORIGIN: '*' },
    { ...productionBase, AUTH0_DOMAIN: 'your-tenant.us.auth0.com' },
    { ...productionBase, WORKER_CONCURRENCY: '0' },
    { ...productionBase, LLM_PRICING_VERSION: 'unconfigured-v1', LLM_PRICING_CATALOG_JSON: '[]' },
  ])('rejects an unsafe production environment', (input) => {
    expect(() => loadRuntimeEnv(input)).toThrow();
  });

  it('accepts a complete production environment', () => {
    expect(loadRuntimeEnv(productionBase).NODE_ENV).toBe('production');
  });

  it('keeps operational secrets accessible but absent from serialization and enumeration', () => {
    const env = loadRuntimeEnv(productionBase);

    expect(env.LLM_CREDENTIAL_MASTER_KEY).toBe(validMasterKey);
    expect(JSON.stringify(env)).not.toContain(validMasterKey);
    expect(JSON.stringify({ ...env })).not.toContain(validMasterKey);
    expect(Object.keys(env)).not.toContain('LLM_CREDENTIAL_MASTER_KEY');
    expect(Object.values(env)).not.toContain(validMasterKey);
    expect(inspect(env)).not.toContain(validMasterKey);
    expect(env.LLM_RATE_LIMIT_HMAC_KEY).toBe('production-rate-limit-key-with-32-bytes');
    expect(JSON.stringify(env)).not.toContain('production-rate-limit-key-with-32-bytes');
    expect(Object.keys(env)).not.toContain('LLM_RATE_LIMIT_HMAC_KEY');
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

  it('rejects an oversized master key without echoing it in validation errors', () => {
    const oversized = `${'A'.repeat(100_000)}oversized-secret-marker`;
    let failure: unknown;

    try {
      loadRuntimeEnv({ ...productionBase, LLM_CREDENTIAL_MASTER_KEY: oversized });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeDefined();
    expect(String(failure)).not.toContain('oversized-secret-marker');
    expect(JSON.stringify(failure)).not.toContain('oversized-secret-marker');
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

  it('allows only bounded private proxy CIDRs or safe hop presets', () => {
    expect(loadRuntimeEnv({ API_TRUST_PROXY: '10.0.0.0/8, fd00::/8' }).API_TRUST_PROXY).toBe(
      '10.0.0.0/8, fd00::/8',
    );
    expect(loadRuntimeEnv({ API_TRUST_PROXY: '1' }).API_TRUST_PROXY).toBe('1');
    expect(() => loadRuntimeEnv({ API_TRUST_PROXY: '198.51.100.0/24' })).toThrow();
  });

  it.each([
    { LLM_OPENAI_BASE_URL: 'http://api.openai.invalid/v1' },
    { LLM_GEMINI_BASE_URL: 'not-a-url' },
    { LLM_OPENAI_MODEL_ALLOWLIST: '' },
    { LLM_TIMEOUT_MS: '999' },
    { LLM_MAX_INPUT_TOKENS: '0' },
    { LLM_MAX_OUTPUT_TOKENS: '1000001' },
    { LLM_MAX_COST_MINOR_UNITS: '-1' },
    { LLM_PRICING_CATALOG_JSON: ' '.repeat(65_537) },
    { LLM_RATE_LIMIT_HMAC_KEY: 'short' },
    { API_TRUST_PROXY: '3' },
    { API_TRUST_PROXY: '0.0.0.0/0' },
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
