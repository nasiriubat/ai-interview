-- Row-level security for the nine tables that reached their tenant only through a parent
-- (FR-01, NFR-03, D-140), and the schema that the privacy items of Security M2 need (D-142).
--
-- Message, SessionEvent, Analysis, Opportunity, OpportunityEvidence, Report, Invitation,
-- CampaignEmailHash and EmailCode had no `companyId`. Migration 0008 enumerated the tables that
-- did, the preflight asked "which tables have a companyId and no policy", and so these nine were
-- invisible to both: a query that forgot to filter returned another tenant's transcript, and
-- nothing in the database objected.
--
-- Each table gets a denormalised `companyId` plus a composite foreign key to its parent's
-- (id, companyId). The composite key is the point: a child row cannot name a tenant other than its
-- parent's, so the column cannot drift from the truth it copies, and the policy is the same one
-- every other table already uses.
--
-- Safe on a database that already holds data. Every step is a backfill from the parent row, the
-- NOT NULL and the foreign keys come after it, and a row that cannot be placed (which only a
-- corrupted database has) makes the migration fail and roll back rather than guess a tenant.
-- Postgres runs the whole file in one transaction, so a failure leaves the schema untouched.
--
-- Run by the owner role. The owner bypasses the policies, which is what lets the backfill read
-- across tenants; nothing here runs as app_api.

-- ---------------------------------------------------------------------------------------------
-- 1. Columns, nullable for now.
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Message"             ADD COLUMN "companyId" TEXT;
ALTER TABLE "SessionEvent"        ADD COLUMN "companyId" TEXT;
ALTER TABLE "Analysis"            ADD COLUMN "companyId" TEXT;
ALTER TABLE "Opportunity"         ADD COLUMN "companyId" TEXT;
ALTER TABLE "OpportunityEvidence" ADD COLUMN "companyId" TEXT;
ALTER TABLE "Report"              ADD COLUMN "companyId" TEXT;
ALTER TABLE "Invitation"          ADD COLUMN "companyId" TEXT;
ALTER TABLE "CampaignEmailHash"   ADD COLUMN "companyId" TEXT;
ALTER TABLE "EmailCode"           ADD COLUMN "companyId" TEXT;

-- The sealed pointer and the keyed owner tag that replace the participant-to-hash join on
-- anonymous campaigns (D-142). Both are NULL on rows written before this migration; the application
-- fills them in when the person returns, and handles the old shape until then.
ALTER TABLE "CampaignEmailHash" ADD COLUMN "resumeSeal" TEXT;
ALTER TABLE "CampaignEmailHash" ADD COLUMN "ownerTag" TEXT;
CREATE INDEX "CampaignEmailHash_campaignId_ownerTag_idx" ON "CampaignEmailHash"("campaignId", "ownerTag");

-- ---------------------------------------------------------------------------------------------
-- 2. Backfill from the parent, top of the tree first. One statement per table: the tables are
--    large only for Message and SessionEvent, and a single UPDATE ... FROM over a primary-key join
--    is the cheapest correct form on a single self-hosted server. The statement is not split into
--    batches because the whole file is one transaction, so batching would add no durability.
-- ---------------------------------------------------------------------------------------------
UPDATE "Message" m
   SET "companyId" = s."companyId"
  FROM "Session" s
 WHERE s.id = m."sessionId" AND m."companyId" IS NULL;

UPDATE "SessionEvent" e
   SET "companyId" = s."companyId"
  FROM "Session" s
 WHERE s.id = e."sessionId" AND e."companyId" IS NULL;

UPDATE "Analysis" a
   SET "companyId" = c."companyId"
  FROM "Campaign" c
 WHERE c.id = a."campaignId" AND a."companyId" IS NULL;

UPDATE "Opportunity" o
   SET "companyId" = a."companyId"
  FROM "Analysis" a
 WHERE a.id = o."analysisId" AND o."companyId" IS NULL;

-- Evidence takes its tenant from the opportunity it supports. If the fact it cites belongs to
-- another tenant, the composite foreign key below refuses the migration, which is correct: such a
-- row is a cross-tenant leak that was already there.
UPDATE "OpportunityEvidence" e
   SET "companyId" = o."companyId"
  FROM "Opportunity" o
 WHERE o.id = e."opportunityId" AND e."companyId" IS NULL;

UPDATE "Report" r
   SET "companyId" = a."companyId"
  FROM "Analysis" a
 WHERE a.id = r."analysisId" AND r."companyId" IS NULL;

UPDATE "Invitation" i
   SET "companyId" = c."companyId"
  FROM "Campaign" c
 WHERE c.id = i."campaignId" AND i."companyId" IS NULL;

UPDATE "CampaignEmailHash" h
   SET "companyId" = c."companyId"
  FROM "Campaign" c
 WHERE c.id = h."campaignId" AND h."companyId" IS NULL;

-- EmailCode had no foreign key, so a code can outlive its campaign. A code names a campaign that no
-- longer exists and lives ten minutes at most; it has no tenant to give it and no use.
DELETE FROM "EmailCode" e
 WHERE NOT EXISTS (SELECT 1 FROM "Campaign" c WHERE c.id = e."campaignId");

UPDATE "EmailCode" e
   SET "companyId" = c."companyId"
  FROM "Campaign" c
 WHERE c.id = e."campaignId" AND e."companyId" IS NULL;

