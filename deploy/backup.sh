#!/bin/bash
# Backup of the database and the uploaded files, encrypted, verified, reported, and optionally
# copied offsite (D-95).
#
# Runs in the aidp-backup image (deploy/backup.Dockerfile): the server's own Postgres major, so
# pg_dump always matches, plus age, rclone and jq. Custom format (-Fc) because it is compressed and
# because pg_restore can restore selectively and in parallel.
#
# What a run produces, all stamped identically so a restore can pick a matching pair:
#   ai_discovery-<stamp>.dump.age   pg_dump, encrypted to BACKUP_AGE_RECIPIENT, never in clear on disk
#   uploads-<stamp>.tar.gz.age      the uploads volume at the same moment, encrypted the same way
# and, after every run, /ops-state/status/backup.json: the one place that says whether the last
# backup worked. The container healthcheck, the worker's health sweep and the ops-notify sidecar
# all read it, so "the backup loop is alive" can no longer be mistaken for "the backup succeeded".
#
#   BACKUP_AT                 HH:MM, or a comma list (03:20,15:20), container clock (UTC)
#   BACKUP_RETENTION_DAYS     local files older than this are deleted after a good run, default 14
#   BACKUP_DIR                where they land, default /backups
#   UPLOAD_DIR                the uploads volume, read-only; unset skips the file archive
#   PGURL                     owner connection string
#   BACKUP_AGE_RECIPIENT      age1... public key; required, there is no unencrypted mode
#   BACKUP_AGE_IDENTITY       AGE-SECRET-KEY-...; when set, each dump is decrypted and its table of
#                             contents read before the run is called good
#   OPS_STATE_DIR             the shared status volume, default /ops-state
#   RCLONE_REMOTE             e.g. s3:aidp-backups; unset means no offsite copy (and says so)
#   RCLONE_*                  rclone reads its remote's configuration from these
#
#   BACKUP_DRILL              off to disable the weekly restore drill (default on)
#   BACKUP_DRILL_DAY          ISO weekday of the drill, 1 (Monday) to 7 (Sunday), default 7
#   BACKUP_DRILL_AT           HH:MM of the drill on that day, container clock (UTC), default 04:40
#
# `backup.sh once` takes one backup and exits with its result: what upgrade.sh waits for.
# `backup.sh drill` runs one restore drill now (deploy/restore-drill.sh) and exits with its result.
set -euo pipefail

: "${PGURL:?backup: PGURL is required}"
: "${BACKUP_AGE_RECIPIENT:?backup: BACKUP_AGE_RECIPIENT is required. Run deploy/ensure-backup-key.sh, then copy deploy/.env somewhere safe.}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_AT="${BACKUP_AT:-03:20}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
OPS_STATE_DIR="${OPS_STATE_DIR:-/ops-state}"
RCLONE_REMOTE="${RCLONE_REMOTE:-}"
BACKUP_AGE_IDENTITY="${BACKUP_AGE_IDENTITY:-}"
BACKUP_DRILL="${BACKUP_DRILL:-on}"
BACKUP_DRILL_DAY="${BACKUP_DRILL_DAY:-7}"
BACKUP_DRILL_AT="${BACKUP_DRILL_AT:-04:40}"
HEARTBEAT="${BACKUP_HEARTBEAT_FILE:-/run/backup-alive}"
STATUS_FILE="$OPS_STATE_DIR/status/backup.json"
ALERT_DIR="$OPS_STATE_DIR/alerts"

LOG_PREFIX=backup
# shellcheck source=backup-lib.sh
. "$(dirname "$0")/backup-lib.sh"

# compose passes every RCLONE_CONFIG_OFFSITE_* variable through, empty ones included, because it
# cannot pass them conditionally; rclone would read an empty one as a value. Only the set ones stay.
for _v in $(env | sed -n 's/^\(RCLONE_CONFIG_[A-Za-z0-9_]*\)=$/\1/p'); do unset "$_v"; done

# ---- one run ----------------------------------------------------------------------------------

