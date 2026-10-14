#!/bin/bash
# deploy/preflight.sh: that its refusals now reach the ops-notify sidecar (D-94), and that its
# checks are unchanged. The gate runs before the API and the worker, so when it refuses nothing in
# the application is alive to say so; a file on the ops_state volume is the only voice it has.
. "$(dirname "$0")/harness.sh"
trap 'rm -rf "${SB:-}"' EXIT

command -v jq >/dev/null || { echo "preflight.test.sh: jq is required"; exit 1; }

setup() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-preflight-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/state" "$SB/ops/alerts"
	cat >"$SB/bin/psql" <<'FAKE'
#!/bin/bash
# stand-in for psql -tAX -c "<sql>": answers by what the query asks
sql=""
prev=""
for a in "$@"; do [ "$prev" = "-c" ] && sql=$a; prev=$a; done
s() { cat "$SB/state/$1" 2>/dev/null || echo "$2"; }
case "$sql" in
"select 1") echo 1 ;;
"select current_user") s role app_api ;;
*rolsuper*) s privs "false false" ;;
*exempt_with_company*) s contradicting "" ;;
*"as unprotected"*) s unprotected "" ;;
*"count(*) from pg_class"*) s protected 28 ;;
*audit_append_only*) s audit ok ;;
*has_database_privilege*) s can_create true ;;
*"to_regclass('pgboss.version')"*) echo true ;;
*"from pgboss.version"*) exit 0 ;;
*'from "User"'*) s visible 0 ;;
*) echo "unexpected query: $sql" >&2; exit 9 ;;
esac
FAKE
	chmod +x "$SB/bin/psql"
	export SB PATH="$SB/bin:$PATH"
	export APP_DATABASE_URL="postgresql://app_api:secret@postgres:5432/ai_discovery"
	export OPS_STATE_DIR="$SB/ops"
	# The reviewed list of tables that are deliberately outside row-level security.
	printf '# comment\n\nVerificationToken  platform-level, no tenant\n_prisma_migrations  bookkeeping\n' >"$SB/exempt.txt"
	export RLS_EXEMPT_FILE="$SB/exempt.txt"
}

pre() {
	OUT=$("$DEPLOY_DIR/preflight.sh" 2>&1)
	STATUS=$?
}
alerts() { ls "$SB/ops/alerts"/*.json 2>/dev/null; }

echo "a healthy database"
setup
pre
assert_status "passes" 0 "$STATUS"
assert_contains "and says so" "$OUT" "preflight: ok"
assert_eq "writes no alert" 0 "$(alerts | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "a table with no policy that is not on the exempt list"
setup
echo "OpsAlert" >"$SB/state/unprotected"
pre
assert_status "refuses" 1 "$STATUS"
f=$(alerts | head -n1)
assert_contains "writes an alert file named for the kind" "$f" "rls.preflight_failed-"
assert_eq "whose kind is the catalog's" rls.preflight_failed "$(jq -r .kind "$f")"
assert_eq "at critical" critical "$(jq -r .severity "$f")"
assert_contains "naming the table" "$(jq -r .message "$f")" "OpsAlert"
assert_contains "and the consequence" "$(jq -r .message "$f")" "api and worker did not start"
assert_eq "leaves no half-written temporary file" 0 "$(find "$SB/ops/alerts" -name '.tmp*' | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "an exempt table that carries a companyId contradicts itself"
setup
echo "VerificationToken" >"$SB/state/contradicting"
pre
assert_status "refuses" 1 "$STATUS"
assert_contains "naming it" "$(jq -r .message "$(alerts | head -n1)")" "on deploy/rls-exempt.txt but carry a companyId: VerificationToken"
rm -rf "$SB"

echo "an audit log the application role could rewrite"
setup
echo "app_api can UPDATE AuditLog" >"$SB/state/audit"
pre
assert_status "refuses" 1 "$STATUS"
assert_contains "naming the privilege" "$(jq -r .message "$(alerts | head -n1)")" "app_api can UPDATE AuditLog"
assert_contains "and the consequence" "$(jq -r .message "$(alerts | head -n1)")" "api and worker did not start"
rm -rf "$SB"

echo "an exemption written without a reason is refused"
setup
printf 'VerificationToken\n' >"$SB/exempt.txt"
pre
assert_status "refuses" 1 "$STATUS"
assert_contains "and asks for the reason" "$OUT" "has no reason"
rm -rf "$SB"

echo "the exempt list cannot be read"
setup
export RLS_EXEMPT_FILE="$SB/missing.txt"
pre
assert_status "refuses" 1 "$STATUS"
assert_contains "and says where it looked" "$OUT" "cannot read the RLS exempt list"
rm -rf "$SB"

echo "the role has a bypass: the message carries characters that break naive JSON"
setup
echo 'true "x"' >"$SB/state/privs"
pre
assert_status "refuses" 1 "$STATUS"
f=$(alerts | head -n1)
assert_eq "and the file is still valid JSON" rls.preflight_failed "$(jq -r .kind "$f")"
assert_contains "with the quote intact" "$(jq -r .message "$f")" 'true "x"'
rm -rf "$SB"

echo "an untenanted connection that can see rows"
setup
echo 3 >"$SB/state/visible"
pre
assert_status "refuses" 1 "$STATUS"
assert_contains "and the alert says what was seen" "$(jq -r .message "$(alerts | head -n1)")" "can see 3 User rows"
rm -rf "$SB"

echo "without the ops state directory (development)"
setup
echo "OpsAlert" >"$SB/state/unprotected"
rm -rf "$SB/ops"
pre
assert_status "still refuses" 1 "$STATUS"
assert_contains "and says why on the terminal" "$OUT" "not on deploy/rls-exempt.txt: OpsAlert"
unset OPS_STATE_DIR
pre
assert_status "also with the variable unset" 1 "$STATUS"
rm -rf "$SB"

finish
