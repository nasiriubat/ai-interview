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
# `backup.sh once` takes one backup and exits with its result: what upgrade.sh waits for.
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
HEARTBEAT="${BACKUP_HEARTBEAT_FILE:-/run/backup-alive}"
STATUS_FILE="$OPS_STATE_DIR/status/backup.json"
ALERT_DIR="$OPS_STATE_DIR/alerts"

log() { echo "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# compose passes every RCLONE_CONFIG_OFFSITE_* variable through, empty ones included, because it
# cannot pass them conditionally; rclone would read an empty one as a value. Only the set ones stay.
for _v in $(env | sed -n 's/^\(RCLONE_CONFIG_[A-Za-z0-9_]*\)=$/\1/p'); do unset "$_v"; done

# ---- status file ------------------------------------------------------------------------------

# Merges the given jq object into the status file, atomically. An unwritable ops-state volume is
# reported and survived: a backup that cannot say so is still a backup.
status_merge() {
	local patch=$1 current='{}' tmp
	[ -f "$STATUS_FILE" ] && current=$(cat "$STATUS_FILE" 2>/dev/null || echo '{}')
	printf '%s' "$current" | jq -e . >/dev/null 2>&1 || current='{}'
	mkdir -p "$(dirname "$STATUS_FILE")" 2>/dev/null || { log "WARNING: cannot create $(dirname "$STATUS_FILE")"; return 0; }
	tmp="$STATUS_FILE.tmp.$$"
	if printf '%s' "$current" | jq -c --argjson p "$patch" '. + $p' >"$tmp" 2>/dev/null; then
		mv "$tmp" "$STATUS_FILE"
	else
		rm -f "$tmp"
		log "WARNING: could not write $STATUS_FILE"
	fi
}

# A notification for the ops-notify sidecar: the application may be down, so this is a file. The
# field names are those of packages/core/src/alerts/port.ts, and `kind` must be a catalog kind.
emit_alert() {
	local kind=$1 severity=$2 title=$3 message=$4 file
	[ -d "$ALERT_DIR" ] || mkdir -p "$ALERT_DIR" 2>/dev/null || return 0
	file="$ALERT_DIR/$kind-$(date -u +%Y%m%dT%H%M%SZ).json"
	jq -cn --arg kind "$kind" --arg severity "$severity" --arg title "$title" --arg message "$message" \
		--arg at "$(iso)" '{kind:$kind,severity:$severity,key:$kind,title:$title,message:$message,occurredAt:$at}' \
		>"$ALERT_DIR/.tmp.$$" 2>/dev/null && mv "$ALERT_DIR/.tmp.$$" "$file" 2>/dev/null || true
}

# ---- one run ----------------------------------------------------------------------------------

fail_run() {
	local reason=$1
	log "FAILED: $reason"
	status_merge "$(jq -cn --arg at "$(iso)" --argjson epoch "$(date +%s)" --arg err "$reason" \
		'{lastRunAt:$at,lastRunEpoch:$epoch,lastResult:"failed",error:$err,runningSince:null}')"
	return 1
}

# Table counts at the moment of the dump: the manifest the weekly restore drill (and a human) can
# check a restore against. One query, so the numbers are one snapshot.
table_counts() {
	psql "$PGURL" -tA -v ON_ERROR_STOP=1 -c "select json_build_object(
	  'Company', (select count(*) from \"Company\"),
	  'User', (select count(*) from \"User\"),
	  'Campaign', (select count(*) from \"Campaign\"),
	  'Session', (select count(*) from \"Session\"),
	  'Message', (select count(*) from \"Message\"),
	  'Fact', (select count(*) from \"Fact\"),
	  'Attachment', (select count(*) from \"Attachment\"),
	  'LlmCall', (select count(*) from \"LlmCall\"))"
}

# Decrypts the finished dump and reads its table of contents. A truncated or corrupt archive, or
# one encrypted to a key we do not hold, fails here at 03:20 and not on the day it is needed.
verify_dump() {
	local file=$1 id
	[ -n "$BACKUP_AGE_IDENTITY" ] || { log "no BACKUP_AGE_IDENTITY: written but not verified"; return 0; }
	id=$(mktemp)
	chmod 600 "$id"
	printf '%s\n' "$BACKUP_AGE_IDENTITY" >"$id"
	if age -d -i "$id" <"$file" | pg_restore --list >/dev/null 2>&1; then
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
	[ -z "$UPLOAD_DIR" ] || uploads_count=$(find "$UPLOAD_DIR" -type f ! -name '*.type' ! -name '*.part' | wc -l | tr -d ' ')

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
		\( -name 'ai_discovery-*.dump.age' -o -name 'uploads-*.tar.gz.age' -o -name 'ai_discovery-*.dump' -o -name 'uploads-*.tar.gz' \) \
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
	for f in "$BACKUP_DIR/ai_discovery-$stamp.dump.age" "$BACKUP_DIR/uploads-$stamp.tar.gz.age"; do
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
		status_merge "$(jq -cn --arg at "$(iso)" '{offsite:"ok",offsiteAt:$at}')"
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

if [ "${1:-loop}" = "once" ]; then
	run_backup
	exit $?
fi

log "scheduler up: at $BACKUP_AT UTC, keeping ${BACKUP_RETENTION_DAYS} days in $BACKUP_DIR, offsite ${RCLONE_REMOTE:-not configured}"
now_epoch=$(date +%s)
status_merge "$(jq -cn --arg at "$(iso)" --argjson e "$now_epoch" '{startedAt:$at,startedEpoch:$e}')"
[ -f "$STATUS_FILE" ] && [ "$(jq -r '.lastResult // empty' "$STATUS_FILE" 2>/dev/null)" ] || status_merge '{"lastResult":"none"}'
date +%s >"$HEARTBEAT"

while true; do
	next=$(next_run_epoch)
	now=$(date -u +%s)
	log "next run in $(((next - now) / 60)) minutes"
	# Sleep in one-minute slices so the heartbeat stays fresh and a `docker stop` is not waiting
	# out a multi-hour sleep.
	while [ "$(date -u +%s)" -lt "$next" ]; do
		date +%s >"$HEARTBEAT"
		sleep 60
	done
	run_backup || log "continuing; the next scheduled run will try again"
	date +%s >"$HEARTBEAT"
done