-- ---------------------------------------------------------------------------------------------
-- 3. Constraints. NOT NULL first, then the keys the composite foreign keys point at, then the
--    foreign keys themselves (replacing the single-column ones, with the same delete actions).
-- ---------------------------------------------------------------------------------------------
ALTER TABLE "Message"             ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "SessionEvent"        ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Analysis"            ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Opportunity"         ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "OpportunityEvidence" ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Report"              ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "Invitation"          ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "CampaignEmailHash"   ALTER COLUMN "companyId" SET NOT NULL;
ALTER TABLE "EmailCode"           ALTER COLUMN "companyId" SET NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "Session_id_companyId_key" ON "Session"("id", "companyId");
CREATE UNIQUE INDEX "Campaign_id_companyId_key" ON "Campaign"("id", "companyId");
CREATE UNIQUE INDEX "Fact_id_companyId_key" ON "Fact"("id", "companyId");
CREATE UNIQUE INDEX "Analysis_id_companyId_key" ON "Analysis"("id", "companyId");
CREATE UNIQUE INDEX "Opportunity_id_companyId_key" ON "Opportunity"("id", "companyId");
CREATE UNIQUE INDEX "Invitation_sessionId_companyId_key" ON "Invitation"("sessionId", "companyId");
CREATE INDEX "Invitation_companyId_idx" ON "Invitation"("companyId");

-- The single-column keys go; their composite replacements enforce the same parent and the tenant.
ALTER TABLE "Message"             DROP CONSTRAINT "Message_sessionId_fkey";
ALTER TABLE "SessionEvent"        DROP CONSTRAINT "SessionEvent_sessionId_fkey";
ALTER TABLE "Analysis"            DROP CONSTRAINT "Analysis_campaignId_fkey";
ALTER TABLE "Opportunity"         DROP CONSTRAINT "Opportunity_analysisId_fkey";
ALTER TABLE "OpportunityEvidence" DROP CONSTRAINT "OpportunityEvidence_opportunityId_fkey";
ALTER TABLE "OpportunityEvidence" DROP CONSTRAINT "OpportunityEvidence_factId_fkey";
ALTER TABLE "Report"              DROP CONSTRAINT "Report_analysisId_fkey";
ALTER TABLE "Invitation"          DROP CONSTRAINT "Invitation_campaignId_fkey";
ALTER TABLE "Invitation"          DROP CONSTRAINT "Invitation_sessionId_fkey";
ALTER TABLE "CampaignEmailHash"   DROP CONSTRAINT "CampaignEmailHash_campaignId_fkey";

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "Session"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "SessionEvent" ADD CONSTRAINT "SessionEvent_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "Session"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Analysis" ADD CONSTRAINT "Analysis_campaignId_companyId_fkey" FOREIGN KEY ("campaignId", "companyId") REFERENCES "Campaign"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Opportunity" ADD CONSTRAINT "Opportunity_analysisId_companyId_fkey" FOREIGN KEY ("analysisId", "companyId") REFERENCES "Analysis"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityEvidence" ADD CONSTRAINT "OpportunityEvidence_opportunityId_companyId_fkey" FOREIGN KEY ("opportunityId", "companyId") REFERENCES "Opportunity"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "OpportunityEvidence" ADD CONSTRAINT "OpportunityEvidence_factId_companyId_fkey" FOREIGN KEY ("factId", "companyId") REFERENCES "Fact"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Report" ADD CONSTRAINT "Report_analysisId_companyId_fkey" FOREIGN KEY ("analysisId", "companyId") REFERENCES "Analysis"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_campaignId_companyId_fkey" FOREIGN KEY ("campaignId", "companyId") REFERENCES "Campaign"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
-- Invitation.sessionId is nullable, so the composite key is not checked while it is NULL (MATCH SIMPLE).
-- RESTRICT rather than SET NULL: SET NULL would try to null companyId too. The application never
-- hard-deletes a session (deletion marks it `deleted`), so there is no path that needs the old action.
ALTER TABLE "Invitation" ADD CONSTRAINT "Invitation_sessionId_companyId_fkey" FOREIGN KEY ("sessionId", "companyId") REFERENCES "Session"("id", "companyId") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CampaignEmailHash" ADD CONSTRAINT "CampaignEmailHash_campaignId_companyId_fkey" FOREIGN KEY ("campaignId", "companyId") REFERENCES "Campaign"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "EmailCode" ADD CONSTRAINT "EmailCode_campaignId_companyId_fkey" FOREIGN KEY ("campaignId", "companyId") REFERENCES "Campaign"("id", "companyId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------------------------
-- 4. The policy, identical to 0008's: this tenant's rows, plus everything under 'system'.
--    Idempotent (DROP IF EXISTS), like every earlier policy migration.
-- ---------------------------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'Message', 'SessionEvent', 'Analysis', 'Opportunity', 'OpportunityEvidence',
    'Report', 'Invitation', 'CampaignEmailHash', 'EmailCode'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_api'
      ' USING ("companyId" IS NULL'
      '        OR "companyId" = current_setting(''app.company_id'', true)'
      '        OR current_setting(''app.company_id'', true) = ''system'')'
      ' WITH CHECK ("companyId" = current_setting(''app.company_id'', true)'
      '             OR current_setting(''app.company_id'', true) = ''system'')',
      t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_api', t);
  END LOOP;
END $$;
