#!/bin/bash
# Refuse to start the application unless row-level security is genuinely in force.
#
# Migration 0008 writes policies that apply TO app_api. The owner role bypasses every one of
# them, and nothing looks wrong when it does: the app works, the tests pass, and tenant data
# leaks only when two tenants exist. This script is the check that failure mode cannot survive.
# It runs as a one-shot compose service that `api` and `worker` depend on, so a stack that would
# have started on the owner role does not start at all.
#
# Input: APP_DATABASE_URL, exactly the URL the API will use.
set -euo pipefail

: "${APP_DATABASE_URL:?preflight: APP_DATABASE_URL is required}"

fail() {
	echo "preflight: FAIL: $*" >&2
	echo "preflight: refusing to start the application. See docs/DEPLOY.md, 'Database roles'." >&2
	exit 1
}

q() { psql "$APP_DATABASE_URL" -tAX -c "$1"; }

# 1. The URL itself must name the unprivileged role. Cheap, and it catches a hand-edited compose
#    file before any connection is attempted.
case "$APP_DATABASE_URL" in
postgresql://app_api:* | postgres://app_api:*) ;;
*) fail "APP_DATABASE_URL does not connect as app_api" ;;
esac

# Postgres may still be finishing recovery when the gate runs; give it a minute.
for _ in $(seq 1 30); do
	if psql "$APP_DATABASE_URL" -tAX -c "select 1" >/dev/null 2>&1; then break; fi
	sleep 2
done

# 2. The server agrees about who connected.
role=$(q "select current_user")
[ "$role" = "app_api" ] || fail "connected as '$role', expected 'app_api'"

# 3. That role cannot step over the policies. Either attribute would make the fence decorative.
privs=$(q "select rolsuper::text || ' ' || rolbypassrls::text from pg_roles where rolname = current_user")
[ "$privs" = "false false" ] || fail "app_api has rolsuper/rolbypassrls = $privs, expected 'false false'"

# 4. The tables that hold tenant data have RLS switched on. 0008 covers thirteen of them.
protected=$(q "select count(*) from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relrowsecurity")
[ "$protected" -ge 13 ] || fail "only $protected tables have row-level security enabled, expected at least 13"

# 5. pg-boss runs `CREATE SCHEMA IF NOT EXISTS pgboss` on every start and PostgreSQL checks
#    CREATE on the database before it looks at IF NOT EXISTS, so without this the API and worker
#    crash-loop on boot. deploy/grants.sql applies it; this catches a stack where it did not run.
can_create=$(q "select has_database_privilege(current_user, current_database(), 'CREATE')::text")
[ "$can_create" = "true" ] ||
	fail "app_api lacks CREATE on the database; pg-boss cannot start (run deploy/grants.sql)"

# 6. The job queue must be usable by this role. After a restore the pgboss tables come back owned
#    by the owner role with nothing granted, and the API dies on "permission denied for table
#    version" some seconds after it looks like it started. deploy/grants.sql hands them back.
if [ "$(q "select (to_regclass('pgboss.version') is not null)::text")" = "true" ]; then
	q "select count(*) from pgboss.version" >/dev/null 2>&1 ||
		fail "app_api cannot read pgboss.version; pg-boss will crash-loop (run deploy/grants.sql)"
fi

# 7. The decisive one: with no app.company_id set, the policies must hide every tenant row.
#    bootstrap has just created at least two users (operator and first admin). If this connection
#    can see them, it is not being filtered, and steps 2 to 4 were lying somewhere.
visible=$(q 'select count(*) from "User"')
[ "$visible" = "0" ] ||
	fail "an untenanted connection can see $visible User rows; policies are not being applied"

echo "preflight: ok — connected as app_api, no bypass, $protected tables under RLS, CREATE on database, untenanted reads return nothing"
