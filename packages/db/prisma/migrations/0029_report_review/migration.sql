-- Report review and evidence kinds (D-478).
--
-- Additive only (docs/MIGRATIONS.md): columns with defaults, or nullable.
--
-- A report version now has a review state. Every existing and every new report starts as a draft;
-- an administrator marks it reviewed, which records who (their name as it was, so the line on an
-- export does not change when they rename themselves or leave) and when. There is no foreign key to
-- "User": the name is a snapshot for the printed line, and the audit log keeps the user id.
ALTER TABLE "Report" ADD COLUMN "reviewStatus" TEXT NOT NULL DEFAULT 'draft';
ALTER TABLE "Report" ADD COLUMN "reviewedById" TEXT;
ALTER TABLE "Report" ADD COLUMN "reviewedByName" TEXT;
ALTER TABLE "Report" ADD COLUMN "reviewedAt" TIMESTAMP(3);
ALTER TABLE "Report" ADD CONSTRAINT "Report_reviewStatus_check" CHECK ("reviewStatus" IN ('draft', 'reviewed'));

-- An evidence row says whether its text is a verbatim quote that was found in the transcript it
-- cites ('quote') or the fact in the analysis' own words ('paraphrase'). Rows written before the
-- check are 'unverified' and are not shown as quotes.
ALTER TABLE "OpportunityEvidence" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'unverified';
