-- Security M1: one tenant per staff email (S9, D-84) and a database fence around deleted sessions
-- (S3, D-81). Additive and idempotent: running it twice, or against data that already satisfies it,
-- changes nothing.
--
-- Two unrelated pieces live here because they share a migration number, not a reason.

-- ---------------------------------------------------------------------------------------------
-- 1. Staff identity: `User.email` becomes globally unique and lower-case.
--
-- Before this, `User` was unique only on (companyId, email) and the principal resolver picked
-- whichever row `findFirst` returned. Two tenants holding the same address made sign-in resolve
-- non-deterministically, and a tenant admin could create a user with the platform operator's
-- address and break the operator's sign-in.
--
-- Existing duplicates are resolved, not rejected, so the migration can run on a database that
-- already has them. The winner of a duplicate group is the platform operator if there is one, else
-- the oldest row. Every other row keeps its id (campaigns, sessions and audit rows still point at
-- it) and gets a non-routable address of the form `dup-<id>.<original>`, plus an audit row in its
-- own tenant saying so, so the owner can see exactly who was moved and decide what to do with it.
-- ---------------------------------------------------------------------------------------------

WITH ranked AS (
  SELECT
    id,
    "companyId",
    email,
    row_number() OVER (
      PARTITION BY lower(email)
      ORDER BY (role = 'platform_operator') DESC, "createdAt" ASC, id ASC
    ) AS rn
  FROM "User"
),
losers AS (
  SELECT id, "companyId", email FROM ranked WHERE rn > 1
),
renamed AS (
  UPDATE "User" u
     SET email = 'dup-' || u.id || '.' || lower(l.email)
    FROM losers l
   WHERE u.id = l.id
  RETURNING u.id, l."companyId", l.email AS old_email, u.email AS new_email
)
INSERT INTO "AuditLog" (id, "companyId", "actorId", action, "targetType", "targetId", diff, "createdAt")
SELECT
  'mig0013_' || r.id,
  r."companyId",
  NULL,
  'user.email_deduplicated',
  'user',
  r.id,
  jsonb_build_object('from', r.old_email, 'to', r.new_email, 'reason', 'migration 0013: one tenant per staff email'),
  CURRENT_TIMESTAMP
FROM renamed r
ON CONFLICT (id) DO NOTHING;

UPDATE "User" SET email = lower(email) WHERE email <> lower(email);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'User_email_lowercase_check'
  ) THEN
    ALTER TABLE "User" ADD CONSTRAINT "User_email_lowercase_check" CHECK (email = lower(email));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "User_email_key" ON "User"("email");

-- The composite is now implied by the single-column unique.
DROP INDEX IF EXISTS "User_companyId_email_key";

-- ---------------------------------------------------------------------------------------------
-- 2. A deleted session accepts no more content.
--
-- Deletion locks the session row (SELECT ... FOR UPDATE) and flips it to 'deleted'. Every code
-- path that writes content for a session - the turn runner, the extraction and summary jobs, an
-- upload that finished after the participant pressed delete - would otherwise need to remember to
-- re-check, inside its own transaction, that nobody deleted the session since it started. They
-- cannot all be trusted to, and a model call takes seconds, so the window is real.
--
-- These triggers make the check structural. `FOR SHARE` waits for an in-flight deletion to
-- commit and then sees its result, so a write either lands before the deletion (and is removed by
-- it) or is refused after it. The exception message is stable: callers match on `session_deleted`.
-- ---------------------------------------------------------------------------------------------

-- Sessions deleted before this migration kept `title`, `handoff`, `specEdits`, `invitations` and the
-- participant pointer (D-81 widens what deletion clears). Bring them to the same shape, so the
-- no-revival trigger below can hold for every deleted row and not only the new ones.
UPDATE "Session"
   SET title = '', handoff = NULL, "specEdits" = '{}'::jsonb, invitations = '[]'::jsonb,
       "participantId" = NULL, "turnLockedAt" = NULL
 WHERE status = 'deleted'
   AND (title <> '' OR handoff IS NOT NULL OR "specEdits" <> '{}'::jsonb OR invitations <> '[]'::jsonb
        OR "participantId" IS NOT NULL OR "turnLockedAt" IS NOT NULL);

CREATE OR REPLACE FUNCTION aidp_refuse_write_to_deleted_session() RETURNS trigger AS $$
DECLARE
  s text;
BEGIN
  SELECT status INTO s FROM "Session" WHERE id = NEW."sessionId" FOR SHARE;
  IF s = 'deleted' THEN
    RAISE EXCEPTION 'session_deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['Message', 'SessionEvent', 'Fact', 'Attachment', 'SpecVersion'] LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS aidp_deleted_session_fence ON %I', t);
    EXECUTE format(
      'CREATE TRIGGER aidp_deleted_session_fence BEFORE INSERT ON %I
         FOR EACH ROW EXECUTE FUNCTION aidp_refuse_write_to_deleted_session()',
      t
    );
  END LOOP;
END $$;

-- The session row itself: a deleted session cannot be revived, and its personal columns cannot be
-- refilled by a job that read them before the deletion (the rolling summary writes `state` and
-- `summary` after a model call).
CREATE OR REPLACE FUNCTION aidp_refuse_revival_of_deleted_session() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'deleted' THEN
    IF NEW.status <> 'deleted' THEN
      RAISE EXCEPTION 'session_deleted' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.state <> '{}'::jsonb OR NEW.summary <> '' OR NEW.title <> ''
       OR NEW.handoff IS NOT NULL OR NEW."specEdits" <> '{}'::jsonb OR NEW.invitations <> '[]'::jsonb THEN
      RAISE EXCEPTION 'session_deleted' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS aidp_deleted_session_no_revival ON "Session";
CREATE TRIGGER aidp_deleted_session_no_revival BEFORE UPDATE ON "Session"
  FOR EACH ROW EXECUTE FUNCTION aidp_refuse_revival_of_deleted_session();
