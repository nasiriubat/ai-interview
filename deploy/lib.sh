#!/bin/bash
# Shared by deploy/upgrade.sh and deploy/rollback.sh. Sourced, not run.
#
# Everything that touches the running stack goes through `dcx`, so the two scripts agree on the
# compose file, the env files and the project, and so a test can stand a fake `docker` in front
# of both (deploy/test/release.test.sh).

here="${AIDP_DEPLOY_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
compose_file="${COMPOSE_FILE_PATH:-$here/compose.prod.yml}"
env_file="${ENV_FILE_PATH:-$here/.env}"
versions_file="${VERSIONS_FILE_PATH:-$here/versions.env}"
DRY_RUN="${DRY_RUN:-0}"

say() { echo "release: $*"; }
warn() { echo "release: WARNING: $*" >&2; }
die() {
	echo "release: $*" >&2
	exit 1
}

# `docker compose` for this stack. AIDP_VERSION (the image tag) comes from the environment when a
# script is about to write versions.env, and from the file otherwise.
dcx() {
	local args=(-f "$compose_file" --env-file "$env_file")
	[ -f "$versions_file" ] && args+=(--env-file "$versions_file")
	docker compose "${args[@]}" "$@"
}

# Runs a command that changes something, or only says what it would run under --dry-run.
act() {
	if [ "$DRY_RUN" = 1 ]; then
		echo "release: [dry-run] $*"
		return 0
	fi
	"$@"
}

# Reads KEY from a KEY=value file; empty when absent.
kv_get() {
	local file=$1 key=$2
	[ -f "$file" ] || return 0
	# A missing key is an empty answer, not a failure: under `set -e -o pipefail` grep's exit 1
	# would otherwise end the calling script silently.
	{ grep -E "^$key=" "$file" || true; } | tail -n1 | cut -d= -f2-
}

# Rewrites versions.env as a whole. It is a record written by these scripts, never edited by hand,
# so it is replaced rather than patched; the old one is kept as .previous for the failure paths.
write_versions() {
	local version=$1 previous=$2 dump=$3 tmp
	[ "$DRY_RUN" = 1 ] && {
		echo "release: [dry-run] write $versions_file (AIDP_VERSION=$version AIDP_PREVIOUS_VERSION=$previous)"
		return 0
	}
	[ -f "$versions_file" ] && cp "$versions_file" "$versions_file.previous"
	tmp="$versions_file.tmp.$$"
	{
		echo "# Written by deploy/upgrade.sh and deploy/rollback.sh. Do not edit: it is the record of what runs."
		echo "AIDP_VERSION=$version"
		echo "AIDP_PREVIOUS_VERSION=$previous"
		echo "AIDP_PREUPGRADE_DUMP=$dump"
		echo "AIDP_SWITCHED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	} >"$tmp"
	mv "$tmp" "$versions_file"
}

restore_versions() {
	[ "$DRY_RUN" = 1 ] && return 0
	if [ -f "$versions_file.previous" ]; then
		mv "$versions_file.previous" "$versions_file"
	else
		rm -f "$versions_file"
	fi
}

project_name() {
	local p
	p=$(kv_get "$env_file" COMPOSE_PROJECT_NAME)
	echo "${p:-aidp}"
}

# The id of a running container of this project's service, found by label and not through
# compose. Compose cannot parse this file until AIDP_VERSION and the backup key exist, which is
# exactly the situation of an install being upgraded for the first time, and "compose cannot tell
# me" must never be read as "nothing is running": that would skip the backup of a live system.
container_of() {
	docker ps --filter "label=com.docker.compose.project=$(project_name)" \
		--filter "label=com.docker.compose.service=$1" --format '{{.ID}}' 2>/dev/null | head -n1
}

service_running() {
	[ -n "$(container_of "$1")" ]
}

maintenance() {
	local state=$1 id # on | off
	id=$(container_of caddy)
	[ -n "$id" ] || return 0
	case "$state" in
	on) act docker exec "$id" sh -c 'mkdir -p /maintenance && : > /maintenance/on' || warn "could not switch the maintenance page on" ;;
	off) act docker exec "$id" sh -c 'rm -f /maintenance/on' || warn "could not switch the maintenance page off; remove /maintenance/on in the caddy container" ;;
	esac
}

# Waits until every named service reports healthy (or running, for one with no healthcheck).
wait_healthy() {
	local timeout=$1 deadline name id status
	shift
	[ "$DRY_RUN" = 1 ] && return 0
	deadline=$(($(date +%s) + timeout))
	for name in "$@"; do
		while :; do
			id=$(dcx ps -q "$name" 2>/dev/null | head -n1)
			status=""
			[ -n "$id" ] && status=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$id" 2>/dev/null || true)
			case "$status" in healthy | running) break ;; esac
			[ "$(date +%s)" -lt "$deadline" ] || {
				warn "$name is '${status:-missing}' after ${timeout}s"
				return 1
			}
			sleep 3
		done
	done
}

# The checks that say the switch worked: the API answers readiness with a live database, the web
# app answers, and Caddy serves the sign-in page. Each is a thing a participant would hit.
smoke() {
	local host port scheme code insecure=()
	[ "$DRY_RUN" = 1 ] && return 0
	dcx exec -T api node -e "fetch('http://127.0.0.1:4000/api/v1/health/ready').then(async r=>{const b=await r.json();process.exit(r.ok&&b.database===true?0:1)},()=>process.exit(1))" ||
		{ warn "api readiness check failed"; return 1; }
	dcx exec -T web node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))" ||
		{ warn "web health check failed"; return 1; }
	host=$(kv_get "$env_file" PUBLIC_HOSTNAME)
	port=$(kv_get "$env_file" HTTPS_PORT)
	port="${port:-443}"
	scheme=https
	# Caddy's own CA for a test install is not in anyone's trust store.
	insecure=(-k)
	code=$(curl -sS "${insecure[@]}" --max-time 15 -o /dev/null -w '%{http_code}' \
		--resolve "$host:$port:127.0.0.1" "$scheme://$host:$port/auth/signin" 2>/dev/null || echo 000)
	[ "$code" = "200" ] || { warn "https://$host/auth/signin answered $code through Caddy"; return 1; }
	return 0
}
