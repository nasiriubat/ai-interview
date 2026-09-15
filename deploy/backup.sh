#!/bin/bash
# Nightly pg_dump into the `backups` volume, with pruning and a line of log per run.
#
# Runs in the same pgvector/pgvector:pg16 image as the server, so pg_dump always matches the
# server major version. Custom format (-Fc) because it is compressed, and because pg_restore can
# then restore selectively and in parallel.
#
#   BACKUP_AT               HH:MM, container clock (UTC in the image), default 03:20
#   BACKUP_RETENTION_DAYS   dumps older than this are deleted after a successful run, default 14
#   BACKUP_DIR              where the dumps land, default /backups
#   PGURL                   owner connection string
#
# `backup.sh once` takes one dump and exits — that is the on-demand backup the runbook uses.
set -euo pipefail

: "${PGURL:?backup: PGURL is required}"
BACKUP_DIR="${BACKUP_DIR:-/backups}"
BACKUP_AT="${BACKUP_AT:-03:20}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
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

	pruned=$(find "$BACKUP_DIR" -maxdepth 1 -name 'ai_discovery-*.dump' -mtime "+$BACKUP_RETENTION_DAYS" -print -delete | wc -l)
	kept=$(find "$BACKUP_DIR" -maxdepth 1 -name 'ai_discovery-*.dump' | wc -l)
	log "pruned $(echo "$pruned" | tr -d ' ') older than ${BACKUP_RETENTION_DAYS}d, $(echo "$kept" | tr -d ' ') dumps kept, $(du -sh "$BACKUP_DIR" | cut -f1) on disk"
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
