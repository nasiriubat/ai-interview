#!/bin/bash
# A tiny assertion library and sandbox for the deploy script tests. Sourced by the *.test.sh files.
#
# These tests run the REAL scripts against a fake `docker`, `git`, `curl` and `df` put first on
# PATH, so the sequence of commands a deploy would issue can be asserted, offline, in a second.
# What they do not prove is that Docker does what the fake says; deploy/test/README in
# docs/OPERATIONS.md ("Drills") lists what has to be rehearsed on a real host.

set -u
TESTS=0
FAILS=0
SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DEPLOY_DIR=$(cd "$SCRIPT_DIR/.." && pwd)

pass() { TESTS=$((TESTS + 1)); echo "  ok   $1"; }
fail() {
	TESTS=$((TESTS + 1))
	FAILS=$((FAILS + 1))
	echo "  FAIL $1"
	[ -n "${2:-}" ] && echo "       $2"
}

assert_eq() { # name expected actual
	if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "expected [$2] got [$3]"; fi
}
assert_contains() { # name haystack needle
	case "$2" in *"$3"*) pass "$1" ;; *) fail "$1" "missing [$3] in: $(echo "$2" | tail -n 8)" ;; esac
}
assert_not_contains() { # name haystack needle
	case "$2" in *"$3"*) fail "$1" "unexpected [$3] in: $(echo "$2" | tail -n 8)" ;; *) pass "$1" ;; esac
}
assert_status() { # name expected actual
	if [ "$2" = "$3" ]; then pass "$1"; else fail "$1" "exit status $3, wanted $2"; fi
}
# The line number of the first line of $2 containing $3, or 0.
line_of() { echo "$2" | grep -n -F -- "$3" | head -n1 | cut -d: -f1 | grep . || echo 0; }
assert_before() { # name log first second
	local a b
	a=$(line_of "" "$2" "$3")
	b=$(line_of "" "$2" "$4")
	if [ "$a" != 0 ] && [ "$b" != 0 ] && [ "$a" -lt "$b" ]; then pass "$1"; else fail "$1" "[$3]@$a should come before [$4]@$b"; fi
}

finish() {
	echo
	if [ "$FAILS" -eq 0 ]; then
		echo "$(basename "$0"): $TESTS checks passed"
		exit 0
	fi
	echo "$(basename "$0"): $FAILS of $TESTS checks FAILED"
	exit 1
}

# ---- sandbox ----------------------------------------------------------------------------------

