#!/bin/bash
# Deploys the checked-out revision: back up, build, migrate, switch, check, and undo the switch if
# the checks fail (D-96). The first deployment is the same command.
#
#   deploy/upgrade.sh                    # deploy the working tree as it is (after `git pull`)
#   deploy/upgrade.sh --to v1.4.0        # check that ref out (detached) and deploy it
#   deploy/upgrade.sh --dry-run          # say what it would do; change nothing
#
# Flags:
#   --to <ref>        branch, tag or sha; needs a clean tree
#   --allow-dirty     build uncommitted changes; the image is tagged <sha>-dirty-<time>, never the sha
#   --skip-backup     do not take the pre-upgrade backup (refused unless --yes as well)
#   --yes             do not ask
#   --dry-run         print the plan
#
# What it does, in order, and why:
#   1. Refuses if volumes from before the project was named exist and COMPOSE_PROJECT_NAME is not
#      set to match: the next step would otherwise start the stack on an empty database.
#   2. Takes a backup through the RUNNING backup container and refuses to go on without it. The
#      dump it names is the data-side rollback (docs/OPERATIONS.md, "Upgrade and roll back").
#   3. Builds the images tagged with the git SHA, so the previous ones stay on the host and a
#      rollback is `up` with the old tag and needs no build.
#   4. Makes sure the backup encryption key exists (once, from the image just built).
#   5. Puts up the maintenance page, switches, waits for migrate, api and web to be healthy, and
#      smoke-tests through Caddy. If the switch fails before migrations ran the old containers
#      are still serving and the old tag is restored; if it fails after, it rolls the code back
#      and tells you what the schema is now.
#   6. Waits for the backup container to be healthy; a crash-looping backup fails the upgrade (D-316).
#   7. Keeps the last three image generations.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
export AIDP_DEPLOY_DIR="$here"
# shellcheck source=deploy/lib/lib.sh
. "$here/lib/lib.sh"
refuse_legacy_env upgrade

target_ref=""
allow_dirty=0
skip_backup=0
assume_yes=0
while [ $# -gt 0 ]; do
	case "$1" in
	--to) target_ref=${2:?--to needs a ref}; shift ;;
	--allow-dirty) allow_dirty=1 ;;
	--skip-backup) skip_backup=1 ;;
	--yes) assume_yes=1 ;;
	--dry-run) DRY_RUN=1 ;;
	-h | --help) sed -n '2,33p' "$0"; exit 0 ;;
	*) die "unknown argument $1" ;;
	esac
	shift
done

[ -f "$env_file" ] || die "no $env_file; run deploy/generate-env.sh first"
command -v docker >/dev/null || die "docker is required"
repo=$(cd "$here/.." && pwd)
cd "$repo"

# One upgrade at a time: two builds and two `up`s racing would leave the stack on neither version.
lock="$here/.upgrade.lock"
if [ "$DRY_RUN" != 1 ]; then
	mkdir "$lock" 2>/dev/null || die "another upgrade or rollback is running (remove $lock if none is)"
	trap 'rmdir "$lock" 2>/dev/null || true' EXIT
	# rollback.sh is called from here on a failed check; it must know the lock is ours.
	export AIDP_HOLDS_LOCK=1
fi

# ---- 1. the project name ---------------------------------------------------------------------

project=$(kv_get "$env_file" COMPOSE_PROJECT_NAME)
project="${project:-aidp}"
volumes=$(docker volume ls --format '{{.Name}}' 2>/dev/null || true)
if echo "$volumes" | grep -qx "deploy_pgdata" && ! echo "$volumes" | grep -qx "${project}_pgdata"; then
	die "this host has the volume deploy_pgdata from an install made before the project was named, and COMPOSE_PROJECT_NAME is '$project', so this deploy would start on an EMPTY database. Put COMPOSE_PROJECT_NAME=deploy in $env_file and run this again."
fi

# ---- 2. the target revision ------------------------------------------------------------------

dirty=$(git status --porcelain 2>/dev/null | grep -v '^??' || true)
if [ -n "$target_ref" ]; then
	[ -z "$dirty" ] || die "the working tree has uncommitted changes; --to needs a clean tree"
	act git fetch --quiet || warn "git fetch failed; using the refs already here"
	act git checkout --quiet --detach "$target_ref" || die "cannot check out $target_ref"
