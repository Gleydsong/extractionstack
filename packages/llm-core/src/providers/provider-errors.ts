import { z } from 'zod';

export const ProviderRequestIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .nullable();

export const PROVIDER_FAILURE_CODES = [
  'AUTHENTICATION_FAILED',
  'AUTHORIZATION_FAILED',
  'INPUT_INVALID',
  'INVALID_RESPONSE',
  'MODEL_UNAVAILABLE',
  'PROVIDER_NOT_CONFIGURED',
  'PROVIDER_UNAVAILABLE',
  'REQUEST_CANCELLED',
  'TIMEOUT',
] as const;

export type ProviderFailureCode = (typeof PROVIDER_FAILURE_CODES)[number];

export class ProviderFailure extends Error {
  readonly code: ProviderFailureCode;
  readonly retryable: boolean;
  readonly providerRequestId: string | null;

  constructor(
    code: ProviderFailureCode,
    options: Readonly<{
      retryable?: boolean;
      providerRequestId?: string | null;
    }> = {},
  ) {
    super(code);
    this.name = 'ProviderFailure';
    this.code = code;
    this.retryable = options.retryable ?? false;
    const providerRequestId = ProviderRequestIdSchema.safeParse(options.providerRequestId ?? null);
    this.providerRequestId = providerRequestId.success ? providerRequestId.data : null;
  }
}
