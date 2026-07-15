CREATE TYPE "UserRole" AS ENUM ('USER', 'ADMIN');
CREATE TYPE "ExtractionStatus" AS ENUM (
  'QUEUED',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCEL_REQUESTED',
  'CANCELLED'
);

ALTER TABLE "User"
  ALTER COLUMN "role" DROP DEFAULT,
  ALTER COLUMN "role" TYPE "UserRole"
    USING (CASE WHEN lower("role") = 'admin' THEN 'ADMIN'::"UserRole" ELSE 'USER'::"UserRole" END),
  ALTER COLUMN "role" SET DEFAULT 'USER';

CREATE TABLE "ExtractionJob" (
  "id" TEXT NOT NULL,
  "ownerId" TEXT NOT NULL,
  "requestedUrl" VARCHAR(2048) NOT NULL,
  "normalizedUrl" VARCHAR(2048) NOT NULL,
  "idempotencyKey" VARCHAR(128) NOT NULL,
  "status" "ExtractionStatus" NOT NULL DEFAULT 'QUEUED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "maxAttempts" INTEGER NOT NULL DEFAULT 3,
  "errorCode" VARCHAR(64),
  "errorMessage" VARCHAR(512),
  "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "startedAt" TIMESTAMP(3),
  "finishedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ExtractionReport" (
  "id" TEXT NOT NULL,
  "jobId" TEXT NOT NULL,
  "schemaVersion" INTEGER NOT NULL DEFAULT 1,
  "finalUrl" VARCHAR(2048) NOT NULL,
  "fetchedAt" TIMESTAMP(3) NOT NULL,
  "durationMs" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ExtractionReport_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AuditEvent" (
  "id" TEXT NOT NULL,
  "actorId" TEXT NOT NULL,
  "action" VARCHAR(64) NOT NULL,
  "entityType" VARCHAR(64) NOT NULL,
  "entityId" VARCHAR(64) NOT NULL,
  "requestId" VARCHAR(64),
  "ipHash" VARCHAR(128),
  "metadata" JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExtractionJob_ownerId_idempotencyKey_key"
  ON "ExtractionJob"("ownerId", "idempotencyKey");
CREATE INDEX "ExtractionJob_ownerId_createdAt_idx" ON "ExtractionJob"("ownerId", "createdAt");
CREATE INDEX "ExtractionJob_status_idx" ON "ExtractionJob"("status");
CREATE UNIQUE INDEX "ExtractionReport_jobId_key" ON "ExtractionReport"("jobId");
CREATE INDEX "AuditEvent_actorId_createdAt_idx" ON "AuditEvent"("actorId", "createdAt");
CREATE INDEX "AuditEvent_entityType_entityId_idx" ON "AuditEvent"("entityType", "entityId");

ALTER TABLE "ExtractionJob"
  ADD CONSTRAINT "ExtractionJob_ownerId_fkey"
  FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ExtractionReport"
  ADD CONSTRAINT "ExtractionReport_jobId_fkey"
  FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AuditEvent"
  ADD CONSTRAINT "AuditEvent_actorId_fkey"
  FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