fi
sha=$(git rev-parse --short=12 HEAD)
if [ -n "$dirty" ]; then
	[ "$allow_dirty" = 1 ] || die "the working tree has uncommitted changes. Commit them, or pass --allow-dirty to deploy them under a -dirty tag."
	version="$sha-dirty-$(date -u +%Y%m%dT%H%M%S)"
else
	version="$sha"
fi

previous=$(kv_get "$versions_file" AIDP_VERSION)
say "deploying $version (running: ${previous:-nothing recorded})"
if [ "$previous" = "$version" ]; then
	say "that version is already the one recorded as running; rebuilding and re-checking it"
fi
if [ -n "$previous" ] && echo "$previous" | grep -Eq '^[0-9a-f]{12}$'; then
	echo "---- changes since $previous ----"
	git log --oneline --no-decorate "$previous..HEAD" 2>/dev/null | head -n 30 || true
	echo "----"
fi

# ---- the disk --------------------------------------------------------------------------------

free_kb=$(df -Pk "$repo" 2>/dev/null | awk 'NR==2 {print $4}')
if [ -n "${free_kb:-}" ] && [ "$free_kb" -lt 3145728 ]; then
	die "less than 3 GB free on this disk ($((free_kb / 1024)) MB). Building images needs room; free some first (docs/OPERATIONS.md#diskhigh)."
fi

if [ "$assume_yes" != 1 ] && [ "$DRY_RUN" != 1 ] && [ -t 0 ]; then
	printf 'Deploy %s? [y/N] ' "$version"
	read -r answer
	case "$answer" in y | Y | yes) ;; *) die "aborted" ;; esac
fi

# ---- 3. the backup ---------------------------------------------------------------------------

dump=""
backup_id=$(container_of backup)
if [ -n "$backup_id" ]; then
	if [ "$skip_backup" = 1 ]; then
		[ "$assume_yes" = 1 ] || die "--skip-backup needs --yes: there will be no data-side rollback"
		warn "skipping the pre-upgrade backup; there is no dump to roll the data back to"
	else
		say "taking the pre-upgrade backup (through the running backup container)"
		act docker exec "$backup_id" /usr/local/bin/backup.sh once ||
			die "the pre-upgrade backup failed; not upgrading. Fix the backup first (docs/OPERATIONS.md#backupfailed)."
		if [ "$DRY_RUN" != 1 ]; then
			# The status file names it for this release's backup container; an older container
			# has none, so fall back to the newest file in the volume.
			dump=$(docker exec "$backup_id" jq -r '.dump // empty' /ops-state/status/backup.json 2>/dev/null | tr -d '\r' || true)
			[ -n "$dump" ] || dump=$(docker exec "$backup_id" sh -c 'ls -1t /backups/ai_discovery-*.dump* 2>/dev/null | head -n1' | tr -d '\r' | xargs -n1 basename 2>/dev/null || true)
			say "backup written: ${dump:-unknown name}"
		fi
	fi
else
	say "no running backup container (first deployment): nothing to back up yet"
fi

# ---- 4. the images ---------------------------------------------------------------------------

say "building images tagged $version"
export AIDP_VERSION="$version"
# The backup image first, on its own: it carries age-keygen, and compose will not even parse the
# stack until the key exists in the env file.
act docker build -q -f "$here/backup/backup.Dockerfile" -t "aidp-backup:$version" "$here/backup" >/dev/null
act env ENV_FILE_PATH="$env_file" "$here/backup/ensure-backup-key.sh" --image "aidp-backup:$version"
act dcx build
if [ "$DRY_RUN" != 1 ]; then
	# --env-file versions.env is not written yet, so the build above read AIDP_VERSION from here.
	for image in aidp-server aidp-web aidp-backup aidp-ops-notify; do
		docker image inspect "$image:$version" >/dev/null 2>&1 || die "the build did not produce $image:$version"
	done
fi

# ---- 5. the switch ---------------------------------------------------------------------------

write_versions "$version" "$previous" "$dump"
# From here the file is the record. A leftover exported AIDP_VERSION would silently outrank it in
# every compose call, including the ones rollback.sh makes after writing the previous version.
unset AIDP_VERSION
maintenance on

