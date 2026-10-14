#!/bin/bash
# Restore a pg_dump taken by deploy/backup/backup.sh.
#
#   deploy/restore.sh                                  # list what is in the backups volume
#   deploy/restore.sh --latest                         # restore the newest dump over ai_discovery
#   deploy/restore.sh ai_discovery-20260914T032000Z.dump.age
#   deploy/restore.sh --latest --into ai_discovery_check   # verify a dump without touching live data
#
# Dumps ending in .age are encrypted (D-95) and are decrypted inside the backup container with
# BACKUP_AGE_IDENTITY from the root .env; the plaintext exists only in the pipe between the
# containers. Older plain .dump files restore as before.
#
# Flags:
#   --force   restore over a database that still has rows (otherwise refused)
#   --yes     skip the confirmation prompt (for a scripted drill; think before you use it)
#
# Restoring over the live database stops the API and worker first, drops the database, and starts
# them again. Restoring --into another name leaves the running stack alone, which is how you
# check that last night's dump is actually restorable without a maintenance window.
#
# Overrides for a non-default deployment:
#   COMPOSE_FILE_PATH (default deploy/compose.yml), ENV_FILE_PATH (default the repository-root .env)
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
AIDP_DEPLOY_DIR="$here"
# compose_file, env_file (<repo>/.env), versions_file and refuse_legacy_env.
# shellcheck source=deploy/lib/lib.sh
. "$here/lib/lib.sh"
refuse_legacy_env restore
live_db=ai_discovery

[ -f "$compose_file" ] || { echo "restore: no compose file at $compose_file" >&2; exit 1; }
[ -f "$env_file" ] || { echo "restore: no env file at $env_file" >&2; exit 1; }

# The same invocation deploy/dc makes: versions.env carries the image tag compose substitutes.
dc() {
	local args=(-f "$compose_file") extra
	# COMPOSE_OVERRIDE_FILES: the full-stack drill's fake-provider overlay; empty on a real host.
	for extra in ${COMPOSE_OVERRIDE_FILES:-}; do args+=(-f "$extra"); done
	args+=(--env-file "$env_file")
	[ -f "$versions_file" ] && args+=(--env-file "$versions_file")
	docker compose "${args[@]}" "$@"
}
psql_owner() { dc exec -T postgres psql -v ON_ERROR_STOP=1 -tAX -U app "$@"; }

envval() { grep -E "^$1=" "$env_file" | head -n1 | cut -d= -f2-; }

dump=""
into="$live_db"
force=0
assume_yes=0
latest=0
while [ $# -gt 0 ]; do
	case "$1" in
	--latest) latest=1 ;;
	--into) into=${2:?--into needs a database name}; shift ;;
	--force) force=1 ;;
	--yes) assume_yes=1 ;;
	-h | --help) sed -n '2,20p' "$0"; exit 0 ;;
	-*) echo "restore: unknown flag $1" >&2; exit 64 ;;
	*) dump=$1 ;;
	esac
	shift
done

list_dumps() {
	dc exec -T backup sh -c 'ls -lh /backups/ai_discovery-*.dump /backups/ai_discovery-*.dump.age 2>/dev/null || echo "(no dumps yet)"'
}

# Streams a file out of the backups volume as plaintext: decrypted when it is an .age file.
# Runs in the backup container, which holds the identity; nothing is written to disk.
read_backup_file() {
	case "$1" in
	*.age)
		dc exec -T backup sh -c '
			[ -n "${BACKUP_AGE_IDENTITY:-}" ] || { echo "restore: BACKUP_AGE_IDENTITY is not set in .env, so an encrypted backup cannot be read" >&2; exit 3; }
			f=$(mktemp); trap "rm -f $f" EXIT
			printf "%s\n" "$BACKUP_AGE_IDENTITY" >"$f"
			age -d -i "$f" <"$1"' sh "$1"
		;;
	*) dc exec -T backup cat "$1" ;;
	esac
}

if [ $latest -eq 1 ]; then
	dump=$(dc exec -T backup sh -c 'ls -1t /backups/ai_discovery-*.dump.age /backups/ai_discovery-*.dump 2>/dev/null | head -n1' | tr -d '\r')
	dump=$(basename "${dump:-}")
	[ -n "$dump" ] && [ "$dump" != "." ] || { echo "restore: the backups volume holds no dumps" >&2; exit 1; }
fi

if [ -z "$dump" ]; then
	echo "Dumps in the backups volume:"
	list_dumps
	echo
	echo "Pick one:  $0 <name>   or   $0 --latest"
	exit 0
fi

dump_path="/backups/$(basename "$dump")"
dc exec -T backup test -f "$dump_path" || { echo "restore: $dump_path not found"; list_dumps; exit 1; } >&2

# What is about to be destroyed. A database that still holds rows is the common accident, so it
# is refused by default rather than warned about.
existing=$(psql_owner -d postgres -c \
	"select count(*) from pg_database where datname = '$into'")
rows=0
if [ "$existing" != "0" ]; then
	rows=$(psql_owner -d "$into" -c \
		'select coalesce((select count(*) from "User"), 0)' 2>/dev/null || echo 0)
fi

echo "restore: dump    $dump_path ($(dc exec -T backup sh -c "du -h $dump_path | cut -f1" | tr -d '\r'))"
echo "restore: target  database '$into' on the running postgres service"
if [ "$existing" = "0" ]; then
	echo "restore: target does not exist and will be created"
