ALTER TYPE "PromptJobStatus" ADD VALUE IF NOT EXISTS 'AMBIGUOUS';

ALTER TABLE "PromptGenerationJob"
  ADD COLUMN "leaseToken" UUID,
  ADD COLUMN "heartbeatAt" TIMESTAMP(3),
  ADD COLUMN "providerCompletedAt" TIMESTAMP(3),
  ADD COLUMN "providerRequestId" VARCHAR(160);

CREATE INDEX "PromptGenerationJob_leaseToken_idx" ON "PromptGenerationJob"("leaseToken");
CREATE INDEX "PromptGenerationJob_heartbeatAt_idx" ON "PromptGenerationJob"("heartbeatAt");

ALTER TABLE "AiConnection"
  ADD COLUMN "refreshLeaseToken" UUID,
  ADD COLUMN "refreshLeaseExpiresAt" TIMESTAMP(3);

CREATE INDEX "AiConnection_refreshLeaseExpiresAt_idx" ON "AiConnection"("refreshLeaseExpiresAt");
