#!/bin/bash
# deploy/restore.sh with encrypted backups (D-95): that the dump is proved readable BEFORE anything
# is stopped or dropped, that .age files are decrypted in the backup container and streamed, that
# the matching uploads archive is found, and that older plain dumps still restore.
#
# A fake docker runs the in-container snippets locally, with /backups mapped into a sandbox and a
# stand-in age that copies, so the real script's control flow and quoting are what is exercised.
. "$(dirname "$0")/harness.sh"
trap 'rm -rf "${SB:-}"' EXIT

setup() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-restore-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/backups" "$SB/state"
	: >"$SB/docker.log"
	echo "services: {}" >"$SB/compose.yml"
	printf 'POSTGRES_PASSWORD=pgpw\nAPP_DB_PASSWORD=apppw\n' >"$SB/env"
	cat >"$SB/bin/age" <<'FAKE'
#!/bin/bash
# stand-in: `age -d -i FILE` copies stdin. Refuses when the identity file is empty, as age would.
echo "age $*" >>"$SB/docker.log"
if [ "$1" = "-d" ]; then
	[ -s "$3" ] || { echo "age: no identity" >&2; exit 1; }
fi
cat
FAKE
	cat >"$SB/bin/docker" <<'FAKE'
#!/bin/bash
echo "docker $*" >>"$SB/docker.log"
shift # compose
while [ $# -gt 0 ]; do
	case "$1" in
	-f | --env-file) shift 2 ;;
	*) break ;;
	esac
done
verb=$1
shift
map() { echo "${1//\/backups\//$SB/backups/}"; }
case "$verb" in
exec)
	shift # -T
	svc=$1
	shift
	if [ "$svc" = backup ]; then
		case "$1" in
		test) shift 2; [ -f "$(map "$1")" ]; exit $? ;;
		cat) cat "$(map "$2")"; exit $? ;;
		sh)
			# sh -c SCRIPT sh ARG...
			script=$(map "$3")
			shift 3
			args=()
			for a in "$@"; do args+=("$(map "$a")"); done
			BACKUP_AGE_IDENTITY="${FAKE_IDENTITY-}" exec bash -c "$script" "${args[@]}"
			;;
		esac
	else
		case "$*" in
		*"from pg_database"*) echo 1 ;;
		*'from "User"'*) cat "$SB/state/rows" 2>/dev/null || echo 0 ;;
		*pg_restore*)
			cat >"$SB/restored.dump"
			echo "pg_restore received $(wc -c <"$SB/restored.dump" | tr -d ' ') bytes" >>"$SB/docker.log"
			;;
		esac
	fi
	exit 0
	;;
run)
	cat >"$SB/uploads.tar"
	echo "uploads restored from stream of $(wc -c <"$SB/uploads.tar" | tr -d ' ') bytes" >>"$SB/docker.log"
	exit 0
	;;
esac
exit 0
FAKE
	chmod +x "$SB/bin/"*
	export SB PATH="$SB/bin:$PATH"
	export COMPOSE_FILE_PATH="$SB/compose.yml" ENV_FILE_PATH="$SB/env" VERSIONS_FILE_PATH="$SB/none"
	export FAKE_IDENTITY="AGE-SECRET-KEY-1TEST"
}

restore() {
	OUT=$("$DEPLOY_DIR/restore.sh" "$@" 2>&1)
	STATUS=$?
	LOG=$(cat "$SB/docker.log")
}

echo "an encrypted backup, live restore"
setup
printf 'PGDMP-encrypted-bytes' >"$SB/backups/ai_discovery-20261013T032000Z.dump.age"
printf 'TARBYTES' >"$SB/backups/uploads-20261013T032000Z.tar.gz.age"
restore --latest --force --yes
assert_status "succeeds" 0 "$STATUS"
assert_contains "decrypts with the identity" "$LOG" "age -d -i"
assert_contains "streams the plaintext dump to pg_restore" "$LOG" "pg_restore received 21 bytes"
assert_contains "finds and decrypts the matching uploads archive" "$LOG" "uploads restored from stream of 8 bytes"
assert_before "reads the dump before it stops the application" "$LOG" "age -d" "stop api worker"
assert_before "and before it drops the database" "$LOG" "age -d" "drop database"
assert_eq "the plaintext never touched the backups volume" 0 "$(find "$SB/backups" -name '*.dump' | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "the identity is missing"
setup
printf 'PGDMP-encrypted-bytes' >"$SB/backups/ai_discovery-20261013T032000Z.dump.age"
export FAKE_IDENTITY=""
restore --latest --force --yes
assert_status "refuses" 1 "$STATUS"
assert_contains "and says what is wrong" "$OUT" "BACKUP_AGE_IDENTITY"
assert_not_contains "stops nothing" "$LOG" "stop api worker"
assert_not_contains "drops nothing" "$LOG" "drop database"
rm -rf "$SB"

echo "a file that is not a pg_dump archive"
setup
printf 'this is not an archive' >"$SB/backups/ai_discovery-20261013T032000Z.dump.age"
restore --latest --force --yes
assert_status "refuses before touching the database" 1 "$STATUS"
assert_not_contains "drops nothing" "$LOG" "drop database"
rm -rf "$SB"

echo "a plain dump from before encryption still restores"
setup
printf 'PGDMP-plain' >"$SB/backups/ai_discovery-20260914T032000Z.dump"
printf 'TAR' >"$SB/backups/uploads-20260914T032000Z.tar.gz"
restore --latest --force --yes
assert_status "succeeds" 0 "$STATUS"
assert_contains "restores the bytes" "$LOG" "pg_restore received 11 bytes"
assert_not_contains "without age" "$LOG" "age -d"
rm -rf "$SB"

echo "the newest of the two kinds is the latest"
setup
printf 'PGDMP-old-plain' >"$SB/backups/ai_discovery-20260914T032000Z.dump"
sleep 1
printf 'PGDMP-new-encrypted-bytes' >"$SB/backups/ai_discovery-20261013T032000Z.dump.age"
restore --latest --force --yes
assert_contains "picks the encrypted one" "$OUT" "ai_discovery-20261013T032000Z.dump.age"
rm -rf "$SB"

echo "a live database with rows is not overwritten without --force"
setup
printf 'PGDMP-encrypted-bytes' >"$SB/backups/ai_discovery-20261013T032000Z.dump.age"
echo 7 >"$SB/state/rows"
restore --latest --yes
assert_status "refuses" 1 "$STATUS"
assert_contains "and says so" "$OUT" "refusing to overwrite"
rm -rf "$SB"

finish
