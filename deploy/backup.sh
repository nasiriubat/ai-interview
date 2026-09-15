#!/bin/bash
# Nightly backup into the `backups` volume: the database, and the uploaded files beside it.
#
# Runs in the same pgvector/pgvector:pg16 image as the server, so pg_dump always matches the
# server major version. Custom format (-Fc) because it is compressed, and because pg_restore can
# then restore selectively and in parallel.
#
# The uploads matter as much as the rows. Recorded audio and attached documents live on a volume,
# not in Postgres, so a database-only backup would restore a system whose Attachment rows all
# point at bytes that are gone — and nothing would say so until somebody pressed play. The two are
# taken in the same run, with the same timestamp, so a restore can pick a matching pair.
#
#   BACKUP_AT               HH:MM, container clock (UTC in the image), default 03:20
#   BACKUP_RETENTION_DAYS   dumps older than this are deleted after a successful run, default 14
#   BACKUP_DIR              where the dumps land, default /backups
#   UPLOAD_DIR              the uploads volume, mounted read-only; unset skips the file archive
#   PGURL                   owner connection string
#
# `backup.sh once` takes one backup and exits — that is the on-demand backup the runbook uses.
set -euo pipefail

: "${PGURL:?backup: PGURL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_AT="${BACKUP_AT:-03:20}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
HEARTBEAT=/run/backup-alive

log() { echo "backup: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }

run_backup() {
	mkdir -p "$BACKUP_DIR"
	stamp=$(date -u +%Y%m%dT%H%M%SZ)
	target="$BACKUP_DIR/ai_discovery-$stamp.dump"
	started=$(date +%s)
	log "starting dump -> $(basename "$target")"
	# Write to .part first: a half-written file must never look like a restorable dump.
	if ! pg_dump --format=custom --compress=6 --no-owner --file="$target.part" "$PGURL"; then
		rm -f "$target.part"
		log "FAILED: pg_dump returned non-zero; no dump written"
		return 1
	fi
	mv "$target.part" "$target"
	size=$(du -h "$target" | cut -f1)
	log "done in $(($(date +%s) - started))s, $size, $(basename "$target")"

	backup_uploads "$stamp" || return 1

	pruned=$(find "$BACKUP_DIR" -maxdepth 1 \( -name 'ai_discovery-*.dump' -o -name 'uploads-*.tar.gz' \) -mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l)
	kept=$(find "$BACKUP_DIR" -maxdepth 1 -name 'ai_discovery-*.dump' | wc -l)
	log "pruned $(echo "$pruned" | tr -d ' ') older than ${BACKUP_RETENTION_DAYS}d, $(echo "$kept" | tr -d ' ') dumps kept, $(du -sh "$BACKUP_DIR" | cut -f1) on disk"
}

# The uploaded bytes, in one tarball stamped to match the dump taken moments earlier.
#
# An empty archive is still written when there are no uploads yet. That is deliberate: "no file
# archive for this date" should mean the backup did not run, not that the system happened to be
# quiet, and a restore should never have to guess which of the two it is looking at.
backup_uploads() {
	stamp=$1
	if [ -z "$UPLOAD_DIR" ]; then
		log "no UPLOAD_DIR set; skipping the file archive (uploads are NOT backed up)"
		return 0
	fi
	if [ ! -d "$UPLOAD_DIR" ]; then
		log "FAILED: UPLOAD_DIR $UPLOAD_DIR is not a directory; no file archive written"
		return 1
	fi
	target="$BACKUP_DIR/uploads-$stamp.tar.gz"
	started=$(date +%s)
	count=$(find "$UPLOAD_DIR" -type f ! -name '*.type' ! -name '*.part' | wc -l | tr -d ' ')
	log "archiving $count uploaded file(s) -> $(basename "$target")"
	if ! tar -czf "$target.part" -C "$UPLOAD_DIR" .; then
		rm -f "$target.part"
		log "FAILED: tar returned non-zero; no file archive written"
		return 1
	fi
	mv "$target.part" "$target"
	log "done in $(($(date +%s) - started))s, $(du -h "$target" | cut -f1), $(basename "$target")"
}

if [ "${1:-loop}" = "once" ]; then
	run_backup
	exit $?
fi

log "scheduler up: nightly at $BACKUP_AT UTC, keeping ${BACKUP_RETENTION_DAYS} days in $BACKUP_DIR"
touch "$HEARTBEAT"

while true; do
	now=$(date -u +%s)
	next=$(date -u -d "today $BACKUP_AT" +%s)
	[ "$next" -le "$now" ] && next=$(date -u -d "tomorrow $BACKUP_AT" +%s)
	log "next run in $(((next - now) / 60)) minutes"
	# Sleep in one-minute slices so the healthcheck heartbeat stays fresh and a `docker stop`
	# is not waiting out a multi-hour sleep.
	while [ "$(date -u +%s)" -lt "$next" ]; do
		touch "$HEARTBEAT"
		sleep 60
	done
	run_backup || log "continuing; the next scheduled run will try again"
	touch "$HEARTBEAT"
done
