export function assertSafeRuntimeEnv(): void {
  if (process.env.NODE_ENV === 'production' && process.env.AUTH_DEV_MODE === 'true') {
    throw new Error('AUTH_DEV_MODE must not be enabled when NODE_ENV=production');
  }
}