fail_run() {
	local reason=$1
	log "FAILED: $reason"
	status_merge "$(jq -cn --arg at "$(iso)" --argjson epoch "$(date +%s)" --arg err "$reason" \
		'{lastRunAt:$at,lastRunEpoch:$epoch,lastResult:"failed",error:$err,runningSince:null}')"
	return 1
}

# The manifest is `manifest_counts` (backup-lib.sh): the row counts at the moment of the dump,
# which restore-drill.sh checks a restore against.
table_counts() { manifest_counts "$PGURL"; }

# Decrypts the finished dump and reads its table of contents. A truncated or corrupt archive, or
# one encrypted to a key we do not hold, fails here at 03:20 and not on the day it is needed.
verify_dump() {
	local file=$1 id
	[ -n "$BACKUP_AGE_IDENTITY" ] || { log "no BACKUP_AGE_IDENTITY: written but not verified"; return 0; }
	id=$(identity_file)
	# `pg_restore --list` reads a pipe up to the end of the table of contents and exits. Left like
	# that, `age` is killed by SIGPIPE (status 141) the moment it has more to write than a pipe
	# holds, about 64 KB, and under pipefail that reads as "did not decrypt": every backup past the
	# first few days of a real database failed its own verification (found by the full-stack drill,
	# at a 400 KB dump). The rest of the stream is drained, which also makes this check stronger:
	# age authenticates the whole file, so a truncated or corrupted tail is now caught here too.
	if age -d -i "$id" <"$file" |
		{
			pg_restore --list >/dev/null 2>&1
			listed=$?
			cat >/dev/null
			exit "$listed"
		}; then
		rm -f "$id"
		return 0
	fi
	rm -f "$id"
	return 1
}

run_backup() {
	local stamp started dump counts size uploads_count epoch
	mkdir -p "$BACKUP_DIR"
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	dump="$BACKUP_DIR/ai_discovery-$stamp.dump.age"
	started=$(date +%s)
	log "starting dump -> $(basename "$dump")"
	status_merge "$(jq -cn --arg at "$(iso)" '{runningSince:$at}')"

	counts=$(table_counts 2>/dev/null) || { fail_run "could not read table counts from the database"; return 1; }
	# Written to .part first: a half-written file must never look like a restorable dump. The
	# pipe is under pipefail, so a failing pg_dump fails the run instead of encrypting nothing.
	if ! pg_dump --format=custom --compress=6 --no-owner "$PGURL" | age -r "$BACKUP_AGE_RECIPIENT" >"$dump.part"; then
		rm -f "$dump.part"
		fail_run "pg_dump failed; no dump written"
		return 1
	fi
	mv "$dump.part" "$dump"
	if ! verify_dump "$dump"; then
		rm -f "$dump"
		fail_run "the dump did not decrypt and list back; it was removed"
		return 1
	fi
	size=$(wc -c <"$dump" | tr -d ' ')
	log "dump done in $(($(date +%s) - started))s, ${size} bytes, verified"

	uploads_count=0
	if ! backup_uploads "$stamp"; then
		fail_run "the uploads archive failed; the dump from this run is kept but the pair is incomplete"
		return 1
	fi
	if [ -n "$UPLOAD_DIR" ]; then
		# Counted from the archive itself, not from the volume a moment later: that is the number a
		# restore of this archive must reproduce, exactly, and it proves the archive reads back.
		if [ -n "$BACKUP_AGE_IDENTITY" ]; then
			local id
			id=$(identity_file)
			if ! uploads_count=$(archive_file_count "$BACKUP_DIR/uploads-$stamp.tar.gz.age" "$id"); then
				rm -f "$id"
				fail_run "the uploads archive did not decrypt and list back"
				return 1
			fi
			rm -f "$id"
		else
			uploads_count=$(find "$UPLOAD_DIR" -type f ! -name '*.type' ! -name '*.part' | wc -l | tr -d ' ')
		fi
	fi
	# The manifest travels with the dump (and offsite with it), so the drill can check any dump, not
	# only the one the status file happens to describe.
	jq -cn --argjson counts "$counts" --argjson uploads "$uploads_count" --arg dump "$(basename "$dump")" \
		'{dump:$dump,counts:$counts,uploadsCount:$uploads}' >"${dump%.dump.age}.manifest.json"

	epoch=$(date +%s)
	status_merge "$(jq -cn --arg at "$(iso)" --argjson epoch "$epoch" --arg dump "$(basename "$dump")" \
		--argjson size "$size" --argjson counts "$counts" --argjson uploads "$uploads_count" \
		--argjson dur "$((epoch - started))" \
		'{lastRunAt:$at,lastRunEpoch:$epoch,lastResult:"ok",lastSuccessAt:$at,lastSuccessEpoch:$epoch,
		  dump:$dump,sizeBytes:$size,counts:$counts,uploadsCount:$uploads,durationSeconds:$dur,
		  encrypted:true,error:null,runningSince:null}')"

	prune_local
	offsite_copy "$stamp" || true
}

