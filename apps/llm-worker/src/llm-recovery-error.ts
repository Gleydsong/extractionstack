export type RecoveryErrorDisposition = 'IDEMPOTENT' | 'TRANSIENT' | 'PERMANENT';

const PERMANENT_CODES = new Set([
  'CREDIT_COST_LIMIT_EXCEEDED',
  'CREDIT_STATE_INVALID',
  'PRICING_USAGE_INSUFFICIENT',
  'PROVIDER_SNAPSHOT_INVALID',
  'PROVIDER_SNAPSHOT_MISSING',
  'WORKER_RESULT_INVALID',
]);

export class PermanentRecoveryError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'PermanentRecoveryError';
  }
}

export function classifyRecoveryError(error: unknown): RecoveryErrorDisposition {
  const code = objectCode(error);
  if (code === 'P2002') return 'IDEMPOTENT';
  if (code === 'P2034') return 'TRANSIENT';
  if (code && PERMANENT_CODES.has(code)) return 'PERMANENT';
  if (error instanceof Error && PERMANENT_CODES.has(error.message)) return 'PERMANENT';
  if (error instanceof Error && error.name === 'ZodError') return 'PERMANENT';
  return 'TRANSIENT';
}

export function sanitizedRecoveryCode(error: unknown): string {
  const code = objectCode(error);
  if (code && PERMANENT_CODES.has(code)) return code;
  if (error instanceof Error && PERMANENT_CODES.has(error.message)) return error.message;
  return 'RECOVERY_COMPLETION_INVALID';
}

function objectCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
