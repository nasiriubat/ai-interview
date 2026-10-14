#!/bin/bash
# backup.sh and backup-health.sh, run for real against stand-ins for pg_dump, psql, age, pg_restore
# and rclone (D-95). Proves the reporting, which is the point of the change: a failed pg_dump makes
# the status file say failed and the healthcheck exit non-zero, a later success makes both clean,
# and a backup that is old or a scheduler that is dead is unhealthy without anything having failed.
#
# The stand-in age copies its input, so what is proved here is the plumbing: that the dump goes
# through age before it touches the disk, that nothing unencrypted is left, and what is verified
# and recorded. That age itself encrypts is age's job; deploy/test/crypto.test.sh runs the real
# one when it is installed.
. "$(dirname "$0")/harness.sh"
trap cleanup_sandbox EXIT

command -v jq >/dev/null || { echo "backup.test.sh: jq is required"; exit 1; }

setup() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-backup-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/state" "$SB/backups" "$SB/uploads/a" "$SB/ops/alerts" "$SB/ops/status"
	echo "recording" >"$SB/uploads/a/answer.wav"
	: >"$SB/rclone.log"
	cat >"$SB/bin/pg_dump" <<'FAKE'
#!/bin/bash
[ -e "$SB/state/pgdump-fails" ] && { echo "pg_dump: error: connection refused" >&2; exit 1; }
echo "PGDMP-fake-custom-format-archive"
# A real database's dump is far larger than a pipe buffer. The stand-in can be told to be.
[ -e "$SB/state/large-dump" ] && head -c 4000000 /dev/zero | tr '\0' 'x'
exit 0
FAKE
	cat >"$SB/bin/psql" <<'FAKE'
#!/bin/bash
[ -e "$SB/state/psql-fails" ] && exit 2
echo '{"Company":3,"User":5,"Campaign":2,"Session":41,"Message":812,"Fact":97,"Attachment":6,"LlmCall":1304}'
FAKE
	if [ "${BACKUP_TEST_REAL_AGE:-0}" != 1 ]; then
		cat >"$SB/bin/age" <<'FAKE'
#!/bin/bash
# stand-in: records that it was used, passes data through
echo "age $*" >>"$SB/age.log"
cat
FAKE
	fi
	cat >"$SB/bin/pg_restore" <<'FAKE'
#!/bin/bash
# Like the real `pg_restore --list` reading a pipe: it takes the header and the table of contents
# and exits, leaving the rest of the archive unread. A verifier that does not drain what is left
# is killed by SIGPIPE under pipefail, which is how every real backup larger than the pipe buffer
# once failed its own verification.
head -c 5 | grep -q PGDMP && [ ! -e "$SB/state/restore-lists-fail" ]
FAKE
	cat >"$SB/bin/rclone" <<'FAKE'
#!/bin/bash
echo "rclone $*" >>"$SB/rclone.log"
[ -e "$SB/state/rclone-fails" ] && [ "$1" = copy ] && exit 1
exit 0
FAKE
	chmod +x "$SB/bin/"*
	export SB
	export PATH="$SB/bin:$PATH"
	export PGURL="postgresql://app:x@db/ai_discovery"
	export BACKUP_DIR="$SB/backups"
	export UPLOAD_DIR="$SB/uploads"
	export OPS_STATE_DIR="$SB/ops"
	export BACKUP_HEARTBEAT_FILE="$SB/heartbeat"
	export BACKUP_AGE_RECIPIENT="age1testrecipienttestrecipienttestrecipienttestrecipienttest"
	export BACKUP_AGE_IDENTITY="AGE-SECRET-KEY-1TESTIDENTITY"
	if [ "${BACKUP_TEST_REAL_AGE:-0}" = 1 ]; then
		# The real age with a real key pair, so the verify step really decrypts the dump.
		keys=$(age-keygen 2>/dev/null)
		BACKUP_AGE_RECIPIENT=$(echo "$keys" | sed -n 's/^# public key: //p')
		BACKUP_AGE_IDENTITY=$(echo "$keys" | grep '^AGE-SECRET-KEY-')
		export BACKUP_AGE_RECIPIENT BACKUP_AGE_IDENTITY
	fi
	unset RCLONE_REMOTE
	date +%s >"$SB/heartbeat"
}
teardown() { rm -rf "$SB"; }

