CREATE TYPE "ProviderExecutionStage" AS ENUM ('NOT_STARTED', 'STARTED', 'COMPLETED');

ALTER TABLE "PromptGenerationJob"
  ADD COLUMN "providerStage" "ProviderExecutionStage" NOT NULL DEFAULT 'NOT_STARTED',
  ADD COLUMN "providerStartedAt" TIMESTAMP(3),
  ADD COLUMN "providerSnapshot" JSONB,
  ADD COLUMN "reconciliationReason" VARCHAR(500),
  ADD COLUMN "reconciledAt" TIMESTAMP(3);

CREATE INDEX "PromptGenerationJob_providerStage_heartbeatAt_idx"
  ON "PromptGenerationJob"("providerStage", "heartbeatAt");

ALTER TABLE "CreditLedgerEntry"
  DROP CONSTRAINT "CreditLedgerEntry_settlement_kind_check",
  ADD CONSTRAINT "CreditLedgerEntry_settlement_kind_check" CHECK (
    (
      "kind" IN ('CONFIRMATION', 'REVERSAL', 'ADJUSTMENT')
      AND "reservationId" IS NOT NULL
      AND "reservationId" <> "id"
    ) OR (
      "kind" NOT IN ('CONFIRMATION', 'REVERSAL', 'ADJUSTMENT')
      AND "reservationId" IS NULL
    )
  );
