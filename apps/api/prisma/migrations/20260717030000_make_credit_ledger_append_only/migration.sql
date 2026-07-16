CREATE FUNCTION "reject_credit_ledger_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'credit ledger entries are append-only'
    USING ERRCODE = '23514',
          CONSTRAINT = 'CreditLedgerEntry_append_only_check';
END;
$$;

CREATE TRIGGER "CreditLedgerEntry_append_only_check"
BEFORE UPDATE OR DELETE ON "CreditLedgerEntry"
FOR EACH ROW
EXECUTE FUNCTION "reject_credit_ledger_mutation"();

CREATE OR REPLACE FUNCTION "enforce_credit_settlement_scope"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_kind "CreditLedgerKind";
  target_owner_id TEXT;
  target_job_id TEXT;
  target_currency VARCHAR(8);
BEGIN
  IF NEW."reservationId" IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT "kind", "ownerId", "jobId", "currency"
    INTO target_kind, target_owner_id, target_job_id, target_currency
    FROM "CreditLedgerEntry"
    WHERE "id" = NEW."reservationId"
    FOR KEY SHARE;

  IF target_kind IS DISTINCT FROM 'RESERVATION'::"CreditLedgerKind"
    OR target_owner_id IS DISTINCT FROM NEW."ownerId"
    OR target_job_id IS DISTINCT FROM NEW."jobId"
    OR target_currency IS DISTINCT FROM NEW."currency"
  THEN
    RAISE EXCEPTION 'credit settlement target or scope is invalid'
      USING ERRCODE = '23514',
            CONSTRAINT = 'CreditLedgerEntry_settlement_scope_check';
  END IF;

  RETURN NEW;
END;
$$;
