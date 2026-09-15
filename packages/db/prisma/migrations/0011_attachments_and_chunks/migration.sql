-- Phase 4: what an uploaded file and a voice recording need beyond the bytes (FR-30, FR-31, FR-32).
--
-- Three things happen here.
--
-- 1. Attachment learns that ingestion takes time and can fail. Extraction, image description and
--    chunking run as a job, so a row exists before its text does, and the participant is shown
--    "still reading that" or "could not read that" rather than an attachment that quietly never
--    becomes useful. durationMs and confidence are the audio columns: the first drives the player
--    and the per-second transcription cost, the second is one of the three voice signals the spec
--    asks to trace per turn.
--
-- 2. AttachmentChunk is the retrievable unit. The interview carries an attachment's summary in
--    context and recalls chunks on demand, so a forty-page PDF costs a summary per turn instead of
--    forty pages per turn. `embedding` is nullable on purpose: with no `embedding` route
--    configured — the common case on a provider that serves no embedding models — recall scores
--    the same chunk text lexically instead. The feature degrades; it does not disappear.
--
-- 3. A foreign key is corrected. Phase 3 made Participant.campaignId nullable so a requirements
--    invitation could mint a participant with no campaign (D-47), but the constraint from 0001 is
--    still ON DELETE RESTRICT. Deleting a campaign therefore fails on its own participants instead
--    of detaching them, which is the behaviour the nullable column was introduced to allow.

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "durationMs" INTEGER,
ADD COLUMN     "error" TEXT,
ADD COLUMN     "ingestedAt" TIMESTAMP(3),
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending';

-- Rows that predate this migration were never ingested, but they are also never going to be:
-- nothing wrote an Attachment before phase 4. Marking them ready keeps `pending` meaning
-- "a job is coming", so the admin view of stuck ingestions stays truthful.
UPDATE "Attachment" SET "status" = 'ready' WHERE "createdAt" < NOW();

-- CreateTable
CREATE TABLE "AttachmentChunk" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" vector(1536),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AttachmentChunk_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttachmentChunk_companyId_attachmentId_idx" ON "AttachmentChunk"("companyId", "attachmentId");

-- CreateIndex
CREATE UNIQUE INDEX "AttachmentChunk_attachmentId_seq_key" ON "AttachmentChunk"("attachmentId", "seq");

-- CreateIndex
CREATE INDEX "Attachment_companyId_status_idx" ON "Attachment"("companyId", "status");

-- DropForeignKey / AddForeignKey: see note 3 above.
ALTER TABLE "Participant" DROP CONSTRAINT "Participant_campaignId_fkey";

-- AddForeignKey
ALTER TABLE "Participant" ADD CONSTRAINT "Participant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentChunk" ADD CONSTRAINT "AttachmentChunk_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttachmentChunk" ADD CONSTRAINT "AttachmentChunk_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "Attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Row-level security for the new table, and for one that was missed (FR-01, NFR-03, D-57).
--
-- AttachmentChunk is new and tenant-owned, so it needs the policy 0008 applies to its siblings.
--
-- PromptVersion is not new. It carries a nullable companyId in exactly the shape Provider and
-- Route use — a row per tenant, NULL for the platform default — and 0008's list simply does not
-- name it, so it has never had a policy. Nothing noticed, because PrismaPromptSource filters by
-- companyId itself; the fence was missing behind a query that happens to be correct. A tenant's
-- prompt body is its own text, often describing its business, and it should not be one forgotten
-- WHERE clause away from another tenant.
--
-- The count-with-a-floor check in deploy/preflight.sh could not have found this, because the floor
-- only moves when someone remembers to move it. It now asks which tables carry a companyId and
-- lack a policy, which is what surfaced this one.
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['AttachmentChunk','PromptVersion']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_api'
      ' USING ("companyId" IS NULL'
      '        OR "companyId" = current_setting(''app.company_id'', true)'
      '        OR current_setting(''app.company_id'', true) = ''system'')'
      ' WITH CHECK ("companyId" = current_setting(''app.company_id'', true)'
      '             OR current_setting(''app.company_id'', true) = ''system'')', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO app_api', t);
  END LOOP;
END $$;
