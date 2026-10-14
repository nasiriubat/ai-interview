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

# Where a failure is also written for the ops-notify sidecar to deliver (D-92). This gate runs
# before the API and worker, so when it refuses, nothing in the application is alive to raise an
# alert; a file on the shared ops_state volume is the one channel that still works. Absent in
# development, where the failure on the terminal is the alert.
OPS_STATE_DIR="${OPS_STATE_DIR:-}"

# Escapes a string for a JSON value: backslash, quote, and anything that would break the line.
json_str() {
	printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr '\n\r\t' '   '
}

emit_alert() {
	[ -n "$OPS_STATE_DIR" ] && [ -d "$OPS_STATE_DIR/alerts" ] || return 0
	local now file
	now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	file="$OPS_STATE_DIR/alerts/rls.preflight_failed-$(date -u +%Y%m%dT%H%M%SZ).json"
	# Written to a hidden name and renamed, so the sidecar never reads half a file.
	printf '{"kind":"rls.preflight_failed","severity":"critical","key":"rls.preflight_failed","title":"RLS preflight failed on boot","message":"%s","occurredAt":"%s"}\n' \
		"$(json_str "$1")" "$now" >"$OPS_STATE_DIR/alerts/.tmp.$$" 2>/dev/null &&
		mv "$OPS_STATE_DIR/alerts/.tmp.$$" "$file" 2>/dev/null || true
}

fail() {
	echo "preflight: FAIL: $*" >&2
	echo "preflight: refusing to start the application. See docs/DEPLOY.md, 'Database roles'." >&2
	emit_alert "RLS preflight FAILED on boot: $*. api and worker did not start. See docs/OPERATIONS.md#rlspreflight_failed."
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

# 4. Every public table is under row-level security, or is on the reviewed exempt list.
#
# The question is inverted on purpose. It used to be "which tables have a companyId and no
# policy", and that cannot see a table that reaches its tenant through a parent: nine of them had
# no companyId, so they had no policy and no check noticed (D-140). Now the default is "must be
# protected", and a table escapes only by being named, with a reason, in deploy/rls-exempt.txt.
# A new table whose migration forgot its policy therefore stops the stack on the next boot.
#
# A table counts as protected when RLS is on AND it has a `tenant_isolation` policy for app_api
# whose USING and WITH CHECK both read `app.company_id`. A policy of `USING (true)` is a table with
# no fence that looks like one, and does not pass.
EXEMPT_FILE="${RLS_EXEMPT_FILE:-$(cd "$(dirname "$0")" && pwd)/rls-exempt.txt}"
[ -r "$EXEMPT_FILE" ] || fail "cannot read the RLS exempt list at $EXEMPT_FILE"
exempt=""
while IFS= read -r line; do
	case "$line" in "" | "#"*) continue ;; esac
	name=${line%%[[:space:]]*}
	reason=${line#"$name"}
	reason=${reason#"${reason%%[![:space:]]*}"}
	[[ "$name" =~ ^[A-Za-z0-9_]+$ ]] || fail "rls-exempt.txt: '$name' is not a table name"
	[ -n "$reason" ] || fail "rls-exempt.txt: '$name' has no reason; an exemption is a decision, so write why"
	exempt="${exempt:+$exempt,}$name"
done <"$EXEMPT_FILE"

unprotected=$(q "select coalesce(string_agg(c.relname, ', ' order by c.relname), '') as unprotected
                   from pg_class c
                   join pg_namespace n on n.oid = c.relnamespace
                  where n.nspname = 'public' and c.relkind in ('r', 'p')
                    and c.relname <> all (string_to_array('$exempt', ','))
                    and (not c.relrowsecurity
                         or not exists (
                              select 1 from pg_policies p
                               where p.schemaname = 'public' and p.tablename = c.relname
                                 and p.policyname = 'tenant_isolation' and 'app_api' = any (p.roles)
                                 and p.qual like '%app.company_id%'
                                 and p.with_check like '%app.company_id%'))")
[ -z "$unprotected" ] ||
	fail "these tables have no tenant_isolation row-level security and are not on deploy/rls-exempt.txt: $unprotected"

# An exempt table that carries a companyId contradicts itself: the column says it is tenant data.
contradicting=$(q "select coalesce(string_agg(c.relname, ', ' order by c.relname), '') as exempt_with_company
                     from pg_class c
                     join pg_namespace n on n.oid = c.relnamespace
                     join pg_attribute a on a.attrelid = c.oid and a.attname = 'companyId' and a.attnum > 0
                    where n.nspname = 'public' and c.relkind in ('r', 'p')
                      and c.relname = any (string_to_array('$exempt', ','))")
[ -z "$contradicting" ] ||
	fail "these tables are on deploy/rls-exempt.txt but carry a companyId: $contradicting"

protected=$(q "select count(*) from pg_class c
                 join pg_namespace n on n.oid = c.relnamespace
                where n.nspname = 'public' and c.relkind in ('r', 'p') and c.relrowsecurity")

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

# 6b. The audit log is append-only (A2, D-163). Migration 0010 once granted everything on every
#     table, so a later migration could silently grant it back; this is the question asked at every
#     boot instead of trusted once. It also checks that the triggers which refuse the owner and
#     chain the rows still exist, because a restore from an old dump would not have them.
audit_problem=$(q "select case
                     when has_table_privilege(current_user, '\"AuditLog\"', 'UPDATE') then 'app_api can UPDATE AuditLog'
                     when has_table_privilege(current_user, '\"AuditLog\"', 'DELETE') then 'app_api can DELETE AuditLog'
                     when has_table_privilege(current_user, '\"AuditLog\"', 'TRUNCATE') then 'app_api can TRUNCATE AuditLog'
                     when (select count(*) from pg_trigger
                            where tgrelid = '\"AuditLog\"'::regclass and not tgisinternal
                              and tgname in ('AuditLog_chain', 'AuditLog_no_change', 'AuditLog_no_truncate')) <> 3
                       then 'AuditLog append-only or chain triggers are missing'
                     else 'ok' end as audit_append_only")
[ "$audit_problem" = "ok" ] ||
	fail "the audit log is not append-only: $audit_problem (re-run migrations; see docs/OPERATIONS.md#auditchain_broken)"

# 7. The decisive one: with no app.company_id set, the policies must hide every tenant row.
#    bootstrap has just created at least two users (operator and first admin). If this connection
#    can see them, it is not being filtered, and steps 2 to 4 were lying somewhere.
visible=$(q 'select count(*) from "User"')
[ "$visible" = "0" ] ||
	fail "an untenanted connection can see $visible User rows; policies are not being applied"

echo "preflight: ok — connected as app_api, no bypass, $protected tables under RLS, CREATE on database, audit log append-only, untenanted reads return nothing"
