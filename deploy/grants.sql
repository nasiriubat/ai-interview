-- Repairs the job queue's ownership after a restore. Runs as the owner role on every boot, after
-- `prisma migrate deploy`; it is idempotent and a no-op on a healthy system.
--
-- Everything else that used to live here is now migration 0010_app_role_runtime_grants, because
-- it describes the schema rather than the deployment. What is left cannot be a migration: it
-- repairs state that only a restore can produce, at a moment when migrations have already run.
--
-- The failure it fixes: in a running system app_api creates the pgboss tables itself and owns
-- them, so they carry no explicit ACL. pg_dump therefore writes no GRANT for them, and
-- `pg_restore --no-owner --role=app` recreates them owned by the owner role with nothing granted
-- to app_api — the API then dies on "permission denied for table version". Migration 0008's
-- ALTER DEFAULT PRIVILEGES does not save it either, because pg_restore replays default privileges
-- after the tables have already been created.
--
-- Handing the queue back to app_api restores the arrangement a healthy system has, rather than
-- papering over it with grants.
DO $$
DECLARE obj record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'pgboss') THEN RETURN; END IF;
  FOR obj IN
    SELECT c.relname, c.relkind FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_roles r ON r.oid = c.relowner
     WHERE n.nspname = 'pgboss' AND c.relkind IN ('r', 'p', 'S') AND r.rolname <> 'app_api'
  LOOP
    IF obj.relkind = 'S' THEN
      EXECUTE format('ALTER SEQUENCE pgboss.%I OWNER TO app_api', obj.relname);
    ELSE
      EXECUTE format('ALTER TABLE pgboss.%I OWNER TO app_api', obj.relname);
    END IF;
  END LOOP;
  FOR obj IN
    SELECT p.oid::regprocedure AS sig FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
      JOIN pg_roles r ON r.oid = p.proowner
     WHERE n.nspname = 'pgboss' AND r.rolname <> 'app_api'
  LOOP
    EXECUTE format('ALTER FUNCTION %s OWNER TO app_api', obj.sig);
  END LOOP;
  FOR obj IN
    SELECT t.oid::regtype AS name FROM pg_type t
      JOIN pg_namespace n ON n.oid = t.typnamespace
      JOIN pg_roles r ON r.oid = t.typowner
     WHERE n.nspname = 'pgboss' AND t.typtype = 'e' AND r.rolname <> 'app_api'
  LOOP
    EXECUTE format('ALTER TYPE %s OWNER TO app_api', obj.name);
  END LOOP;
END $$;
