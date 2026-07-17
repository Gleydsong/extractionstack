CREATE TYPE "ProviderExecutionStage" AS ENUM ('NOT_STARTED', 'STARTED', 'COMPLETED');

ALTER TABLE "PromptGenerationJob"
  ADD COLUMN "providerStage" "ProviderExecutionStage" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "providerStartedAt" TIMESTAMP(3),
  ADD COLUMN "providerSnapshot" JSONB,
  ADD COLUMN "reconciliationReason" VARCHAR(500),
  ADD COLUMN "reconciledAt" TIMESTAMP(3),
  ADD COLUMN "recoveryLeaseToken" UUID,
  ADD COLUMN "recoveryLeaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationActorId" TEXT,
  ADD COLUMN "reconciliationCommandId" TEXT;

UPDATE "PromptGenerationJob"
SET "providerStage" = 'COMPLETED'::"ProviderExecutionStage",
    "providerStartedAt" = COALESCE("startedAt", "finishedAt", "updatedAt"),
    "providerCompletedAt" = COALESCE("providerCompletedAt", "finishedAt", "updatedAt"),
    "providerSnapshot" = COALESCE(
      "providerSnapshot",
      '{"schemaVersion":0,"legacy":true}'::jsonb
    )
WHERE "providerCompletedAt" IS NOT NULL
   OR "status" = 'SUCCEEDED'::"PromptJobStatus";

UPDATE "PromptGenerationJob"
SET "status" = 'AMBIGUOUS'::"PromptJobStatus",
    "finishedAt" = COALESCE("finishedAt", "updatedAt"),
    "reconciliationReason" = 'legacy queued job had a completed provider marker'
WHERE "status" = 'QUEUED'::"PromptJobStatus"
  AND "providerStage" = 'COMPLETED'::"ProviderExecutionStage";

UPDATE "PromptGenerationJob"
SET "providerStage" = 'STARTED'::"ProviderExecutionStage",
    "providerStartedAt" = COALESCE("startedAt", "finishedAt", "updatedAt")
WHERE "status" = 'AMBIGUOUS'::"PromptJobStatus"
  AND "providerStage" = 'NOT_STARTED'::"ProviderExecutionStage";

CREATE INDEX "PromptGenerationJob_providerStage_heartbeatAt_idx"
  ON "PromptGenerationJob"("providerStage", "heartbeatAt");
CREATE INDEX "PromptGenerationJob_recoveryLeaseExpiresAt_idx"
  ON "PromptGenerationJob"("recoveryLeaseExpiresAt");
CREATE INDEX "PromptGenerationJob_reconciliationActorId_idx"
  ON "PromptGenerationJob"("reconciliationActorId");
CREATE UNIQUE INDEX "PromptGenerationJob_reconciliationCommandId_key"
  ON "PromptGenerationJob"("reconciliationCommandId");

ALTER TABLE "PromptGenerationJob"
  ADD CONSTRAINT "PromptGenerationJob_reconciliationActorId_fkey"
    FOREIGN KEY ("reconciliationActorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "PromptGenerationJob_reconciliationCommandId_fkey"
    FOREIGN KEY ("reconciliationCommandId") REFERENCES "MutationIdempotency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CreditLedgerEntry"
  DROP CONSTRAINT "CreditLedgerEntry_settlement_kind_check",
  ADD CONSTRAINT "CreditLedgerEntry_settlement_kind_check" CHECK (
    (
      "kind" IN ('CONFIRMATION', 'REVERSAL')
      AND "reservationId" IS NOT NULL
      AND "reservationId" <> "id"
    ) OR (
      "kind" = 'ADJUSTMENT'
      AND ("reservationId" IS NULL OR "reservationId" <> "id")
    ) OR (
      "kind" NOT IN ('CONFIRMATION', 'REVERSAL', 'ADJUSTMENT')
      AND "reservationId" IS NULL
    )
  );
