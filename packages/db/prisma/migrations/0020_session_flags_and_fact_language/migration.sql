-- Hostility and distress flags on the session row, and the language of each extracted fact
-- (blueprint features 10 and 15, D-173, D-177).
--
-- Additive only: every column is nullable or carries a default, so the previous release's code
-- keeps working against this schema (docs/MIGRATIONS.md).
--
-- 1. Session.flagged and friends. The engine has always written a `flag` SessionEvent and
--    `state.flaggedForAdmin`; neither could be filtered or listed. The first flag of a session
--    wins and stays; later ones append events only. The reason is model prose and may identify a
--    person, so it is returned to a viewer only when that viewer may read the transcript.
--
-- 2. Fact.language: the language the template was written in when the fact was extracted, so a
--    campaign run in two languages can be told apart in analysis. Backfilled from each fact's
--    session template; NULL stays "unknown".

ALTER TABLE "Session"
  ADD COLUMN "flagged"     BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "flagReason"  TEXT,
  ADD COLUMN "flaggedAt"   TIMESTAMP(3),
  ADD COLUMN "flagAckedAt" TIMESTAMP(3),
  ADD COLUMN "flagAckedBy" TEXT;

CREATE INDEX "Session_companyId_campaignId_flagged_idx"
  ON "Session" ("companyId", "campaignId", "flagged");

-- Backfill from the first `flag` event of each session (run by the owner role, which bypasses RLS).
UPDATE "Session" s
SET "flagged" = true,
    "flagReason" = left(e.payload ->> 'reason', 1000),
    "flaggedAt" = e."createdAt"
FROM (
  SELECT DISTINCT ON ("sessionId") "sessionId", payload, "createdAt"
  FROM "SessionEvent"
  WHERE type = 'flag'
  ORDER BY "sessionId", seq
) e
WHERE e."sessionId" = s.id;

ALTER TABLE "Fact" ADD COLUMN "language" TEXT;

UPDATE "Fact" f
SET "language" = t.language
FROM "Session" s
JOIN "InterviewTemplate" t ON t.id = s."templateId"
WHERE f."sessionId" = s.id;
