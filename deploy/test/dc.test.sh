#!/bin/bash
# deploy/dc and the one env file (D-450): every compose call reads the repository-root .env, and an
# install that still keeps its settings in the old place, deploy/.env, is stopped with the move to
# make instead of starting on the wrong file or none.
. "$(dirname "$0")/harness.sh"
trap cleanup_sandbox EXIT

echo "dc reads the repository-root .env"
new_sandbox
echo "AIDP_VERSION=v1" >"$SB/repo/deploy/versions.env"
"$SB/repo/deploy/dc" ps >/dev/null 2>&1
assert_status "runs" 0 "$?"
log=$(cat "$SB/docker.log")
repo=$(cd "$SB/repo" && pwd)
assert_contains "with the production compose file" "$log" "-f $repo/deploy/compose.yml"
assert_contains "with the root .env" "$log" "--env-file $repo/.env"
assert_contains "and the version record" "$log" "--env-file $repo/deploy/versions.env"
cleanup_sandbox

echo "a legacy deploy/.env is refused with the move to make"
new_sandbox
echo "AIDP_VERSION=v1" >"$SB/repo/deploy/versions.env"
mv "$SB/repo/.env" "$SB/repo/deploy/.env"
OUT=$("$SB/repo/deploy/dc" ps 2>&1)
assert_status "dc exits 1" 1 "$?"
assert_contains "names the old file" "$OUT" "found deploy/.env"
assert_contains "and says what to run" "$OUT" "mv deploy/.env .env"
assert_eq "and calls no docker" "" "$(cat "$SB/docker.log")"
OUT=$("$SB/repo/deploy/upgrade.sh" --yes 2>&1)
assert_status "upgrade.sh is refused too" 1 "$?"
assert_contains "with the same message" "$OUT" "mv deploy/.env .env"
OUT=$("$SB/repo/deploy/rollback.sh" --yes 2>&1)
assert_status "and rollback.sh" 1 "$?"
assert_contains "with the same message" "$OUT" "mv deploy/.env .env"
cleanup_sandbox

echo "both files present: nothing is guessed"
new_sandbox
echo "AIDP_VERSION=v1" >"$SB/repo/deploy/versions.env"
cp "$SB/repo/.env" "$SB/repo/deploy/.env"
OUT=$("$SB/repo/deploy/dc" ps 2>&1)
assert_status "dc exits 1" 1 "$?"
assert_contains "says both exist" "$OUT" "exists too"
assert_contains "and that nothing was changed" "$OUT" "Nothing was changed"
assert_eq "both files are still there" 2 "$(ls "$SB/repo/.env" "$SB/repo/deploy/.env" | wc -l | tr -d ' ')"
cleanup_sandbox

echo "ENV_FILE_PATH names the file explicitly (the rehearsal): no legacy check"
new_sandbox
echo "AIDP_VERSION=v1" >"$SB/repo/deploy/versions.env"
mv "$SB/repo/.env" "$SB/repo/deploy/.env"
ENV_FILE_PATH="$SB/repo/deploy/.env" "$SB/repo/deploy/dc" ps >/dev/null 2>&1
assert_status "runs" 0 "$?"
assert_contains "with the named file" "$(cat "$SB/docker.log")" "--env-file $SB/repo/deploy/.env"
cleanup_sandbox

echo "no env file at all"
new_sandbox
rm -f "$SB/repo/.env"
OUT=$("$SB/repo/deploy/dc" ps 2>&1)
assert_status "dc exits 1" 1 "$?"
assert_contains "and points at generate-env.sh" "$OUT" "run deploy/generate-env.sh first"
cleanup_sandbox

finish
