-- Staff lists search, sort and filter on the server (D-79, contract 19).
--
-- 1. Session.updatedAt is the "last activity" sort. Every turn rewrites `state`, so the last write
--    to the row is the last thing that happened in the session; Prisma keeps it current. Existing
--    rows get the best time the table already knows rather than the moment this migration ran,
--    which would make every old session look active today.
--
-- 2. Indexes for the new filters and sorts, each led by companyId because every staff query is
--    tenant-scoped (and RLS adds the same predicate). Search is plain ILIKE '%q%' over the
--    tenant's rows: within one tenant these tables hold thousands of rows, not millions, and a
--    companyId-led index narrows the scan to them. pg_trgm would make substring search indexable,
--    but it is an extension to install on every database and a GIN index to maintain on every
--    write, for a win that does not show at this scale. Revisit if one tenant's audit log reaches
--    the millions.
--
--    Session.updatedAt is deliberately not indexed: it changes on every turn, so an index on it
--    would be rewritten on the hottest write path in the system to speed up a sort over one
--    campaign's sessions, which (companyId, campaignId) already narrows to a few hundred rows.
--
-- No table is added, so no row-level-security policy changes (D-67).

-- AlterTable
ALTER TABLE "Session" ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Session" SET "updatedAt" = COALESCE("endedAt", "startedAt", "consentedAt", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_companyId_action_createdAt_idx" ON "AuditLog"("companyId", "action", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_companyId_createdAt_idx" ON "Campaign"("companyId", "createdAt");

-- CreateIndex
CREATE INDEX "Campaign_companyId_status_createdAt_idx" ON "Campaign"("companyId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "Session_companyId_campaignId_status_idx" ON "Session"("companyId", "campaignId", "status");
