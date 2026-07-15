import { describe, expect, it } from 'vitest';
import { assertSafeRuntimeEnv } from './env-guard.js';

describe('assertSafeRuntimeEnv', () => {
  it('allows dev mode outside production', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDevMode = process.env.AUTH_DEV_MODE;
    process.env.NODE_ENV = 'development';
    process.env.AUTH_DEV_MODE = 'true';
    expect(() => assertSafeRuntimeEnv()).not.toThrow();
    process.env.NODE_ENV = prevNodeEnv;
    process.env.AUTH_DEV_MODE = prevDevMode;
  });

  it('rejects dev mode in production', () => {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevDevMode = process.env.AUTH_DEV_MODE;
    process.env.NODE_ENV = 'production';
    process.env.AUTH_DEV_MODE = 'true';
    expect(() => assertSafeRuntimeEnv()).toThrow(
      'AUTH_DEV_MODE must not be enabled when NODE_ENV=production',
    );
    process.env.NODE_ENV = prevNodeEnv;
    process.env.AUTH_DEV_MODE = prevDevMode;
  });
});
