#!/bin/bash
# Runs every deploy script test, offline. `pnpm check` runs these through
# packages/core/test/deploy-scripts.test.ts; this is the same thing by hand:
#
#   deploy/test/run.sh              # all of them
#   deploy/test/run.sh release      # one, by name
#
# Needs bash, jq and a POSIX userland. Needs neither Docker nor a network: the scripts under test
# call a fake docker, git, curl, openssl, pg_dump and age that the tests put first on PATH.
set -u
here=$(cd "$(dirname "$0")" && pwd)
failed=0
for t in "$here"/*.test.sh; do
	name=$(basename "$t" .test.sh)
	[ -z "${1:-}" ] || [ "$1" = "$name" ] || continue
	echo "=== $name"
	bash "$t" || failed=1
done
exit $failed