# The uploaded bytes, in one archive stamped to match the dump taken moments earlier.
#
# An empty archive is still written when there are no uploads yet. That is deliberate: "no file
# archive for this date" should mean the backup did not run, not that the system happened to be
# quiet, and a restore should never have to guess which of the two it is looking at.
backup_uploads() {
	local stamp=$1 target started
	if [ -z "$UPLOAD_DIR" ]; then
		log "no UPLOAD_DIR set; skipping the file archive (uploads are NOT backed up)"
		return 0
	fi
	if [ ! -d "$UPLOAD_DIR" ]; then
		log "FAILED: UPLOAD_DIR $UPLOAD_DIR is not a directory; no file archive written"
		return 1
	fi
	target="$BACKUP_DIR/uploads-$stamp.tar.gz.age"
	started=$(date +%s)
	if ! tar -C "$UPLOAD_DIR" -czf - . | age -r "$BACKUP_AGE_RECIPIENT" >"$target.part"; then
		rm -f "$target.part"
		log "FAILED: the file archive could not be written"
		return 1
	fi
	mv "$target.part" "$target"
	log "archive done in $(($(date +%s) - started))s, $(wc -c <"$target" | tr -d ' ') bytes, $(basename "$target")"
}

prune_local() {
	local pruned kept
	pruned=$(find "$BACKUP_DIR" -maxdepth 1 \
		\( -name 'ai_discovery-*.dump.age' -o -name 'uploads-*.tar.gz.age' -o -name 'ai_discovery-*.dump' -o -name 'uploads-*.tar.gz' -o -name 'ai_discovery-*.manifest.json' \) \
		-mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l | tr -d ' ')
	kept=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'ai_discovery-*.dump.age' -o -name 'ai_discovery-*.dump' \) | wc -l | tr -d ' ')
	log "pruned $pruned older than ${BACKUP_RETENTION_DAYS}d, $kept dumps kept"
}

# The offsite copy, gated on RCLONE_REMOTE. A failure here is its own alert and its own field in
# the status file, and does not turn a good local backup into a failed one: the two are different
# repairs, and the operator should know which half is broken.
offsite_copy() {
	local stamp=$1 dow dom f ok=1
	if [ -z "$RCLONE_REMOTE" ]; then
		status_merge '{"offsite":"not_configured"}'
		return 0
	fi
	dow=$(date -u +%u)
	dom=$(date -u +%d)
	for f in "$BACKUP_DIR/ai_discovery-$stamp.dump.age" "$BACKUP_DIR/uploads-$stamp.tar.gz.age" "$BACKUP_DIR/ai_discovery-$stamp.manifest.json"; do
		[ -f "$f" ] || continue
		rclone copy "$f" "$RCLONE_REMOTE/daily/" || ok=0
		[ "$dow" = "7" ] && { rclone copy "$f" "$RCLONE_REMOTE/weekly/" || ok=0; }
		[ "$dom" = "01" ] && { rclone copy "$f" "$RCLONE_REMOTE/monthly/" || ok=0; }
	done
	if [ "$ok" = 1 ]; then
		# Retention is enforced at the remote too, or the bucket grows for ever.
		rclone delete --min-age 30d "$RCLONE_REMOTE/daily/" >/dev/null 2>&1 || true
		rclone delete --min-age 90d "$RCLONE_REMOTE/weekly/" >/dev/null 2>&1 || true
		rclone delete --min-age 400d "$RCLONE_REMOTE/monthly/" >/dev/null 2>&1 || true
		status_merge "$(jq -cn --arg at "$(iso)" '{offsite:"ok",offsiteAt:$at,offsiteLastSuccessAt:$at}')"
		log "offsite copy done to $RCLONE_REMOTE"
		return 0
	fi
	status_merge "$(jq -cn --arg at "$(iso)" '{offsite:"failed",offsiteAt:$at}')"
	emit_alert backup.offsite_failed critical "Offsite backup copy failed" \
		"The local backup is good but copying it to $RCLONE_REMOTE failed, so there is no copy off this host. See docs/OPERATIONS.md#backupoffsite_failed."
	log "FAILED: offsite copy to $RCLONE_REMOTE"
	return 1
}

