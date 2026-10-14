#!/bin/bash
# restore-drill.sh and the drill's place in backup.sh and the healthcheck, run for real against
# stand-ins for pg_dump, psql, age, pg_restore and rclone (D-227).
#
# What is proved here is the decision logic, which is the part that matters when a backup is
# bad: that a restore with fewer rows than the manifest, an unreadable dump, a missing identity, an
# uploads archive that does not match, or no dump at all is reported as a failed drill with its
# reason, flips the alert file and the healthcheck, keeps the date of the last success, and always
# drops the scratch database. That Postgres really restores a dump is Postgres's job; the
# rehearsal on a real host (docs/OPERATIONS.md, "Evidence") is where that is shown.
. "$(dirname "$0")/harness.sh"

command -v jq >/dev/null || { echo "drill.test.sh: jq is required"; exit 1; }

setup() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-drill-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/state" "$SB/backups" "$SB/uploads/a" "$SB/ops/alerts" "$SB/ops/status"
	echo "recording" >"$SB/uploads/a/answer.wav"
	echo "second" >"$SB/uploads/a/other.wav"
	: >"$SB/psql.log"
	cat >"$SB/bin/pg_dump" <<'FAKE'
#!/bin/bash
echo "PGDMP-fake-custom-format-archive"
FAKE
	cat >"$SB/bin/psql" <<'FAKE'
#!/bin/bash
# stand-in: logs every call; answers the manifest query with the counts the test chose
echo "psql $*" >>"$SB/psql.log"
case "$*" in
*json_build_object*)
	case "$1" in
	*ai_discovery_drill*) cat "$SB/state/restored-counts" 2>/dev/null || cat "$SB/state/live-counts" ;;
	*) cat "$SB/state/live-counts" ;;
	esac
	;;
*"create database"*) [ -e "$SB/state/create-fails" ] && exit 2 ;;
esac
exit 0
FAKE
	cat >"$SB/bin/age" <<'FAKE'
#!/bin/bash
echo "age $*" >>"$SB/age.log"
cat
FAKE
	cat >"$SB/bin/pg_restore" <<'FAKE'
#!/bin/bash
echo "pg_restore $*" >>"$SB/pgrestore.log"
cat >/dev/null
if [ -e "$SB/state/restore-fails" ]; then echo 'pg_restore: error: could not execute query: ERROR: extension "vector" is not available' >&2; exit 1; fi
exit 0
FAKE
	cat >"$SB/bin/rclone" <<'FAKE'
#!/bin/bash
exit 0
FAKE
	chmod +x "$SB/bin/"*
	echo '{"Company":3,"User":5,"Campaign":2,"Session":41,"Message":812,"Fact":97,"Attachment":6,"LlmCall":1304}' >"$SB/state/live-counts"
	export SB
	export PATH="$SB/bin:$PATH"
	export PGURL="postgresql://app:x@db:5432/ai_discovery"
	export BACKUP_DIR="$SB/backups"
	export UPLOAD_DIR="$SB/uploads"
	export OPS_STATE_DIR="$SB/ops"
	export BACKUP_HEARTBEAT_FILE="$SB/heartbeat"
	export BACKUP_AGE_RECIPIENT="age1testrecipienttestrecipienttestrecipienttestrecipienttest"
	export BACKUP_AGE_IDENTITY="AGE-SECRET-KEY-1TESTIDENTITY"
	unset RCLONE_REMOTE
	date +%s >"$SB/heartbeat"
	# A real run of backup.sh writes the dump, the uploads archive and the manifest the drill reads.
	"$DEPLOY_DIR/backup.sh" once >/dev/null 2>&1
}
teardown() { rm -rf "$SB"; }

drill() {
	OUT=$("$DEPLOY_DIR/restore-drill.sh" 2>&1)
	STATUS=$?
}
health() {
	HOUT=$("$DEPLOY_DIR/backup-health.sh" 2>&1)
	HSTATUS=$?
}
status_json() { cat "$SB/ops/status/backup.json" 2>/dev/null; }
jqs() { status_json | jq -r "$1"; }
manifest() { ls "$SB/backups"/ai_discovery-*.manifest.json | head -n1; }

echo "a backup writes the manifest the drill checks against"
setup
assert_eq "one manifest beside the dump" 1 "$(ls "$SB/backups"/ai_discovery-*.manifest.json | wc -l | tr -d ' ')"
assert_eq "it names the dump" "$(basename "$(ls "$SB/backups"/ai_discovery-*.dump.age)")" "$(jq -r .dump "$(manifest)")"
assert_eq "it carries the row counts" 41 "$(jq -r .counts.Session "$(manifest)")"
assert_eq "and the files the uploads archive holds, counted from the archive" 2 "$(jq -r .uploadsCount "$(manifest)")"
teardown

echo "a restore that matches the manifest"
setup
drill
assert_status "exits 0" 0 "$STATUS"
assert_eq "records ok" ok "$(jqs .drill.result)"
assert_eq "names the dump it restored" "$(jqs .dump)" "$(jqs .drill.dump)"
assert_eq "records how long it took (the measured RTO)" true "$(jqs '.drill.durationS >= 0')"
assert_eq "and when it last succeeded" true "$(jqs '.drill.lastSuccessAt != null')"
assert_eq "no error is left" null "$(jqs .drill.error)"
assert_contains "restored through age into the scratch database" "$(cat "$SB/pgrestore.log")" "--dbname=postgresql://app:x@db:5432/ai_discovery_drill"
assert_contains "created the scratch database" "$(cat "$SB/psql.log")" 'create database "ai_discovery_drill"'
assert_contains "dropped it again" "$(tail -n 3 "$SB/psql.log")" 'drop database if exists "ai_discovery_drill"'
assert_eq "wrote no alert" 0 "$(ls "$SB/ops/alerts" | wc -l | tr -d ' ')"
assert_eq "never touched the live database" 0 "$(grep -c 'drop database if exists "ai_discovery"' "$SB/psql.log" || true)"
health
assert_status "the healthcheck stays healthy" 0 "$HSTATUS"
teardown