backup() {
	OUT=$("$DEPLOY_DIR/backup/backup.sh" once 2>&1)
	STATUS=$?
}
health() {
	HOUT=$("$DEPLOY_DIR/backup/backup-health.sh" 2>&1)
	HSTATUS=$?
}
nfiles() { find "$SB/backups" -name "$1" | wc -l | tr -d ' '; }
status_json() { cat "$SB/ops/status/backup.json" 2>/dev/null; }
jqs() { status_json | jq -r "$1"; }

echo "a good run"
setup
backup
assert_status "exits 0" 0 "$STATUS"
dumps=$(ls "$SB/backups"/ai_discovery-*.dump.age 2>/dev/null | wc -l | tr -d ' ')
archives=$(ls "$SB/backups"/uploads-*.tar.gz.age 2>/dev/null | wc -l | tr -d ' ')
assert_eq "writes one encrypted dump" 1 "$dumps"
assert_eq "and one encrypted uploads archive" 1 "$archives"
assert_eq "writes nothing in the clear" 0 "$(($(nfiles '*.dump') + $(nfiles '*.tar.gz') + $(nfiles '*.part')))"
if [ "${BACKUP_TEST_REAL_AGE:-0}" = 1 ]; then
	# With the real age the evidence is in the file itself: it is age's format, and not the dump.
	first=$(head -c 21 "$SB/backups"/ai_discovery-*.dump.age)
	assert_eq "the file on disk is an age file" "age-encryption.org/v1" "$first"
	assert_eq "and does not hold the dump" 0 "$(grep -c PGDMP "$SB/backups"/ai_discovery-*.dump.age || true)"
	age -d -i <(echo "$BACKUP_AGE_IDENTITY") <"$(ls "$SB/backups"/ai_discovery-*.dump.age)" >"$SB/roundtrip" 2>/dev/null
	assert_contains "and the identity reads it back" "$(cat "$SB/roundtrip")" "PGDMP-fake-custom-format-archive"
else
	assert_contains "pipes pg_dump through age to the recipient" "$(cat "$SB/age.log")" "age -r $BACKUP_AGE_RECIPIENT"
	assert_contains "decrypts to verify the dump" "$(cat "$SB/age.log")" "age -d -i"
fi
assert_eq "status says ok" ok "$(jqs .lastResult)"
assert_eq "status names the dump" "$(basename "$(find "$SB/backups" -name '*.dump.age')")" "$(jqs .dump)"
assert_eq "status carries the table counts" 41 "$(jqs .counts.Session)"
assert_eq "status carries the upload count" 1 "$(jqs .uploadsCount)"
assert_eq "status records encryption" true "$(jqs .encrypted)"
assert_eq "offsite is reported as not configured" not_configured "$(jqs .offsite)"
health
assert_status "the healthcheck passes" 0 "$HSTATUS"
teardown

echo "a dump larger than a pipe buffer"
setup
touch "$SB/state/large-dump"
backup
assert_status "is verified and written (pg_restore --list stops reading after the table of contents)" 0 "$STATUS"
assert_eq "status says ok" ok "$(jqs .lastResult)"
dumps=$(ls "$SB/backups"/ai_discovery-*.dump.age 2>/dev/null | wc -l | tr -d ' ')
assert_eq "and the dump is kept" 1 "$dumps"
teardown

echo "pg_dump fails"
setup
touch "$SB/state/pgdump-fails"
backup
assert_status "exits non-zero" 1 "$STATUS"
assert_eq "no dump file is left" 0 "$(nfiles 'ai_discovery*')"
assert_eq "no .part file is left" 0 "$(nfiles '*.part')"
assert_eq "status says failed" failed "$(jqs .lastResult)"
assert_contains "and why" "$(jqs .error)" "pg_dump failed"
health
assert_status "the healthcheck flips to unhealthy" 1 "$HSTATUS"
assert_contains "and says the backup failed" "$HOUT" "last backup failed"
rm "$SB/state/pgdump-fails"
backup
assert_status "the next good run exits 0" 0 "$STATUS"
health
assert_status "and the healthcheck recovers" 0 "$HSTATUS"
assert_eq "and the error is cleared" null "$(jqs .error)"
teardown

