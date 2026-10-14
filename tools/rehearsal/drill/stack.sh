#!/bin/bash
# Brings the PRODUCTION compose stack up on one machine, with a scripted model and a mail catcher,
# for the full-stack drill, the load tests and the chaos scripts. Test-only; see docs/DEPLOY.md,
# "Rehearsing a deployment".
#
#   tools/rehearsal/drill/stack.sh up          # generate a throwaway env, then deploy/upgrade.sh
#   tools/rehearsal/drill/stack.sh configure   # point the platform at the fake provider (node, over HTTPS)
#   tools/rehearsal/drill/stack.sh env         # print the exports the other drill scripts read (no secrets)
#   tools/rehearsal/drill/stack.sh down        # stop it and remove its containers, volumes and images
#
# Everything lives outside the repository, in $AIDP_DRILL_DIR (default: $TMPDIR/aidpfull), mode 700:
# the generated env file holds throwaway secrets and is never committed or printed. The compose
# project is `aidpfull` and the ports are 18080/18443, so it can share a machine with a development
# stack and with other projects. Local certificates: Caddy issues from its own CA.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
rehearsal=$(cd "$here/.." && pwd)
repo=$(cd "$rehearsal/../.." && pwd)
deploy="$repo/deploy"

drill_dir="${AIDP_DRILL_DIR:-${TMPDIR:-/tmp}/aidpfull}"
drill_dir="${drill_dir%/}"
export AIDP_DRILL_DIR="$drill_dir"
export ENV_FILE_PATH="$drill_dir/env"
export VERSIONS_FILE_PATH="$drill_dir/versions.env"
export COMPOSE_OVERRIDE_FILES="$rehearsal/compose.fake.yml"

HOSTNAME_PUBLIC="${AIDP_DRILL_HOST:-aidp.localhost}"
HTTPS_PORT="${AIDP_DRILL_HTTPS_PORT:-18443}"
HTTP_PORT="${AIDP_DRILL_HTTP_PORT:-18080}"
FAKE_PORT="${AIDP_DRILL_FAKE_PORT:-14010}"
MAILPIT_PORT="${AIDP_DRILL_MAILPIT_PORT:-18025}"
OPERATOR_EMAIL="${AIDP_DRILL_OPERATOR:-operator@aidp.test}"
ADMIN_EMAIL="${AIDP_DRILL_ADMIN:-admin@aidp.test}"

say() { echo "drill: $*"; }
die() { echo "drill: $*" >&2; exit 1; }

# Replaces KEY=... in the env file, or appends it. Values are never echoed.
set_kv() {
	local key=$1 value=$2 tmp="$ENV_FILE_PATH.tmp"
	awk -v k="$key" -v v="$value" 'BEGIN{done=0} $0 ~ "^"k"=" {print k"="v; done=1; next} {print} END{if(!done) print k"="v}' \
		"$ENV_FILE_PATH" >"$tmp"
	mv "$tmp" "$ENV_FILE_PATH"
	chmod 600 "$ENV_FILE_PATH"
}

cmd_env() {
	cat <<EOF
export AIDP_DRILL_DIR='$drill_dir'
export ENV_FILE_PATH='$ENV_FILE_PATH'
export VERSIONS_FILE_PATH='$VERSIONS_FILE_PATH'
export COMPOSE_OVERRIDE_FILES='$COMPOSE_OVERRIDE_FILES'
export AIDP_BASE_URL='https://$HOSTNAME_PUBLIC:$HTTPS_PORT'
export AIDP_RESOLVE_HOST='$HOSTNAME_PUBLIC'
export AIDP_HTTPS_PORT='$HTTPS_PORT'
export AIDP_FAKE_URL='http://127.0.0.1:$FAKE_PORT'
export AIDP_MAILPIT_URL='http://127.0.0.1:$MAILPIT_PORT'
export AIDP_OPERATOR_EMAIL='$OPERATOR_EMAIL'
export AIDP_ADMIN_EMAIL='$ADMIN_EMAIL'
export COMPOSE_PROJECT_NAME=aidpfull
EOF
}

cmd_up() {
	command -v docker >/dev/null || die "docker is required"
	mkdir -p "$drill_dir"
	chmod 700 "$drill_dir"
	if [ ! -e "$ENV_FILE_PATH" ]; then
		"$deploy/generate-env.sh" "$HOSTNAME_PUBLIC" "$OPERATOR_EMAIL" "$ADMIN_EMAIL" >/dev/null
		set_kv COMPOSE_PROJECT_NAME aidpfull
		set_kv CADDY_LOCAL_CERTS 1
		set_kv HTTPS_PORT "$HTTPS_PORT"
		set_kv HTTP_PORT "$HTTP_PORT"
		set_kv FAKE_PROVIDER_PORT "$FAKE_PORT"
		set_kv MAILPIT_PORT "$MAILPIT_PORT"
		set_kv SMTP_HOST mailpit
		set_kv SMTP_PORT 1025
		set_kv SMTP_SECURITY none
		set_kv EMAIL_FROM "no-reply@$HOSTNAME_PUBLIC"
		set_kv EGRESS_ALLOW_HOSTS kroki,fake-provider,mailpit
		set_kv ALERT_EMAIL "ops@aidp.test"
		set_kv ALERT_WEBHOOK_URL http://fake-provider:4010/__sink
		set_kv ALERT_WEBHOOK_FORMAT generic
		# The provider timeouts a drill can reason about: the fake's own latency is a few hundred ms.
		set_kv PROVIDER_FIRST_TOKEN_TIMEOUT_MS 8000
		set_kv PROVIDER_TIMEOUT_MS 30000
		set_kv PROVIDER_MAX_RETRIES 1
		say "wrote $ENV_FILE_PATH (mode 600, not shown)"
	else
		say "reusing $ENV_FILE_PATH"
	fi
	cd "$repo"
	"$deploy/upgrade.sh" --yes "$@"
}

cmd_down() {
	[ -f "$ENV_FILE_PATH" ] || die "no $ENV_FILE_PATH: nothing to take down"
	# -v removes the volumes; --rmi local the images this project built; --remove-orphans the rest.
	"$deploy/dc" down -v --remove-orphans --timeout 30 || true
	local v
	if [ -f "$VERSIONS_FILE_PATH" ]; then
		for v in $(grep -E '^AIDP_(PREVIOUS_)?VERSION=' "$VERSIONS_FILE_PATH" | cut -d= -f2- | sort -u); do
			[ -n "$v" ] || continue
			for image in aidp-server aidp-web aidp-backup aidp-ops-notify aidp-fake-provider; do
				docker image rm -f "$image:$v" >/dev/null 2>&1 || true
			done
		done
	fi
	say "stack taken down; the scratch directory $drill_dir is left for the evidence (rm -rf it when done)"
}

case "${1:-}" in
up) shift; cmd_up "$@" ;;
down) cmd_down ;;
env) cmd_env ;;
# deploy/dc with this drill's env, so `stack.sh dc ps` works from any shell.
dc) shift; export COMPOSE_PROJECT_NAME=aidpfull; exec "$deploy/dc" "$@" ;;
# Any command with the drill's environment: `stack.sh run node tools/rehearsal/drill/interview.mjs`.
run) shift; eval "$(cmd_env)"; exec "$@" ;;
configure) shift; exec node "$here/configure.mjs" "$@" ;;
*) sed -n '2,16p' "$0"; exit 64 ;;
esac