echo "rows written between the counts and the dump are not a mismatch"
setup
echo '{"Company":3,"User":5,"Campaign":2,"Session":43,"Message":815,"Fact":97,"Attachment":6,"LlmCall":1310}' >"$SB/state/restored-counts"
drill
assert_status "more rows than the manifest is fine" 0 "$STATUS"
assert_eq "records ok" ok "$(jqs .drill.result)"
teardown

echo "a restore with fewer rows than the manifest"
setup
drill
first_ok=$(jqs .drill.lastSuccessAt)
echo '{"Company":3,"User":5,"Campaign":2,"Session":40,"Message":812,"Fact":97,"Attachment":6,"LlmCall":1304}' >"$SB/state/restored-counts"
drill
assert_status "exits non-zero" 1 "$STATUS"
assert_eq "records failed" failed "$(jqs .drill.result)"
assert_contains "names the table and both numbers" "$(jqs .drill.error)" "Session: 40 restored vs 41 in the manifest"
assert_eq "keeps when the drill last succeeded" "$first_ok" "$(jqs .drill.lastSuccessAt)"
alert=$(ls "$SB/ops/alerts"/backup.drill_failed-*.json 2>/dev/null | head -n1)
assert_contains "writes the alert file for the sidecar" "$(cat "$alert" 2>/dev/null)" '"kind":"backup.drill_failed"'
assert_contains "at critical" "$(cat "$alert" 2>/dev/null)" '"severity":"critical"'
assert_contains "with the reason" "$(cat "$alert" 2>/dev/null)" "Session: 40 restored vs 41"
assert_contains "and still drops the scratch database" "$(tail -n 3 "$SB/psql.log")" 'drop database if exists "ai_discovery_drill"'
health
assert_status "the healthcheck flips to unhealthy" 1 "$HSTATUS"
assert_contains "and says why" "$HOUT" "last restore drill failed"
echo '{"Company":3,"User":5,"Campaign":2,"Session":41,"Message":812,"Fact":97,"Attachment":6,"LlmCall":1304}' >"$SB/state/restored-counts"
drill
assert_status "the next good drill exits 0" 0 "$STATUS"
health
assert_status "and the healthcheck recovers" 0 "$HSTATUS"
teardown

echo "a table missing from the restored database counts as a mismatch"
setup
echo '{"Company":3,"User":5,"Campaign":2,"Message":812,"Fact":97,"Attachment":6,"LlmCall":1304}' >"$SB/state/restored-counts"
drill
assert_status "exits non-zero" 1 "$STATUS"
assert_contains "and names it" "$(jqs .drill.error)" "Session: missing restored vs 41"
teardown

echo "pg_restore itself fails"
setup
touch "$SB/state/restore-fails"
drill
assert_status "exits non-zero" 1 "$STATUS"
assert_contains "carries what pg_restore said" "$(jqs .drill.error)" 'extension "vector" is not available'
assert_contains "still drops the scratch database" "$(tail -n 3 "$SB/psql.log")" 'drop database if exists "ai_discovery_drill"'
teardown

echo "the uploads archive"
setup
jq '.uploadsCount = 5' "$(manifest)" >"$SB/m.json" && mv "$SB/m.json" "$(manifest)"
drill
assert_status "a count that does not match fails" 1 "$STATUS"
assert_contains "and says both numbers" "$(jqs .drill.error)" "holds 2 files, the manifest counted 5"
rm -f "$SB/backups"/uploads-*.tar.gz.age
drill
assert_status "a missing archive the manifest counted fails" 1 "$STATUS"
assert_contains "and says so" "$(jqs .drill.error)" "is missing"
teardown

echo "nothing to restore, or no way to read it"
setup
rm -f "$SB/backups"/ai_discovery-*.dump.age
drill
assert_status "no dump fails" 1 "$STATUS"
assert_contains "and says so" "$(jqs .drill.error)" "no encrypted dump"
teardown
setup
BACKUP_AGE_IDENTITY="" drill
assert_status "no identity fails" 1 "$STATUS"
assert_contains "and says why" "$(jqs .drill.error)" "BACKUP_AGE_IDENTITY"
teardown
setup
rm -f "$SB/backups"/ai_discovery-*.manifest.json
jq 'del(.dump)' "$SB/ops/status/backup.json" >"$SB/s.json" && mv "$SB/s.json" "$SB/ops/status/backup.json"
drill
assert_status "no manifest fails" 1 "$STATUS"
assert_contains "and says nothing to compare against" "$(jqs .drill.error)" "no manifest"
teardown
setup
touch "$SB/state/create-fails"
drill
assert_status "an unreachable server fails the drill, not the shell" 1 "$STATUS"
teardown

echo "a dump from before manifests were written still drills, from the status file"
setup
rm -f "$SB/backups"/ai_discovery-*.manifest.json
drill
assert_status "uses the status file's counts for the newest dump" 0 "$STATUS"
teardown

echo "the same drill, through backup.sh"
setup
OUT=$("$DEPLOY_DIR/backup.sh" drill 2>&1)
assert_status "backup.sh drill exits with the drill's result" 0 $?
assert_eq "and the drill ran" ok "$(jqs .drill.result)"
teardown

finish
