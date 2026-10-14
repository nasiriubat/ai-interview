#!/bin/bash
# Puts the previous version of the code back, without a build and without a network (D-96).
#
#   deploy/rollback.sh          # back to AIDP_PREVIOUS_VERSION from deploy/versions.env
#   deploy/rollback.sh --yes    # do not ask
#   deploy/rollback.sh --dry-run
#
# The images of the previous version are still on this host, because upgrade.sh keeps the last
# three generations; rolling back is switching the tag compose runs and recreating the containers.
# Run it twice and you are forward again: the two versions swap places in versions.env.
#
# What it does NOT do is undo a migration. Migrations here are forward-only and written to be
# additive (docs/OPERATIONS.md, "Upgrade and roll back"), so the previous code runs against the
# newer schema; when a release did something the old code cannot live with, the pre-upgrade dump
# named in versions.env is the way back, with `deploy/restore.sh <dump> --force`.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export AIDP_DEPLOY_DIR="$here"
# shellcheck source=deploy/lib/lib.sh
. "$here/lib/lib.sh"
refuse_legacy_env rollback

assume_yes=0
while [ $# -gt 0 ]; do
	case "$1" in
	--yes) assume_yes=1 ;;
	--dry-run) DRY_RUN=1 ;;
	-h | --help) sed -n '2,17p' "$0"; exit 0 ;;
	*) die "unknown argument $1" ;;
	esac
	shift
done

[ -f "$versions_file" ] || die "no $versions_file: nothing has been deployed with upgrade.sh yet"
current=$(kv_get "$versions_file" AIDP_VERSION)
previous=$(kv_get "$versions_file" AIDP_PREVIOUS_VERSION)
dump=$(kv_get "$versions_file" AIDP_PREUPGRADE_DUMP)
[ -n "$previous" ] || die "no previous version is recorded. The first deployment, and the first one after the images were versioned, has nothing to roll back to without a rebuild: git checkout the earlier commit and run deploy/upgrade.sh, then restore the pre-upgrade dump if the data needs it."

# Without every image the previous stack needs, `up` would try to build or fail half way and leave
# a mixed stack. Check first, and say how to get out if something is missing.
missing=""
for image in aidp-server aidp-web aidp-backup aidp-ops-notify; do
	docker image inspect "$image:$previous" >/dev/null 2>&1 || missing="$missing $image:$previous"
done
if [ -n "$missing" ]; then
	die "cannot roll back without a rebuild: missing image(s)$missing. They are pruned after three generations. Rebuild that version: git checkout <its commit> && deploy/upgrade.sh"
fi

if [ "$assume_yes" != 1 ] && [ "$DRY_RUN" != 1 ] && [ -t 0 ]; then
	printf 'Roll back %s -> %s? [y/N] ' "$current" "$previous"
	read -r answer
	case "$answer" in y | Y | yes) ;; *) die "aborted" ;; esac
fi

# upgrade.sh calls this while it holds the lock and says so in the environment; run on its own, this
# takes the lock like upgrade.sh does.
lock="$here/.upgrade.lock"
if [ "$DRY_RUN" != 1 ] && [ -z "${AIDP_HOLDS_LOCK:-}" ]; then
	mkdir "$lock" 2>/dev/null || die "another upgrade or rollback is running (remove $lock if none is)"
	trap 'rmdir "$lock" 2>/dev/null || true' EXIT
fi
# The version file is what is being rewritten; a variable left in the environment must not win.
unset AIDP_VERSION

say "rolling back $current -> $previous (no build, no pull)"
write_versions "$previous" "$current" "$dump"
maintenance on
act dcx up -d --no-build --remove-orphans || {
	warn "bringing up $previous failed; putting the record back to $current"
	restore_versions
	maintenance off
	exit 1
}
wait_healthy 300 api worker web caddy || warn "a service is not healthy yet: deploy/dc ps"
# The page comes down before the check through Caddy (which answers 503 while it is up), and goes
# back up if the check fails, so participants see the honest page rather than a broken application.
maintenance off
if ! smoke; then
	maintenance on
	warn "the smoke test failed on $previous: deploy/dc logs api web caddy"
	warn "the maintenance page is up; when the stack is healthy: deploy/dc exec -T caddy rm -f /maintenance/on"
fi

say "now running $previous"
if [ -n "$dump" ]; then
	say "the dump taken before the upgrade is $dump."
	say "If the NEW version changed data the old code cannot read: deploy/restore.sh $dump --force"
fi
