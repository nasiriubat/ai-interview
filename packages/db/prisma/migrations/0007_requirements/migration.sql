-- Phase 3: requirements sessions (spec 05, contract 18).

-- AlterTable: requirements sessions carry a title, owner edits and external invitations.
ALTER TABLE "Session" ADD COLUMN     "title" TEXT NOT NULL DEFAULT '',
ADD COLUMN     "specEdits" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "invitations" JSONB NOT NULL DEFAULT '[]';

-- AlterTable: spec versions are tenant rows with a generation status.
ALTER TABLE "SpecVersion" ADD COLUMN     "companyId" TEXT,
ADD COLUMN     "label" TEXT,
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'done',
ADD COLUMN     "error" TEXT,
ADD COLUMN     "stats" JSONB NOT NULL DEFAULT '{}',
ADD COLUMN     "createdBy" TEXT,
ADD COLUMN     "finishedAt" TIMESTAMP(3);

UPDATE "SpecVersion" sv SET "companyId" = s."companyId" FROM "Session" s WHERE s."id" = sv."sessionId";
ALTER TABLE "SpecVersion" ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE INDEX "SpecVersion_companyId_idx" ON "SpecVersion"("companyId");

-- AlterTable: participants invited into a requirements session have no campaign.
ALTER TABLE "Participant" ALTER COLUMN "campaignId" DROP NOT NULL;

-- Row-level security for the new tenant table (see 0002_rls).
ALTER TABLE "SpecVersion" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON "SpecVersion";
CREATE POLICY tenant_isolation ON "SpecVersion" TO app_api
  USING ("companyId" = current_setting('app.company_id', true))
  WITH CHECK ("companyId" = current_setting('app.company_id', true));