# ---- entry points -----------------------------------------------------------------------------

# Seconds until the next scheduled time among a comma list of HH:MM.
next_run_epoch() {
	local now best="" t e
	now=$(date -u +%s)
	for t in ${BACKUP_AT//,/ }; do
		e=$(date -u -d "today $t" +%s)
		[ "$e" -le "$now" ] && e=$(date -u -d "tomorrow $t" +%s)
		if [ -z "$best" ] || [ "$e" -lt "$best" ]; then best=$e; fi
	done
	echo "$best"
}

# The weekly restore drill (D-227), in its own script so it can also be run by hand.
run_drill() {
	local ticker rc
	# A drill of a large dump outlasts the heartbeat's allowance; keep it fresh from the side so the
	# healthcheck does not call a busy container dead.
	( while :; do date +%s >"$HEARTBEAT"; sleep 30; done ) &
	ticker=$!
	"$(dirname "$0")/restore-drill.sh"
	rc=$?
	kill "$ticker" 2>/dev/null || true
	return $rc
}

# Epoch of the next drill: the next BACKUP_DRILL_DAY (ISO weekday) at BACKUP_DRILL_AT, UTC.
next_drill_epoch() {
	local now today_dow days target
	now=$(date -u +%s)
	today_dow=$(date -u +%u)
	days=$(((BACKUP_DRILL_DAY - today_dow + 7) % 7))
	target=$(date -u -d "today ${BACKUP_DRILL_AT} + ${days} days" +%s)
	[ "$target" -gt "$now" ] || target=$(date -u -d "today ${BACKUP_DRILL_AT} + $((days + 7)) days" +%s)
	echo "$target"
}

case "${1:-loop}" in
once)
	run_backup
	exit $?
	;;
drill)
	"$(dirname "$0")/restore-drill.sh"
	exit $?
	;;
esac

log "scheduler up: at $BACKUP_AT UTC, keeping ${BACKUP_RETENTION_DAYS} days in $BACKUP_DIR, offsite ${RCLONE_REMOTE:-not configured}"
now_epoch=$(date +%s)
status_merge "$(jq -cn --arg at "$(iso)" --argjson e "$now_epoch" '{startedAt:$at,startedEpoch:$e}')"
[ -f "$STATUS_FILE" ] && [ "$(jq -r '.lastResult // empty' "$STATUS_FILE" 2>/dev/null)" ] || status_merge '{"lastResult":"none"}'
date +%s >"$HEARTBEAT"

while true; do
	next=$(next_run_epoch)
	what=backup
	if [ "$BACKUP_DRILL" != "off" ]; then
		drill_at=$(next_drill_epoch)
		if [ "$drill_at" -lt "$next" ]; then
			next=$drill_at
			what=drill
		fi
	fi
	now=$(date -u +%s)
	log "next $what in $(((next - now) / 60)) minutes"
	# Sleep in one-minute slices so the heartbeat stays fresh and a `docker stop` is not waiting
	# out a multi-hour sleep.
	while [ "$(date -u +%s)" -lt "$next" ]; do
		date +%s >"$HEARTBEAT"
		sleep 60
	done
	if [ "$what" = drill ]; then
		run_drill || log "the restore drill failed; see the status file and the alert"
	else
		run_backup || log "continuing; the next scheduled run will try again"
	fi
	date +%s >"$HEARTBEAT"
done
