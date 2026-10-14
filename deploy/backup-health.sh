#!/bin/bash
# The backup container's healthcheck (D-95): healthy means the last backup SUCCEEDED and is recent,
# not merely that the scheduler loop is alive.
#
# It used to be the second thing. A pg_dump that failed every night logged one line, the loop
# carried on touching its heartbeat, and the container stayed healthy for as long as nobody read
# the logs. Now a failed run, a missing run, and a dead scheduler each turn `docker compose ps`
# unhealthy and say why in the health log (`docker inspect --format '{{json .State.Health}}'`).
#
#   BACKUP_MAX_AGE_HOURS   a success older than this is "missing", default 26 (a day and a bit)
#   OPS_STATE_DIR          where backup.json lives, default /ops-state
#
# Exit 0 healthy, 1 unhealthy. Uses epochs the writer stored, so no date parsing is needed here.
set -u

OPS_STATE_DIR="${OPS_STATE_DIR:-/ops-state}"
STATUS_FILE="$OPS_STATE_DIR/status/backup.json"
HEARTBEAT="${BACKUP_HEARTBEAT_FILE:-/run/backup-alive}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
HEARTBEAT_MAX_SECONDS="${BACKUP_HEARTBEAT_MAX_SECONDS:-300}"
now=$(date +%s)

unhealthy() {
	echo "unhealthy: $*"
	exit 1
}

# 1. The scheduler is alive. An old heartbeat means the loop is stuck or dead.
[ -f "$HEARTBEAT" ] || unhealthy "no scheduler heartbeat at $HEARTBEAT"
beat=$(cat "$HEARTBEAT" 2>/dev/null || echo 0)
case "$beat" in '' | *[!0-9]*) unhealthy "unreadable scheduler heartbeat" ;; esac
[ $((now - beat)) -lt "$HEARTBEAT_MAX_SECONDS" ] || unhealthy "scheduler heartbeat is $((now - beat))s old"

# 2. The last run worked.
[ -f "$STATUS_FILE" ] || unhealthy "no status file at $STATUS_FILE"
jq -e . "$STATUS_FILE" >/dev/null 2>&1 || unhealthy "status file is not valid JSON"
result=$(jq -r '.lastResult // "none"' "$STATUS_FILE")
if [ "$result" = "failed" ]; then
	unhealthy "last backup failed: $(jq -r '.error // "no reason recorded"' "$STATUS_FILE")"
fi

# 2b. The newest backup restores (D-227). A failed weekly drill means the dump on disk may not be
#     usable, which is as serious as a failed backup and just as invisible without this line.
if [ "$(jq -r '.drill.result // empty' "$STATUS_FILE")" = "failed" ]; then
	unhealthy "last restore drill failed: $(jq -r '.drill.error // "no reason recorded"' "$STATUS_FILE")"
fi

# 3. There has been a success recently. A fresh install has none yet, so it is measured from when
#    the scheduler started: the first scheduled run has the whole limit to happen in.
ref=$(jq -r '.lastSuccessEpoch // .startedEpoch // empty' "$STATUS_FILE")
[ -n "$ref" ] || unhealthy "status file has no success or start time"
age=$((now - ref))
limit=$((MAX_AGE_HOURS * 3600))
[ "$age" -le "$limit" ] || unhealthy "no successful backup for $((age / 3600)) h (limit $MAX_AGE_HOURS h)"

echo "healthy: last result $result, newest success $((age / 60)) min ago"
exit 0
