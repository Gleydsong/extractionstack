CREATE TYPE "LlmProvider" AS ENUM ('FAKE', 'OPENAI', 'GEMINI');
CREATE TYPE "CredentialMode" AS ENUM ('OAUTH', 'API_KEY', 'PLATFORM_CREDITS');
CREATE TYPE "ConnectionState" AS ENUM ('PENDING', 'ACTIVE', 'EXPIRED', 'REVOKED', 'INVALID');
CREATE TYPE "PromptProjectState" AS ENUM ('ACTIVE', 'ARCHIVED');
CREATE TYPE "PromptVersionKind" AS ENUM ('UNIVERSAL', 'ADAPTED');
CREATE TYPE "PromptOperation" AS ENUM ('GENERATE', 'ADAPT', 'PREVIEW');
CREATE TYPE "PromptJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');
CREATE TYPE "PreviewStatus" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED');
CREATE TYPE "SecurityAction" AS ENUM ('ALLOW', 'REDACT', 'BLOCK');
CREATE TYPE "CreditLedgerKind" AS ENUM ('GRANT', 'PURCHASE', 'RESERVATION', 'CONFIRMATION', 'REVERSAL', 'ADJUSTMENT');

CREATE TABLE "AiConnection" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "provider" "LlmProvider" NOT NULL,
  "displayLabel" VARCHAR(120) NOT NULL,
  "credentialMode" "CredentialMode" NOT NULL,
  "state" "ConnectionState" NOT NULL DEFAULT 'PENDING',
  "maskedCredential" VARCHAR(32),
  "scopes" TEXT[],
  "expiresAt" TIMESTAMP(3),
  "validatedAt" TIMESTAMP(3),
  "lastUsedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AiConnection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProviderCredential" (
  "id" TEXT NOT NULL,
  "connectionId" TEXT NOT NULL,
  "version" INTEGER NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "encryptedDataKey" BYTEA NOT NULL,
  "algorithm" VARCHAR(32) NOT NULL,
  "keyVersion" VARCHAR(64) NOT NULL,
  "authenticatedMetadata" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "rotatedAt" TIMESTAMP(3),
  "deletedAt" TIMESTAMP(3),
  CONSTRAINT "ProviderCredential_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ProviderCredential_version_check" CHECK ("version" > 0)
);

CREATE TABLE "PromptProject" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "extractionId" TEXT NOT NULL,
  "title" VARCHAR(200) NOT NULL,
  "category" VARCHAR(32) NOT NULL,
  "language" VARCHAR(16) NOT NULL,
  "wizardInput" JSONB NOT NULL,
  "currentVersionId" TEXT,
  "state" "PromptProjectState" NOT NULL DEFAULT 'ACTIVE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromptProject_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "PromptVersion" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "sourceVersionId" TEXT,
  "kind" "PromptVersionKind" NOT NULL,
  "destination" VARCHAR(32) NOT NULL,
  "content" TEXT NOT NULL,
  "metadata" JSONB NOT NULL,
  "contentHash" VARCHAR(64) NOT NULL,
  "templateVersion" VARCHAR(32) NOT NULL,
  "reportSchemaVersion" INTEGER NOT NULL,
  "provider" "LlmProvider",
  "model" VARCHAR(128),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptVersion_sequence_check" CHECK ("sequence" > 0),
  CONSTRAINT "PromptVersion_reportSchemaVersion_check" CHECK ("reportSchemaVersion" > 0)
);

CREATE TABLE "PromptGenerationJob" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "operation" "PromptOperation" NOT NULL,
  "provider" "LlmProvider" NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "credentialMode" "CredentialMode" NOT NULL,
  "connectionId" TEXT,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "status" "PromptJobStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "sourcePromptVersionId" TEXT,
  "resultPromptVersionId" TEXT,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(1000),
  "retryable" BOOLEAN,
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PromptGenerationJob_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptGenerationJob_attempts_check" CHECK ("attempts" >= 0 AND "attempts" <= 10),
  CONSTRAINT "PromptGenerationJob_maxAttempts_check" CHECK ("maxAttempts" >= 1 AND "maxAttempts" <= 10),
  CONSTRAINT "PromptGenerationJob_attempt_bounds_check" CHECK ("attempts" <= "maxAttempts")
);

