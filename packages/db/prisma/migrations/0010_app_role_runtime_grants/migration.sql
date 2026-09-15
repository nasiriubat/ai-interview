-- Runtime privileges the application role needs, which are properties of the schema rather than
-- of a deployment, so they belong with the migrations that created it.
--
-- Found by running the production stack rather than by reading the schema: as `app_api` the API
-- crash-looped on boot, because pg-boss issues `CREATE SCHEMA IF NOT EXISTS pgboss` on every
-- start and PostgreSQL checks CREATE on the database before it evaluates IF NOT EXISTS. The
-- statement therefore fails even though migration 0008 already created the schema. Development
-- never saw it, because it connects as the owner.
--
-- CREATE on a database means "may create schemas in it" and nothing more. `app_api` still has no
-- BYPASSRLS, still owns no application table, and is still subject to every policy in 0008.
DO $$
BEGIN
  EXECUTE format('GRANT CREATE ON DATABASE %I TO app_api', current_database());
END $$;

-- Re-assert the application-schema grants. They are already set by 0008 for the tables that
-- existed then; repeating them costs nothing and covers a database restored from a dump taken
-- on a cluster that had drifted.
GRANT USAGE ON SCHEMA public TO app_api;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_api;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_api;
