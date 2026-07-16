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
      cause?: unknown;
    }> = {},
  ) {
    super(code, { cause: options.cause });
    this.name = 'ProviderFailure';
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.providerRequestId = options.providerRequestId ?? null;
  }
}
