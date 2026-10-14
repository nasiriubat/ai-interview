-- Cluster edits that survive re-runs, and the columns the dashboard statistics need
-- (blueprint features 2 and 4, FR-18, spec 07; D-200, D-205).
--
-- Additive only (docs/MIGRATIONS.md): every column is nullable or defaulted and the one new table is
-- new, so the previous release keeps working against this schema.
--
-- 1. ClusterEdit: a merge or split, stored against fact ids. Revoked rather than deleted, so undo
--    is itself an edit and the history is complete.
-- 2. Analysis.clusters: every cluster of a run before edits, so an edit run can start from it
--    instead of embedding and naming again, and an undo can really undo. Analyses made before this
--    migration have none and are re-run before they can be edited ("rerun_required").
-- 3. Opportunity.factIds: all member facts, not only the twelve evidence rows.
-- 4. Invitation.reminderCount and lastRemindedAt: "reminders sent" cannot be derived from the
--    audit log, which is retained for less time than a campaign runs.
-- 5. Session.identified: whether the participant gave their identity. Backfilled from the campaign
--    mode where the mode decides it, and from the fields the participant gave where they chose.

CREATE TABLE "ClusterEdit" (
    "id"         TEXT NOT NULL,
    "companyId"  TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "op"         TEXT NOT NULL,
    "payload"    JSONB NOT NULL,
    "createdBy"  TEXT,
    "createdAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt"  TIMESTAMP(3),

    CONSTRAINT "ClusterEdit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClusterEdit_companyId_campaignId_revokedAt_idx"
  ON "ClusterEdit"("companyId", "campaignId", "revokedAt");

ALTER TABLE "ClusterEdit"
  ADD CONSTRAINT "ClusterEdit_campaignId_companyId_fkey"
  FOREIGN KEY ("campaignId", "companyId") REFERENCES "Campaign"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security, the policy every tenant-owned table carries (FR-01, NFR-03, D-57).
DO $$
BEGIN
  ALTER TABLE "ClusterEdit" ENABLE ROW LEVEL SECURITY;
  DROP POLICY IF EXISTS tenant_isolation ON "ClusterEdit";
  CREATE POLICY tenant_isolation ON "ClusterEdit" TO app_api
    USING ("companyId" IS NULL
           OR "companyId" = current_setting('app.company_id', true)
           OR current_setting('app.company_id', true) = 'system')
    WITH CHECK ("companyId" = current_setting('app.company_id', true)
                OR current_setting('app.company_id', true) = 'system');
  GRANT SELECT, INSERT, UPDATE, DELETE ON "ClusterEdit" TO app_api;
END $$;

ALTER TABLE "Analysis"    ADD COLUMN "clusters" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Opportunity" ADD COLUMN "factIds"  JSONB NOT NULL DEFAULT '[]';

ALTER TABLE "Invitation"
  ADD COLUMN "reminderCount"  INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastRemindedAt" TIMESTAMP(3);

ALTER TABLE "Session" ADD COLUMN "identified" BOOLEAN NOT NULL DEFAULT false;

-- Backfill (run by the owner role, which bypasses RLS).
UPDATE "Session" s
   SET "identified" = true
  FROM "Campaign" c
 WHERE s."campaignId" = c.id
   AND s."participantId" IS NOT NULL
   AND c."participationMode" = 'identified';

-- Where the participant chose, an anonymous answer keeps only role and department (consent()), so
-- any other field means they gave their identity.
UPDATE "Session" s
   SET "identified" = true
  FROM "Campaign" c, "Participant" p
 WHERE s."campaignId" = c.id
   AND p.id = s."participantId"
   AND c."participationMode" = 'participant_choice'
   AND EXISTS (
     SELECT 1 FROM jsonb_object_keys(p."fields") k WHERE k NOT IN ('role', 'department')
   );
