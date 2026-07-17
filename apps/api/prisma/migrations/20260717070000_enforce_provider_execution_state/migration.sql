ALTER TABLE "PromptGenerationJob"
  ADD CONSTRAINT "PromptGenerationJob_provider_stage_shape_check" CHECK (
    (
      "providerStage" = 'NOT_STARTED'
      AND "providerStartedAt" IS NULL
      AND "providerCompletedAt" IS NULL
      AND "providerSnapshot" IS NULL
    ) OR (
      "providerStage" = 'STARTED'
      AND "providerStartedAt" IS NOT NULL
      AND "providerCompletedAt" IS NULL
      AND "providerSnapshot" IS NULL
    ) OR (
      "providerStage" = 'COMPLETED'
      AND "providerStartedAt" IS NOT NULL
      AND "providerCompletedAt" IS NOT NULL
      AND "providerSnapshot" IS NOT NULL
    )
  ),
  ADD CONSTRAINT "PromptGenerationJob_provider_status_compatibility_check" CHECK (
    ("status" = 'QUEUED' AND "providerStage" = 'NOT_STARTED')
    OR ("status" = 'SUCCEEDED' AND "providerStage" = 'COMPLETED')
    OR ("status" = 'AMBIGUOUS' AND "providerStage" IN ('STARTED', 'COMPLETED'))
    OR "status" IN ('RUNNING', 'FAILED', 'CANCEL_REQUESTED', 'CANCELLED')
  ),
  ADD CONSTRAINT "PromptGenerationJob_recovery_lease_shape_check" CHECK (
    ("recoveryLeaseToken" IS NULL AND "recoveryLeaseExpiresAt" IS NULL)
    OR ("recoveryLeaseToken" IS NOT NULL AND "recoveryLeaseExpiresAt" IS NOT NULL)
  ),
  ADD CONSTRAINT "PromptGenerationJob_reconciliation_link_shape_check" CHECK (
    ("reconciliationActorId" IS NULL AND "reconciliationCommandId" IS NULL)
    OR ("reconciliationActorId" IS NOT NULL AND "reconciliationCommandId" IS NOT NULL)
  );
