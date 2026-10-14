#!/bin/bash
# The restore drill (D-227): restores the newest backup into a scratch database, compares what came
# back with the manifest taken when the dump was written, and drops the scratch database.
#
# Why it exists: a backup that has never been restored is a hope. `backup.sh` already proves the
# dump decrypts and its table of contents reads; this proves it *restores*, to the same numbers,
# every week, without anyone remembering to. It runs in the backup container (the server's own
# Postgres major, age, jq), on the schedule in `backup.sh`, or by hand:
#
#   deploy/dc exec -T backup /usr/local/bin/restore-drill.sh
#
# It never touches the live database: the scratch one is `ai_discovery_drill` and is dropped on
# the way out, whatever happened. The live uploads volume is never written; the uploads archive is
# only listed.
#
# What it checks, against `ai_discovery-<stamp>.manifest.json` written beside the dump:
#   * the dump decrypts and pg_restore completes with no error;
#   * every table in the manifest has at least as many rows as when the dump began (a dump taken
#     from a live database may hold rows written after the counts; fewer is the failure that
#     matters);
#   * the uploads archive of the same stamp decrypts and lists exactly the files the manifest
#     counted.
#
# On a mismatch or a failure it writes `drill.result = failed` and the reason into the status file
# and an alert file for ops-notify (`backup.drill_failed`, critical); the worker's health sweep
# raises the same alert from the status file. On success it records the run and its duration, which
# is the measured RTO of a restore on this host.
#
#   PGURL                  owner connection string (the live database's)
#   PGADMIN_URL            connection used to create and drop the scratch database; default: PGURL
#                          with the database name replaced by `postgres`
#   BACKUP_DRILL_DB        scratch database name, default ai_discovery_drill
#   BACKUP_DIR             default /backups
#   BACKUP_AGE_IDENTITY    required: a drill cannot decrypt without it
#   OPS_STATE_DIR          default /ops-state
set -uo pipefail

: "${PGURL:?restore-drill: PGURL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
OPS_STATE_DIR="${OPS_STATE_DIR:-/ops-state}"
BACKUP_AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"
DRILL_DB="${BACKUP_DRILL_DB:-ai_discovery_drill}"
STATUS_FILE="$OPS_STATE_DIR/status/backup.json"
ALERT_DIR="$OPS_STATE_DIR/alerts"
PGADMIN_URL="${PGADMIN_URL:-${PGURL%/*}/postgres}"
DRILL_URL="${PGURL%/*}/$DRILL_DB"

LOG_PREFIX=restore-drill
# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"

started=$(date +%s)
id_file=""
scratch_created=0
dump_name=""

cleanup() {
	[ -z "$id_file" ] || rm -f "$id_file"
	if [ "$scratch_created" = 1 ]; then
		psql "$PGADMIN_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$DRILL_DB\"" >/dev/null 2>&1 \
			|| log "WARNING: could not drop the scratch database $DRILL_DB"
	fi
}
trap cleanup EXIT

fail_drill() {
	local reason=$1
	log "FAILED: $reason"
	# `status_merge` merges at the top level, so the drill object is merged by hand: a failure must
	# not erase when the drill last succeeded.
	local prior
	prior=$(jq -c '.drill // {}' "$STATUS_FILE" 2>/dev/null || echo '{}')
	status_merge "$(jq -cn --argjson prior "$prior" --arg at "$(iso)" --arg err "$reason" --arg dump "$dump_name" \
		--argjson dur "$(($(date +%s) - started))" \
		'{drill:($prior + {at:$at,result:"failed",error:$err,dump:$dump,durationS:$dur})}')"
	emit_alert backup.drill_failed critical "Restore drill failed" \
		"The weekly restore drill could not restore the newest backup to its manifest: $reason. See docs/OPERATIONS.md#backupdrill_failed."
	exit 1
}

# ---- what to restore --------------------------------------------------------------------------

