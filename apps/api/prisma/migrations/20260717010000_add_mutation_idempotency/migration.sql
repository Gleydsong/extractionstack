CREATE TYPE "MutationIdempotencyStatus" AS ENUM ('PENDING', 'COMPLETE');

CREATE TABLE "MutationIdempotency" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "operation" VARCHAR(64) NOT NULL,
  "keyHash" CHAR(64) NOT NULL,
  "requestHash" CHAR(64) NOT NULL,
  "status" "MutationIdempotencyStatus" NOT NULL DEFAULT 'PENDING',
  "publicResult" JSONB,
  "entityId" VARCHAR(64),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "completedAt" TIMESTAMP(3),

  CONSTRAINT "MutationIdempotency_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "MutationIdempotency_ownerId_fkey"
    FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "MutationIdempotency_ownerId_operation_keyHash_key"
  ON "MutationIdempotency"("ownerId", "operation", "keyHash");
CREATE INDEX "MutationIdempotency_status_updatedAt_idx"
  ON "MutationIdempotency"("status", "updatedAt");