new_sandbox() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-deploy-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/state" "$SB/repo/deploy/ops" "$SB/repo/deploy/lib" "$SB/repo/deploy/backup" "$SB/repo/deploy/images"
	for f in upgrade.sh rollback.sh dc compose.yml lib/lib.sh backup/ensure-backup-key.sh backup/backup.Dockerfile images/ops-notify.Dockerfile; do
		cp "$DEPLOY_DIR/$f" "$SB/repo/deploy/$f"
	done
	chmod +x "$SB/repo/deploy/"*.sh "$SB/repo/deploy/"*/*.sh "$SB/repo/deploy/dc"
	# The one env file is the repository root's (D-450).
	cat >"$SB/repo/.env" <<EOF
COMPOSE_PROJECT_NAME=aidp
PUBLIC_HOSTNAME=pilot.example.com
HTTPS_PORT=443
BACKUP_AGE_RECIPIENT=age1testtesttesttesttesttesttesttesttesttesttesttesttesttesttest
EOF
	echo "aaaaaaaaaaaa" >"$SB/state/sha"
	: >"$SB/state/dirty"
	: >"$SB/state/volumes"
	: >"$SB/state/images"
	: >"$SB/docker.log"
	install_fakes
	export PATH="$SB/bin:$PATH"
	export SB
	export TERM=dumb
}

cleanup_sandbox() { [ -n "${SB:-}" ] && rm -rf "$SB"; }

# The fakes read their behaviour from files in $SB/state, so a test sets a file and not a function.
install_fakes() {
	cat >"$SB/bin/docker" <<'FAKE'
#!/bin/bash
# fake docker: logs every call, answers from $SB/state
echo "docker $*" >>"$SB/docker.log"
state="$SB/state"
has() { [ -e "$state/$1" ]; }
val() { cat "$state/$1" 2>/dev/null; }
version_from_args() {
	if [ -n "${AIDP_VERSION:-}" ]; then echo "$AIDP_VERSION"; return; fi
	local prev="" last=""
	for a in "$@"; do
		[ "$prev" = "--env-file" ] && [ -f "$a" ] && grep -q '^AIDP_VERSION=' "$a" && last=$(grep '^AIDP_VERSION=' "$a" | tail -n1 | cut -d= -f2-)
		prev=$a
	done
	echo "$last"
}
case "$1" in
volume) cat "$state/volumes" ;;
ps)
	svc=""
	for a in "$@"; do case "$a" in label=com.docker.compose.service=*) svc=${a#label=com.docker.compose.service=} ;; esac; done
	has "running-$svc" && echo "cid-$svc"
	exit 0
	;;
exec)
	shift
	cid=$1
	shift
	echo "exec $cid $*" >>"$SB/exec.log"
	case "$*" in
	*"backup.sh once"*)
		echo "backup-once" >>"$SB/events.log"
		if has backup-fails; then exit 1; fi
		exit 0
		;;
	*"jq -r"*) echo "ai_discovery-20261013T100000Z.dump.age"; exit 0 ;;
	*"/maintenance/on"*)
		# The flag is a file in Caddy's volume, and Caddy answers 503 while it exists: the fake curl
		# reads the same state, so a check made while the page is up is seen to fail, as it does.
		case "$*" in
		*"rm -f"*) echo "maintenance-off" >>"$SB/events.log"; rm -f "$state/maintenance" ;;
		*) echo "maintenance-on" >>"$SB/events.log"; : >"$state/maintenance" ;;
		esac
		exit 0
		;;
	esac
	exit 0
	;;
build) echo "docker-build $*" >>"$SB/events.log"
	for a in "$@"; do case "$a" in -t) next=1 ;; *) [ "${next:-0}" = 1 ] && echo "$a" >>"$state/images" && next=0 ;; esac; done
	exit 0 ;;
image)
	case "$2" in
	inspect) grep -qx "$3" "$state/images"; exit $? ;;
	rm) echo "image-rm $3" >>"$SB/events.log"; exit 0 ;;
	esac
	;;
images)
	repo=${@: -1}
	# One line per tag with a creation time that rises with the order the images were added.
	awk -v r="$repo" 'index($0, r ":") == 1 { printf "%s 2026-10-13 10:%02d:00\n", substr($0, length(r) + 2), NR }' "$state/images"
	exit 0
	;;
inspect)
	name=${@: -1}
	svc=${name#cid-}
	if has "restarting-$svc"; then echo restarting
	elif has "unhealthy-$svc"; then echo unhealthy
	else echo healthy; fi
	exit 0
	;;
compose)
	shift
	sub=""
	for a in "$@"; do
		case "$a" in build | up | run | ps | exec | logs | config) sub=$a; break ;; esac
	done
	v=$(version_from_args "$@")
	case "$sub" in
	build)
		echo "compose-build version=$v" >>"$SB/events.log"
		for img in aidp-server aidp-web aidp-backup aidp-ops-notify; do grep -qx "$img:$v" "$state/images" || echo "$img:$v" >>"$state/images"; done
		exit 0
		;;
	up)
		echo "compose-up version=$v $*" >>"$SB/events.log"
		# Replacing the application can fail on its own (a port, a healthcheck dependency).
		case "$*" in *--remove-orphans*) has switch-fails && { echo "service \"api\" failed to start" >&2; exit 1; } ;; esac
		# a second call (the automatic rollback) may be told to succeed
		exit 0
		;;
	run)
		# A one-shot (migrate, db-grants, preflight) run on its own, as upgrade.sh does before it
		# replaces anything. up-fails: the migration fails.
		svc=""
		for a in "$@"; do case "$a" in ops-state-init | migrate | db-grants | preflight) svc=$a ;; esac; done
		echo "compose-run $svc version=$v" >>"$SB/events.log"
		has up-fails && [ "$svc" = migrate ] && { echo "migrate: ERROR: division by zero" >&2; exit 1; }
		exit 0
		;;
	ps)
		case "$*" in *"-q "*) echo "cid-${@: -1}" ;; esac
		exit 0
		;;
	exec)
		case "$*" in
		*"4000/api/v1/health/ready"*) has smoke-api-fails && exit 1 ;;
		*"3000/api/health"*) has smoke-web-fails && exit 1 ;;
		esac
		exit 0
		;;
	logs) echo "(fake logs)"; exit 0 ;;
	esac
	exit 0
	;;
esac
exit 0
FAKE
	cat >"$SB/bin/git" <<'FAKE'
#!/bin/bash
echo "git $*" >>"$SB/git.log"
state="$SB/state"
case "$1" in
rev-parse) cat "$state/sha" ;;
status) cat "$state/dirty" ;;
log) echo "1111111 a change" ;;
fetch) exit 0 ;;
checkout)
	ref=${@: -1}
	[ -f "$state/ref-$ref" ] && cp "$state/ref-$ref" "$state/sha"
	exit 0
	;;
esac
exit 0
FAKE
	cat >"$SB/bin/curl" <<'FAKE'
#!/bin/bash
echo "curl $*" >>"$SB/curl.log"
if [ -e "$SB/state/curl-code" ]; then cat "$SB/state/curl-code"
elif [ -e "$SB/state/maintenance" ]; then echo 503
else echo 200; fi
FAKE
	cat >"$SB/bin/df" <<'FAKE'
#!/bin/bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/x 100000000 1000 $(cat "$SB/state/free-kb" 2>/dev/null || echo 52428800) 1% /"
FAKE
	chmod +x "$SB/bin/"*
}
