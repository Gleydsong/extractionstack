DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "PromptGenerationJob"
    WHERE "id" = 'upgrade-succeeded'
      AND "status" = 'SUCCEEDED'
      AND "providerStage" = 'COMPLETED'
      AND "providerStartedAt" IS NOT NULL
      AND "providerCompletedAt" IS NOT NULL
      AND "providerSnapshot"->>'schemaVersion' = '0'
      AND "providerSnapshot"->>'legacy' = 'true'
  ) THEN
    RAISE EXCEPTION 'legacy succeeded job was not backfilled safely';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "PromptGenerationJob"
    WHERE "id" = 'upgrade-ambiguous-completed'
      AND "providerStage" = 'COMPLETED'
      AND "providerSnapshot"->>'schemaVersion' = '0'
  ) THEN
    RAISE EXCEPTION 'legacy completed ambiguous job was not backfilled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "PromptGenerationJob"
    WHERE "id" = 'upgrade-ambiguous-started'
      AND "providerStage" = 'STARTED'
      AND "providerStartedAt" IS NOT NULL
      AND "providerCompletedAt" IS NULL
      AND "providerSnapshot" IS NULL
  ) THEN
    RAISE EXCEPTION 'legacy started ambiguous job was not backfilled';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "CreditLedgerEntry"
    WHERE "id" = 'upgrade-standalone-adjustment'
      AND "kind" = 'ADJUSTMENT'
      AND "reservationId" IS NULL
  ) THEN
    RAISE EXCEPTION 'historical standalone adjustment was rejected';
  END IF;
END $$;