CREATE TABLE "PromptPreview" (
  "id" TEXT NOT NULL,
  "promptVersionId" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "status" "PreviewStatus" NOT NULL DEFAULT 'QUEUED',
  "content" TEXT NOT NULL,
  "summary" VARCHAR(2000) NOT NULL,
  "provider" "LlmProvider" NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "finishReason" VARCHAR(160),
  "latencyMs" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "PromptPreview_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "PromptPreview_latencyMs_check" CHECK ("latencyMs" IS NULL OR ("latencyMs" >= 0 AND "latencyMs" <= 3600000))
);

CREATE TABLE "LlmUsage" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "provider" "LlmProvider" NOT NULL,
  "model" VARCHAR(128) NOT NULL,
  "credentialMode" "CredentialMode" NOT NULL,
  "inputTokens" INTEGER,
  "outputTokens" INTEGER,
  "cachedTokens" INTEGER,
  "totalTokens" INTEGER,
  "estimatedAmountMinor" BIGINT,
  "confirmedAmountMinor" BIGINT,
  "currency" VARCHAR(8),
  "pricingVersion" VARCHAR(64),
  "providerRequestId" VARCHAR(160),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "LlmUsage_inputTokens_check" CHECK ("inputTokens" IS NULL OR "inputTokens" >= 0),
  CONSTRAINT "LlmUsage_outputTokens_check" CHECK ("outputTokens" IS NULL OR "outputTokens" >= 0),
  CONSTRAINT "LlmUsage_cachedTokens_check" CHECK ("cachedTokens" IS NULL OR "cachedTokens" >= 0),
  CONSTRAINT "LlmUsage_totalTokens_check" CHECK ("totalTokens" IS NULL OR "totalTokens" >= 0),
  CONSTRAINT "LlmUsage_estimatedAmountMinor_check" CHECK ("estimatedAmountMinor" IS NULL OR "estimatedAmountMinor" >= 0),
  CONSTRAINT "LlmUsage_confirmedAmountMinor_check" CHECK ("confirmedAmountMinor" IS NULL OR "confirmedAmountMinor" >= 0)
);

CREATE TABLE "SecurityDecision" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "decisionType" VARCHAR(64) NOT NULL,
  "action" "SecurityAction" NOT NULL,
  "policyVersion" VARCHAR(32) NOT NULL,
  "reasonCode" VARCHAR(64) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SecurityDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CreditLedgerEntry" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "jobId" TEXT,
  "kind" "CreditLedgerKind" NOT NULL,
  "amountMinor" BIGINT NOT NULL,
  "currency" VARCHAR(8) NOT NULL,
  "idempotencyKey" VARCHAR(160) NOT NULL,
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CreditLedgerEntry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CreditLedgerEntry_amountMinor_check" CHECK ("amountMinor" > 0 AND "amountMinor" <= 1000000000000)
);

