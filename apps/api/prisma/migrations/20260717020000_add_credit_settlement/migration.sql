ALTER TABLE "CreditLedgerEntry"
  ADD COLUMN "reservationId" TEXT;

ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_settlement_kind_check" CHECK (
    (
      "kind" IN ('CONFIRMATION', 'REVERSAL')
      AND "reservationId" IS NOT NULL
      AND "reservationId" <> "id"
    ) OR (
      "kind" NOT IN ('CONFIRMATION', 'REVERSAL')
      AND "reservationId" IS NULL
    )
  );

CREATE UNIQUE INDEX "CreditLedgerEntry_reservationId_key"
  ON "CreditLedgerEntry"("reservationId");

ALTER TABLE "CreditLedgerEntry"
  ADD CONSTRAINT "CreditLedgerEntry_reservationId_fkey"
  FOREIGN KEY ("reservationId") REFERENCES "CreditLedgerEntry"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE FUNCTION "enforce_credit_settlement_scope"()
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
    WHERE "id" = NEW."reservationId";

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

CREATE CONSTRAINT TRIGGER "CreditLedgerEntry_settlement_scope_check"
AFTER INSERT OR UPDATE ON "CreditLedgerEntry"
DEFERRABLE INITIALLY IMMEDIATE
FOR EACH ROW
EXECUTE FUNCTION "enforce_credit_settlement_scope"();