echo "a dump that does not read back is not a backup"
setup
touch "$SB/state/restore-lists-fail"
backup
assert_status "exits non-zero" 1 "$STATUS"
assert_eq "the unreadable dump is removed" 0 "$(nfiles '*dump*')"
assert_contains "and the failure says so" "$(jqs .error)" "did not decrypt and list back"
teardown

echo "age of the last success, and the scheduler"
setup
backup
now=$(date +%s)
jq --argjson e "$((now - 30 * 3600))" '.lastSuccessEpoch = $e' "$SB/ops/status/backup.json" >"$SB/ops/status/x" && mv "$SB/ops/status/x" "$SB/ops/status/backup.json"
health
assert_status "a success older than the limit is unhealthy" 1 "$HSTATUS"
assert_contains "and says how old" "$HOUT" "no successful backup for 30 h"
backup
echo "$((now - 900))" >"$SB/heartbeat"
health
assert_status "a dead scheduler is unhealthy even after a good run" 1 "$HSTATUS"
assert_contains "and says so" "$HOUT" "scheduler heartbeat is"
teardown

echo "a fresh install has until the limit for its first backup"
setup
now=$(date +%s)
echo "{\"lastResult\":\"none\",\"startedEpoch\":$((now - 600))}" >"$SB/ops/status/backup.json"
health
assert_status "is healthy ten minutes in" 0 "$HSTATUS"
echo "{\"lastResult\":\"none\",\"startedEpoch\":$((now - 40 * 3600))}" >"$SB/ops/status/backup.json"
health
assert_status "is unhealthy forty hours in with no backup" 1 "$HSTATUS"
rm "$SB/ops/status/backup.json"
health
assert_status "is unhealthy with no status file at all" 1 "$HSTATUS"
teardown

echo "offsite copy"
setup
export RCLONE_REMOTE="offsite:aidp-test"
backup
assert_status "exits 0" 0 "$STATUS"
assert_contains "copies the dump to daily" "$(cat "$SB/rclone.log")" "copy $SB/backups/ai_discovery-"
assert_contains "to the remote" "$(cat "$SB/rclone.log")" "offsite:aidp-test/daily/"
assert_contains "and prunes the remote by age" "$(cat "$SB/rclone.log")" "delete --min-age 30d offsite:aidp-test/daily/"
assert_eq "status says offsite ok" ok "$(jqs .offsite)"
touch "$SB/state/rclone-fails"
backup
assert_status "an offsite failure does not fail the local backup" 0 "$STATUS"
assert_eq "last result stays ok" ok "$(jqs .lastResult)"
assert_eq "but offsite is failed" failed "$(jqs .offsite)"
alert=$(ls "$SB/ops/alerts"/backup.offsite_failed-*.json 2>/dev/null | head -n1)
assert_contains "and an alert file for the sidecar is written" "$(cat "$alert" 2>/dev/null)" '"kind":"backup.offsite_failed"'
assert_contains "with the severity" "$(cat "$alert" 2>/dev/null)" '"severity":"critical"'
teardown

echo "refusals"
setup
unset BACKUP_AGE_RECIPIENT
backup
assert_status "no recipient, no backup" 1 "$STATUS"
assert_contains "and it says how to get one" "$OUT" "ensure-backup-key.sh"
export BACKUP_AGE_RECIPIENT="age1testrecipienttestrecipienttestrecipienttestrecipienttest"
export UPLOAD_DIR="$SB/does-not-exist"
backup
assert_status "a missing uploads directory fails the run" 1 "$STATUS"
assert_eq "status says failed" failed "$(jqs .lastResult)"
teardown

finish
