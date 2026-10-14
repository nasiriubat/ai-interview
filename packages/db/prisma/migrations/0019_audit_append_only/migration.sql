-- The audit log becomes append-only and tamper-evident (A2, D-163, FR-51, NFR-03).
--
-- 1. The application role loses UPDATE, DELETE and TRUNCATE on "AuditLog". Migration 0010's
--    blanket grants gave it everything; a log the application can rewrite is a diary, not a log.
-- 2. Triggers refuse UPDATE, DELETE and TRUNCATE for every role, the owner included, unless the
--    transaction says `SET LOCAL app.audit_purge = 'on'`. Only the tenant-purge job (A5) does,
--    and only for DELETE and TRUNCATE; nothing may edit a row.
-- 3. Each row carries `seq`, `prevHash` and `hash`, filled by an insert trigger under a per-tenant
--    advisory lock: hash = sha256 of [prevHash, id, companyId, actorId, action, targetType,
--    targetId, diff, createdAt]. Editing or removing a row, even by disabling the triggers as
--    the owner, breaks every later hash, and `audit_chain_verify()` finds it.
--
-- Existing rows are chained in (createdAt, id) order per tenant; that history is only as
-- trustworthy as the moment of this migration, which is the honest limit of any retrofit.
ALTER TABLE "AuditLog" ADD COLUMN "seq" INTEGER;
ALTER TABLE "AuditLog" ADD COLUMN "prevHash" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "hash" TEXT;

CREATE OR REPLACE FUNCTION audit_row_hash(
  prev TEXT, id TEXT, company TEXT, actor TEXT, act TEXT, ttype TEXT, tid TEXT, diff JSONB, created TIMESTAMP
) RETURNS TEXT
LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(
    sha256(convert_to(
      jsonb_build_array(
        prev, id, company, actor, act, ttype, tid, diff,
        to_char(created, 'YYYY-MM-DD"T"HH24:MI:SS.US')
      )::text,
      'UTF8')),
    'hex')
$$;

-- Backfill, in order, before the guards exist so that the UPDATEs are allowed.
DO $$
DECLARE
  r RECORD;
  cur_company TEXT := NULL;
  n INTEGER := 0;
  prev TEXT := '';
  h TEXT;
BEGIN
  FOR r IN SELECT * FROM "AuditLog" ORDER BY "companyId", "createdAt", id LOOP
    IF cur_company IS DISTINCT FROM r."companyId" THEN
      cur_company := r."companyId";
      n := 0;
      prev := '';
    END IF;
    n := n + 1;
    h := audit_row_hash(prev, r.id, r."companyId", r."actorId", r.action, r."targetType", r."targetId", r.diff, r."createdAt");
    UPDATE "AuditLog" SET seq = n, "prevHash" = prev, hash = h WHERE id = r.id;
    prev := h;
  END LOOP;
END $$;

-- Defaults exist only so the client need not name the columns; the insert trigger always
-- overwrites them.
ALTER TABLE "AuditLog" ALTER COLUMN "seq" SET NOT NULL, ALTER COLUMN "seq" SET DEFAULT 0;
ALTER TABLE "AuditLog" ALTER COLUMN "prevHash" SET NOT NULL, ALTER COLUMN "prevHash" SET DEFAULT '';
ALTER TABLE "AuditLog" ALTER COLUMN "hash" SET NOT NULL, ALTER COLUMN "hash" SET DEFAULT '';
CREATE UNIQUE INDEX "AuditLog_companyId_seq_key" ON "AuditLog"("companyId", "seq");

-- The insert trigger. SECURITY DEFINER so that the read of the previous hash is not narrowed by a
-- row-level-security context that names a different tenant; `search_path` is pinned so the
-- definer cannot be redirected by a caller.
CREATE OR REPLACE FUNCTION audit_chain_before_insert() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  prev_seq INTEGER;
  prev_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('auditlog:' || NEW."companyId", 0));
  SELECT l.seq, l.hash INTO prev_seq, prev_hash
    FROM "AuditLog" l
   WHERE l."companyId" = NEW."companyId"
   ORDER BY l.seq DESC
   LIMIT 1;
  NEW.seq := COALESCE(prev_seq, 0) + 1;
  NEW."prevHash" := COALESCE(prev_hash, '');
  NEW.hash := audit_row_hash(
    NEW."prevHash", NEW.id, NEW."companyId", NEW."actorId", NEW.action,
    NEW."targetType", NEW."targetId", NEW.diff, NEW."createdAt");
  RETURN NEW;
END $$;

CREATE TRIGGER "AuditLog_chain" BEFORE INSERT ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_chain_before_insert();

-- Append-only: refused for every role unless the purge flag is set, and the flag never allows an UPDATE.
CREATE OR REPLACE FUNCTION audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND current_setting('app.audit_purge', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION 'AuditLog is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;

CREATE TRIGGER "AuditLog_no_change" BEFORE UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_append_only();
CREATE TRIGGER "AuditLog_no_truncate" BEFORE TRUNCATE ON "AuditLog"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_append_only();

REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog" FROM app_api;

-- The verifier: walks every tenant's chain (or one) and answers the rows that do not follow from
-- the one before. Empty result means intact. Read-only, and an invoker's function: under a tenant
-- context row-level security shows only that tenant's chain; the system context sees them all.
CREATE OR REPLACE FUNCTION audit_chain_verify(only_company TEXT DEFAULT NULL)
RETURNS TABLE (company TEXT, seq INTEGER, id TEXT, problem TEXT)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  r RECORD;
  cur TEXT := NULL;
  expect_seq INTEGER := 0;
  expect_prev TEXT := '';
BEGIN
  FOR r IN
    SELECT * FROM "AuditLog" l
     WHERE only_company IS NULL OR l."companyId" = only_company
     ORDER BY l."companyId", l.seq
  LOOP
    IF cur IS DISTINCT FROM r."companyId" THEN
      cur := r."companyId";
      expect_seq := 0;
      expect_prev := '';
    END IF;
    expect_seq := expect_seq + 1;
    IF r.seq <> expect_seq THEN
      company := r."companyId"; seq := r.seq; id := r.id; problem := 'gap: expected seq ' || expect_seq;
      RETURN NEXT;
      expect_seq := r.seq;
    END IF;
    IF r."prevHash" <> expect_prev THEN
      company := r."companyId"; seq := r.seq; id := r.id; problem := 'prevHash does not follow the previous row';
      RETURN NEXT;
    END IF;
    IF r.hash <> audit_row_hash(r."prevHash", r.id, r."companyId", r."actorId", r.action,
                                r."targetType", r."targetId", r.diff, r."createdAt") THEN
      company := r."companyId"; seq := r.seq; id := r.id; problem := 'hash does not match the row content';
      RETURN NEXT;
    END IF;
    expect_prev := r.hash;
  END LOOP;
END $$;

-- The newest hash per tenant: what an operator copies into the weekly backup log, so a later
-- rewrite of the whole chain would have to match a value kept somewhere else.
CREATE OR REPLACE FUNCTION audit_chain_heads()
RETURNS TABLE (company TEXT, seq INTEGER, hash TEXT)
LANGUAGE sql STABLE AS $$
  SELECT DISTINCT ON (l."companyId") l."companyId", l.seq, l.hash
    FROM "AuditLog" l
   ORDER BY l."companyId", l.seq DESC
$$;

GRANT EXECUTE ON FUNCTION audit_chain_verify(TEXT) TO app_api;
GRANT EXECUTE ON FUNCTION audit_chain_heads() TO app_api;