else
	echo "restore: target exists and holds $rows User rows — it will be DROPPED and recreated"
fi
if [ "$into" = "$live_db" ]; then
	echo "restore: this is the live database; api and worker will be stopped for the duration"
fi

if [ "$rows" != "0" ] && [ $force -eq 0 ]; then
	echo >&2
	echo "restore: refusing to overwrite '$into', which still has $rows User rows." >&2
	echo "         Restore into a scratch database first (--into ${live_db}_check) to verify the" >&2
	echo "         dump, or pass --force if you really mean to discard what is there." >&2
	exit 1
fi

if [ $assume_yes -eq 0 ]; then
	printf "\nType the target database name to continue: "
	read -r answer
	[ "$answer" = "$into" ] || { echo "restore: aborted"; exit 1; }
fi

# Prove the dump can be read BEFORE anything is stopped or dropped. A missing identity, a wrong
# key or a truncated file must stop the restore while the live database is still intact: the
# drop below cannot be undone, and a restore that fails after it has made things worse.
if [ "$(read_backup_file "$dump_path" 2>/dev/null | head -c 5)" != "PGDMP" ]; then
	echo "restore: $dump_path could not be read as a pg_dump archive; nothing was changed." >&2
	case "$dump_path" in
	*.age) echo "         It is encrypted: BACKUP_AGE_IDENTITY in $env_file must be the private key for the recipient it was written to." >&2 ;;
	esac
	exit 1
fi

started=$(date +%s)
if [ "$into" = "$live_db" ]; then
	echo "restore: stopping api and worker"
	dc stop api worker >/dev/null
fi

# Roles are cluster-wide and are not carried in a pg_dump. Restoring into a fresh cluster would
# otherwise fail on the first GRANT ... TO app_api.
psql_owner -d postgres -c \
	"do \$\$ begin if not exists (select 1 from pg_roles where rolname = 'app_api')
	   then create role app_api nologin; end if; end \$\$"

echo "restore: recreating database '$into'"
psql_owner -d postgres -c \
	"select pg_terminate_backend(pid) from pg_stat_activity where datname = '$into' and pid <> pg_backend_pid()" >/dev/null
psql_owner -d postgres -c "drop database if exists \"$into\"" >/dev/null
psql_owner -d postgres -c "create database \"$into\" owner app" >/dev/null

# The uploaded files, from the archive stamped to match this dump.
#
# Restoring the database alone would bring back Attachment rows pointing at bytes that are not
# there: every recording silently fails to play and every attached document is unreadable, with
# nothing in the logs to say why. Only done for a live restore — a verification restore into a
# scratch database must not overwrite the real uploads volume.
restore_uploads() {
	[ "$into" = "$live_db" ] || { echo "restore: into a scratch database, leaving uploads alone"; return 0; }
	stamp=$(basename "$dump_path" | sed -n 's/^ai_discovery-\(.*\)\.dump\(\.age\)\{0,1\}$/\1/p')
	archive=""
	for candidate in "/backups/uploads-$stamp.tar.gz.age" "/backups/uploads-$stamp.tar.gz"; do
		if dc exec -T backup test -f "$candidate" 2>/dev/null; then archive=$candidate; break; fi
	done
	if [ -z "$archive" ]; then
		archive="/backups/uploads-$stamp.tar.gz.age"
		echo "restore: no $archive beside this dump; uploaded files NOT restored" >&2
		echo "         Attachment rows will point at bytes that are missing." >&2
		return 0
	fi
	echo "restore: restoring uploaded files from $(basename "$archive")"
	# A one-off container rather than `exec`: a live restore stopped api and worker further up, so
	# there is nothing to exec into. `--no-deps` keeps it from starting them again, and the api
	# image is used only because it is the one that mounts the uploads volume writable.
	#
	# Replace rather than merge: a half-old, half-new uploads directory is harder to reason about
	# than either alone, and the archive is a complete picture of one moment.
	read_backup_file "$archive" |
		dc run --rm --no-deps -T --entrypoint sh api -c 'rm -rf /uploads/* 2>/dev/null; tar -xzf - -C /uploads'
	echo "restore: uploaded files restored"
}

echo "restore: pg_restore running"
# The dump lives in the backups volume, which only the backup container mounts; stream it across.
read_backup_file "$dump_path" |
	dc exec -T postgres pg_restore --no-owner --role=app --dbname="postgresql://app:$(envval POSTGRES_PASSWORD)@127.0.0.1:5432/$into"

restore_uploads

# Give app_api its login back: a restore into a fresh cluster created the role NOLOGIN above.
app_pw=$(envval APP_DB_PASSWORD)
[ -n "$app_pw" ] || { echo "restore: APP_DB_PASSWORD missing from $env_file" >&2; exit 1; }
psql_owner -d postgres -c "alter role app_api with login password '$app_pw'" >/dev/null

if [ "$into" = "$live_db" ]; then
	echo "restore: starting api and worker"
	dc up -d api worker >/dev/null
fi

echo "restore: finished in $(($(date +%s) - started))s"
echo
echo "Verify:"
echo "  docker compose -f $compose_file --env-file $env_file exec -T postgres \\"
echo "    psql -U app -d $into -c 'select count(*) from \"User\"; select count(*) from \"Company\";'"
if [ "$into" = "$live_db" ]; then
	echo "  docker compose -f $compose_file --env-file $env_file logs -f api"
fi
