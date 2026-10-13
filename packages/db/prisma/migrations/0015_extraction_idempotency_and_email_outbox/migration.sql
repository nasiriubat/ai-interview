-- Idempotent fact extraction and a send-once email outbox (NFR-09, D-100, D-105).
--
-- 1. Fact gains the idempotency key of the extraction batch that wrote it.
--
--    `session.extract` used to advance the session's cursor and save the facts in state per
--    batch, and the worker wrote the Fact rows afterwards, once, with no uniqueness anywhere. A
--    crash between the two lost the facts for good (the retry saw nothing pending); a retry that
--    did re-extract would have written them twice. Batches are now committed in one transaction
--    and each row is keyed by (session, last message sequence of the batch, position in batch),
--    so replaying a batch writes nothing the second time.
--
--    Existing rows predate batches. They get batchEndSeq 0 and a per-session running ordinal,
--    which makes each of them unique on its own and exempts them from the key by construction.
ALTER TABLE "Fact" ADD COLUMN "batchEndSeq" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "ordinal" INTEGER NOT NULL DEFAULT 0;

UPDATE "Fact" f
SET "ordinal" = r.n
FROM (
  SELECT id, (ROW_NUMBER() OVER (PARTITION BY "sessionId" ORDER BY "extractedAt", id) - 1)::int AS n
  FROM "Fact"
) r
WHERE f.id = r.id;

-- No default afterwards: a writer that forgets the key should fail loudly, not collide on zero.
ALTER TABLE "Fact" ALTER COLUMN "batchEndSeq" DROP DEFAULT,
ALTER COLUMN "ordinal" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "Fact_sessionId_batchEndSeq_ordinal_key" ON "Fact"("sessionId", "batchEndSeq", "ordinal");

-- 2. SentEmail: what the worker has sent, by the caller's idempotency key.
--
--    An SMTP send followed by a failed job acknowledgement means the queue retries, and the
--    message goes out again, up to six times. The handler claims the key before sending and marks
--    it sent afterwards; a retry of a sent message does nothing, and a claim abandoned by a crash
--    is taken over after a lease. That is at-least-once with duplicates bounded to the crash
--    window, which is the honest guarantee for SMTP.
CREATE TABLE "SentEmail" (
    "id" TEXT NOT NULL,
    "companyId" TEXT,
    "idempotencyKey" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'sending',
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "SentEmail_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SentEmail_idempotencyKey_key" ON "SentEmail"("idempotencyKey");

-- CreateIndex
CREATE INDEX "SentEmail_state_claimedAt_idx" ON "SentEmail"("state", "claimedAt");

-- CreateIndex
CREATE INDEX "SentEmail_sentAt_idx" ON "SentEmail"("sentAt");

-- Row-level security, in the shape 0011 gave PromptVersion: companyId is nullable because a
-- message can be platform-level (an operator notice), and a tenant sees its own rows only.
DO $$
BEGIN
  EXECUTE 'ALTER TABLE "SentEmail" ENABLE ROW LEVEL SECURITY';
  EXECUTE 'DROP POLICY IF EXISTS tenant_isolation ON "SentEmail"';
  EXECUTE 'CREATE POLICY tenant_isolation ON "SentEmail" TO app_api'
    ' USING ("companyId" IS NULL'
    '        OR "companyId" = current_setting(''app.company_id'', true)'
    '        OR current_setting(''app.company_id'', true) = ''system'')'
    ' WITH CHECK ("companyId" IS NULL'
    '             OR "companyId" = current_setting(''app.company_id'', true)'
    '             OR current_setting(''app.company_id'', true) = ''system'')';
  EXECUTE 'GRANT SELECT, INSERT, UPDATE, DELETE ON "SentEmail" TO app_api';
END $$;
