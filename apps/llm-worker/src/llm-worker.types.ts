import type {
  CredentialMode,
  InvestigationReport,
  LlmProvider,
  PromptVersion,
  PromptWizardInput,
} from '@extractionstack/shared';
import type {
  LlmProviderAdapter,
  NormalizedGeneration,
  NormalizedPreview,
  SafetyReasonCode,
} from '@extractionstack/llm-core';

export const LLM_QUEUE_NAME = 'llm-generations-v1';

export type ClaimedLlmJob = Readonly<{
  id: string;
  ownerId: string;
  projectId: string;
  operation: 'GENERATE' | 'ADAPT' | 'PREVIEW';
  provider: LlmProvider;
  model: string;
  credentialMode: CredentialMode;
  connectionId: string | null;
  sourcePromptVersionId: string | null;
  attempts: number;
  maxAttempts: number;
}>;

export type AuthorizedLlmContext = Readonly<{
  job: ClaimedLlmJob;
  wizard: PromptWizardInput;
  report: InvestigationReport;
  sourcePrompt: PromptVersion | null;
  reservationId: string | null;
}>;

export type SecurityRecord = Readonly<{
  action: 'ALLOW' | 'REDACT' | 'BLOCK';
  reasonCodes: readonly SafetyReasonCode[];
}>;

export type CompletionCommand = Readonly<{
  job: ClaimedLlmJob;
  result: NormalizedGeneration | NormalizedPreview;
  security: SecurityRecord;
  latencyMs: number;
}>;

export interface LlmJobStorePort {
  claim(jobId: string): Promise<ClaimedLlmJob | null>;
  loadAuthorizedContext(job: ClaimedLlmJob): Promise<AuthorizedLlmContext>;
  isCancellationRequested(jobId: string): Promise<boolean>;
  complete(command: CompletionCommand): Promise<boolean>;
  markRetry(jobId: string, errorCode: string): Promise<void>;
  fail(jobId: string, errorCode: string): Promise<void>;
  deadLetter(jobId: string, errorCode: string): Promise<void>;
  cancel(jobId: string): Promise<void>;
  reject(jobId: string, reasonCode: string): Promise<void>;
}

export interface ProviderAdapterRegistryPort {
  get(provider: LlmProvider): LlmProviderAdapter;
}

export interface WorkerCreditsPort {
  confirm(reservationId: string, actualAmountMinor: bigint): Promise<void>;
  reverse(reservationId: string, reason: string): Promise<void>;
}