CREATE INDEX "AiConnection_ownerId_state_idx" ON "AiConnection"("ownerId", "state");
CREATE INDEX "AiConnection_provider_state_idx" ON "AiConnection"("provider", "state");
CREATE UNIQUE INDEX "AiConnection_ownerId_provider_displayLabel_key" ON "AiConnection"("ownerId", "provider", "displayLabel");
CREATE INDEX "ProviderCredential_connectionId_createdAt_idx" ON "ProviderCredential"("connectionId", "createdAt");
CREATE UNIQUE INDEX "ProviderCredential_connectionId_version_key" ON "ProviderCredential"("connectionId", "version");
CREATE INDEX "PromptProject_ownerId_createdAt_idx" ON "PromptProject"("ownerId", "createdAt");
CREATE INDEX "PromptProject_extractionId_idx" ON "PromptProject"("extractionId");
CREATE INDEX "PromptProject_state_idx" ON "PromptProject"("state");
CREATE INDEX "PromptVersion_projectId_createdAt_idx" ON "PromptVersion"("projectId", "createdAt");
CREATE INDEX "PromptVersion_sourceVersionId_idx" ON "PromptVersion"("sourceVersionId");
CREATE UNIQUE INDEX "PromptVersion_projectId_sequence_key" ON "PromptVersion"("projectId", "sequence");
CREATE INDEX "PromptGenerationJob_projectId_createdAt_idx" ON "PromptGenerationJob"("projectId", "createdAt");
CREATE INDEX "PromptGenerationJob_ownerId_status_idx" ON "PromptGenerationJob"("ownerId", "status");
CREATE INDEX "PromptGenerationJob_status_queuedAt_idx" ON "PromptGenerationJob"("status", "queuedAt");
CREATE INDEX "PromptGenerationJob_connectionId_idx" ON "PromptGenerationJob"("connectionId");
CREATE INDEX "PromptGenerationJob_sourcePromptVersionId_idx" ON "PromptGenerationJob"("sourcePromptVersionId");
CREATE INDEX "PromptGenerationJob_resultPromptVersionId_idx" ON "PromptGenerationJob"("resultPromptVersionId");
CREATE UNIQUE INDEX "PromptGenerationJob_ownerId_idempotencyKey_key" ON "PromptGenerationJob"("ownerId", "idempotencyKey");
CREATE INDEX "PromptPreview_promptVersionId_createdAt_idx" ON "PromptPreview"("promptVersionId", "createdAt");
CREATE INDEX "PromptPreview_status_idx" ON "PromptPreview"("status");
CREATE UNIQUE INDEX "PromptPreview_jobId_key" ON "PromptPreview"("jobId");
CREATE UNIQUE INDEX "LlmUsage_jobId_key" ON "LlmUsage"("jobId");
CREATE INDEX "LlmUsage_provider_createdAt_idx" ON "LlmUsage"("provider", "createdAt");
CREATE INDEX "LlmUsage_providerRequestId_idx" ON "LlmUsage"("providerRequestId");
CREATE INDEX "SecurityDecision_jobId_createdAt_idx" ON "SecurityDecision"("jobId", "createdAt");
CREATE INDEX "SecurityDecision_action_createdAt_idx" ON "SecurityDecision"("action", "createdAt");
CREATE UNIQUE INDEX "CreditLedgerEntry_idempotencyKey_key" ON "CreditLedgerEntry"("idempotencyKey");
CREATE INDEX "CreditLedgerEntry_ownerId_createdAt_idx" ON "CreditLedgerEntry"("ownerId", "createdAt");
CREATE INDEX "CreditLedgerEntry_jobId_idx" ON "CreditLedgerEntry"("jobId");

ALTER TABLE "AiConnection" ADD CONSTRAINT "AiConnection_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProviderCredential" ADD CONSTRAINT "ProviderCredential_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AiConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptProject" ADD CONSTRAINT "PromptProject_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptProject" ADD CONSTRAINT "PromptProject_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "ExtractionJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromptProject" ADD CONSTRAINT "PromptProject_currentVersionId_fkey" FOREIGN KEY ("currentVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PromptProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_sourceVersionId_fkey" FOREIGN KEY ("sourceVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromptGenerationJob" ADD CONSTRAINT "PromptGenerationJob_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptGenerationJob" ADD CONSTRAINT "PromptGenerationJob_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "PromptProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptGenerationJob" ADD CONSTRAINT "PromptGenerationJob_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "AiConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PromptGenerationJob" ADD CONSTRAINT "PromptGenerationJob_sourcePromptVersionId_fkey" FOREIGN KEY ("sourcePromptVersionId") REFERENCES "PromptVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "PromptGenerationJob" ADD CONSTRAINT "PromptGenerationJob_resultPromptVersionId_fkey" FOREIGN KEY ("resultPromptVersionId") REFERENCES "PromptVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "PromptPreview" ADD CONSTRAINT "PromptPreview_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "PromptPreview" ADD CONSTRAINT "PromptPreview_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PromptGenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LlmUsage" ADD CONSTRAINT "LlmUsage_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PromptGenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SecurityDecision" ADD CONSTRAINT "SecurityDecision_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PromptGenerationJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CreditLedgerEntry" ADD CONSTRAINT "CreditLedgerEntry_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "PromptGenerationJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