# The database steps run on their own, BEFORE anything is replaced. They used to be left to
# `up -d`, which on a failed migrate had already stopped, removed and re-created api, web and worker
# under the new tag and then refused to start them: the message said "the previous version is still
# running" while Caddy answered 502 to every participant, and the maintenance page had been taken
# down (found by the full-stack drill with a deliberately failing migration). `run` executes the
# one-shot service and returns its exit status without touching any other container.
switched=0
failed_step=""
say "migrating: postgres, migrate, db-grants, preflight (nothing is replaced until all of them pass)"
if act dcx up -d --no-build postgres && wait_healthy 180 postgres; then
	switched=1
	for svc in ops-state-init migrate db-grants preflight; do
		if ! act dcx run --rm --no-deps -T "$svc"; then
			switched=0
			failed_step=$svc
			break
		fi
	done
fi
if [ "$switched" = 1 ]; then
	switched=0
	say "switching: api, worker, web, behind the maintenance page"
	if act dcx up -d --no-build --remove-orphans; then
		switched=1
	fi
fi

# A one-shot that did not complete (migrate, db-grants, preflight) means nothing was replaced: the
# previous containers are still serving. Say which one failed and put the record back.
if [ "$switched" != 1 ]; then
	restore_versions
	maintenance off
	if [ -n "$failed_step" ]; then
		warn "$failed_step failed; nothing was replaced and the previous version is still running."
	else
		warn "the switch failed; check deploy/dc ps: the previous version may not be fully running."
	fi
	for svc in migrate preflight db-grants; do
		echo "---- $svc (last lines) ----" >&2
		dcx logs --no-color --tail 15 "$svc" 2>&1 >&2 || true
	done
	cat >&2 <<EOF
release: see docs/OPERATIONS.md#migratefailed for what each failure means and the three ways out.
release: the pre-upgrade backup is ${dump:-not recorded}.
EOF
	exit 1
fi

rollback_after_failure() {
	warn "$1"
	warn "rolling the code back to ${previous:-nothing} automatically"
	if [ -n "$previous" ]; then
		if "$here/rollback.sh" --yes; then
			warn "code is back on $previous. Migrations that ran are NOT undone: see docs/OPERATIONS.md#migratefailed"
		else
			warn "the automatic rollback failed too. The stack is in an unknown state: deploy/dc ps, then docs/OPERATIONS.md#migratefailed"
		fi
	else
		warn "there was no previous version recorded to roll back to. Maintenance page left up: deploy/dc logs, then docs/OPERATIONS.md#migratefailed"
	fi
	exit 1
}

say "waiting for api, web and caddy to be healthy"
wait_healthy 300 api worker web caddy || rollback_after_failure "a service did not become healthy within five minutes"
# Caddy answers 503 for as long as the maintenance flag exists, so a check made through it while the
# page is up can only fail. The page comes down first, and goes back up if the check fails: a
# participant who arrives in that moment gets the honest page, not a half-started application.
# (This used to check first and lower the page after, which made every upgrade roll itself back
# the first time the real maintenance flag was in play: found by the full-stack drill.)
maintenance off
say "smoke test through caddy"
if ! smoke; then
	maintenance on
	rollback_after_failure "the post-switch smoke test failed"
fi

# The backup container is replaced by the switch too. Its healthcheck is "the last backup worked and
# is recent", so waiting for it is how a crash-looping or failing backup shows up now and not at the
# next upgrade (D-316). The application is serving at this point, so this does not roll back; it
# fails the upgrade loudly and says where to look.
say "waiting for the backup container to be healthy"
if ! wait_backup_healthy "${AIDP_BACKUP_WAIT_SECONDS:-180}"; then
	warn "the stack is serving $version but BACKUPS ARE NOT WORKING. Do not leave it: docs/OPERATIONS.md#backupfailed"
	exit 1
fi

# ---- 6. housekeeping -------------------------------------------------------------------------

# Keep the newest three generations of each image so there is something to roll back to, and
# nothing else: the disk is the thing this host does not have much of.
if [ "$DRY_RUN" != 1 ]; then
	for image in aidp-server aidp-web aidp-backup aidp-ops-notify; do
		docker images --format '{{.Tag}} {{.CreatedAt}}' "$image" 2>/dev/null |
			sort -k2 -r | awk 'NR>3 {print $1}' |
			while read -r tag; do
				[ -n "$tag" ] && [ "$tag" != "$version" ] && [ "$tag" != "$previous" ] && docker image rm "$image:$tag" >/dev/null 2>&1 || true
			done
	done
fi

say "done: $version is running${previous:+ (was $previous)}"
[ -z "$dump" ] || say "data rollback point: $dump (docs/OPERATIONS.md#upgrade-and-roll-back)"
