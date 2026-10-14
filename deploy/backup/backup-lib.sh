#!/bin/bash
# Functions shared by backup.sh and restore-drill.sh (D-95, D-227). Sourced, never run.
#
# The caller sets, before sourcing: OPS_STATE_DIR, STATUS_FILE, ALERT_DIR and PGURL. Nothing here
# reads the environment at source time, so a test can set them per case.

log() { echo "${LOG_PREFIX:-backup}: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

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

# The tables whose row counts are the manifest of a dump. One query, so the numbers are one
# snapshot. restore-drill.sh runs this same function against the restored copy, so the two sides
# of the comparison cannot drift apart. $1 is the connection string.
manifest_counts() {
	psql "$1" -tA -v ON_ERROR_STOP=1 -c "select json_build_object(
	  'Company', (select count(*) from \"Company\"),
	  'User', (select count(*) from \"User\"),
	  'Campaign', (select count(*) from \"Campaign\"),
	  'Session', (select count(*) from \"Session\"),
	  'Message', (select count(*) from \"Message\"),
	  'Fact', (select count(*) from \"Fact\"),
	  'Attachment', (select count(*) from \"Attachment\"),
	  'LlmCall', (select count(*) from \"LlmCall\"))"
}

# How many uploaded files an encrypted archive holds, read back from the archive itself: the same
# rule backup.sh used to count the volume (regular files, not the `.type` sidecars or half-written
# `.part` files). $1 is the archive, $2 an age identity file. Prints a number; non-zero exit when
# the archive cannot be decrypted and listed.
archive_file_count() {
	local out
	out=$(age -d -i "$2" <"$1" | tar -tzf - 2>/dev/null) || return 1
	printf '%s\n' "$out" | grep -v '/$' | grep -v '\.type$' | grep -v '\.part$' | grep -c . || true
}

# Writes the identity to a private temp file and prints its path; the caller removes it.
identity_file() {
	local id
	id=$(mktemp)
	chmod 600 "$id"
	printf '%s\n' "$BACKUP_AGE_IDENTITY" >"$id"
	printf '%s' "$id"
}
