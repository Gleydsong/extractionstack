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
  leaseToken: string;
}>;

export type AuthorizedLlmContext = Readonly<{
  job: ClaimedLlmJob;
  wizard: PromptWizardInput;
  report: InvestigationReport;
  sourcePrompt: PromptVersion | null;
  reservationId: string | null;
  maximumAcceptedAmountMinor: bigint | null;
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
  actualAmountMinor: bigint | null;
  pricingVersion: string | null;
}>;

export interface LlmJobStorePort {
  claim(jobId: string): Promise<ClaimedLlmJob | null>;
  loadAuthorizedContext(job: ClaimedLlmJob): Promise<AuthorizedLlmContext>;
  isCancellationRequested(job: ClaimedLlmJob): Promise<boolean>;
  heartbeat(job: ClaimedLlmJob): Promise<boolean>;
  markProviderStarted(job: ClaimedLlmJob): Promise<boolean>;
  markProviderCompleted(command: CompletionCommand): Promise<boolean>;
  complete(command: CompletionCommand): Promise<boolean>;
  markRetry(job: ClaimedLlmJob, errorCode: string): Promise<boolean>;
  fail(job: ClaimedLlmJob, errorCode: string): Promise<boolean>;
  deadLetter(job: ClaimedLlmJob, errorCode: string): Promise<boolean>;
  markAmbiguous(job: ClaimedLlmJob, errorCode: string): Promise<boolean>;
  cancel(job: ClaimedLlmJob): Promise<boolean>;
  reject(job: ClaimedLlmJob, reasonCode: string): Promise<boolean>;
}

export interface LlmReconciliationPort {
  reconcileKnownSnapshot(jobId: string, reason: string): Promise<boolean>;
  reconcileConfirmedNotRun(jobId: string, reason: string): Promise<boolean>;
  reconcileUnknownPaid(jobId: string, actualAmountMinor: bigint, reason: string): Promise<boolean>;
}

export interface ProviderAdapterRegistryPort {
  get(provider: LlmProvider): LlmProviderAdapter;
}
