import { describe, expect, it } from 'vitest';
import { loadRuntimeEnv } from './runtime-env.js';

const productionBase = {
  NODE_ENV: 'production',
  AUTH0_DOMAIN: 'tenant.eu.auth0.com',
  AUTH0_AUDIENCE: 'https://api.extractionstack.example',
  CORS_ORIGIN: 'https://app.extractionstack.example',
  DATABASE_URL: 'postgresql://app:secret@postgres:5432/extractionstack',
  REDIS_URL: 'redis://redis:6379',
};

describe('loadRuntimeEnv', () => {
  it('parses bounded operational defaults', () => {
    const env = loadRuntimeEnv({ AUTH_DEV_MODE: 'true', VITE_AUTH_DEV_MODE: 'true' });

    expect(env.API_PORT).toBe(3001);
    expect(env.WORKER_CONCURRENCY).toBe(2);
    expect(env.CRAWLER_TIMEOUT_MS).toBe(25_000);
    expect(env.AUTH_DEV_MODE).toBe(true);
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
});