dump=$(ls -1t "$BACKUP_DIR"/ai_discovery-*.dump.age 2>/dev/null | head -n1)
[ -n "$dump" ] || fail_drill "there is no encrypted dump in $BACKUP_DIR to restore"
dump_name=$(basename "$dump")
stamp=${dump_name#ai_discovery-}
stamp=${stamp%.dump.age}
log "restoring $dump_name into $DRILL_DB"

[ -n "$BACKUP_AGE_IDENTITY" ] || fail_drill "BACKUP_AGE_IDENTITY is not set, so the dump cannot be decrypted"

manifest="$BACKUP_DIR/ai_discovery-$stamp.manifest.json"
if [ ! -f "$manifest" ]; then
	# Dumps written before manifests were sidecar files: the status file describes the newest one.
	if [ "$(jq -r '.dump // empty' "$STATUS_FILE" 2>/dev/null)" = "$dump_name" ]; then
		manifest=$(mktemp)
		jq -c '{dump:.dump,counts:.counts,uploadsCount:.uploadsCount}' "$STATUS_FILE" >"$manifest"
	else
		fail_drill "no manifest for $dump_name: nothing to compare the restore against"
	fi
fi
jq -e '.counts | type == "object"' "$manifest" >/dev/null 2>&1 || fail_drill "the manifest for $dump_name has no row counts"

# ---- restore ----------------------------------------------------------------------------------

id_file=$(identity_file)

psql "$PGADMIN_URL" -v ON_ERROR_STOP=1 -qc "drop database if exists \"$DRILL_DB\"" >/dev/null 2>&1 \
	|| fail_drill "could not reach the database server to prepare the scratch database"
psql "$PGADMIN_URL" -v ON_ERROR_STOP=1 -qc "create database \"$DRILL_DB\"" >/dev/null 2>&1 \
	|| fail_drill "could not create the scratch database $DRILL_DB"
scratch_created=1

# --no-owner: roles are cluster-wide and the scratch copy needs none of them. A restore that logs
# errors but carries on is not a restore, so any error fails the drill.
err=$(mktemp)
if ! age -d -i "$id_file" <"$dump" 2>"$err" | pg_restore --no-owner --exit-on-error --dbname="$DRILL_URL" 2>>"$err"; then
	reason=$(tr '\n' ' ' <"$err" | cut -c1-300)
	rm -f "$err"
	fail_drill "decrypting and restoring $dump_name failed: ${reason:-no output}"
fi
rm -f "$err"

# ---- compare ----------------------------------------------------------------------------------

restored=$(manifest_counts "$DRILL_URL" 2>/dev/null) || fail_drill "could not count the restored rows"
mismatch=$(jq -rn --argjson want "$(jq -c .counts "$manifest")" --argjson got "$restored" '
	[$want | to_entries[] | select(($got[.key] // -1) < .value)
	 | "\(.key): \($got[.key] // "missing") restored vs \(.value) in the manifest"] | join("; ")')
[ -z "$mismatch" ] || fail_drill "row counts do not match the manifest: $mismatch"

# The uploads archive of the same stamp: it must decrypt and list as many files as were counted.
want_uploads=$(jq -r '.uploadsCount // 0' "$manifest")
archive="$BACKUP_DIR/uploads-$stamp.tar.gz.age"
if [ -f "$archive" ]; then
	got_uploads=$(archive_file_count "$archive" "$id_file") || fail_drill "the uploads archive $(basename "$archive") did not decrypt and list"
	[ "$got_uploads" = "$want_uploads" ] \
		|| fail_drill "the uploads archive holds $got_uploads files, the manifest counted $want_uploads"
elif [ "$want_uploads" != 0 ]; then
	fail_drill "the manifest counted $want_uploads uploaded files but $(basename "$archive") is missing"
else
	got_uploads=0
fi

# ---- record -----------------------------------------------------------------------------------

duration=$(($(date +%s) - started))
prior=$(jq -c '.drill // {}' "$STATUS_FILE" 2>/dev/null || echo '{}')
status_merge "$(jq -cn --argjson prior "$prior" --arg at "$(iso)" --arg dump "$dump_name" \
	--argjson dur "$duration" --argjson counts "$restored" --argjson uploads "$got_uploads" \
	'{drill:($prior + {at:$at,result:"ok",error:null,dump:$dump,durationS:$dur,lastSuccessAt:$at,
	   restoredCounts:$counts,uploadsCount:$uploads})}')"
log "ok: $dump_name restored in ${duration}s, counts match the manifest, $got_uploads uploaded files in the archive"
exit 0
