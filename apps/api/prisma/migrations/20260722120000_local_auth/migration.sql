-- Add local auth + Google OAuth support

-- Make auth0Sub optional (was required for Auth0-only flow)
ALTER TABLE "User" ALTER COLUMN "auth0Sub" DROP NOT NULL;

-- Make email required (was nullable)
UPDATE "User" SET "email" = COALESCE("auth0Sub", 'legacy-' || "id" || '@unknown.local') WHERE "email" IS NULL;
ALTER TABLE "User" ALTER COLUMN "email" SET NOT NULL;

-- Add new columns
ALTER TABLE "User" ADD COLUMN "googleSub" TEXT;
ALTER TABLE "User" ADD COLUMN "passwordHash" TEXT;
ALTER TABLE "User" ADD COLUMN "emailVerified" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "User" ADD COLUMN "picture" VARCHAR(2048);

-- Unique index on googleSub (partial, only when present)
CREATE UNIQUE INDEX "User_googleSub_key" ON "User"("googleSub") WHERE "googleSub" IS NOT NULL;
