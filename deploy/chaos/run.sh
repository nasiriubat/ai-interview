#!/bin/bash
# Runs the chaos scripts against the drill stack (deploy/drill/stack.sh up + configure), one after
# the other, and prints a one-line verdict for each. Takes about twenty minutes: several of them
# wait out real timeouts, a turn lock and a restart policy, on purpose.
#
#   deploy/chaos/run.sh                       # all
#   deploy/chaos/run.sh provider-5xx kill-api # some
#
# Each script is `deploy/drill/stack.sh run node deploy/chaos/<name>.mjs`; results are written to
# $AIDP_DRILL_DIR/chaos/<name>.json. Not part of `pnpm check`: it needs Docker and a built stack.
set -uo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)

all=(provider-5xx provider-hang postgres-restart kill-worker kill-api caddy-restart disk-full)
if [ $# -gt 0 ]; then all=("$@"); fi

failed=0
for name in "${all[@]}"; do
	started=$(date +%s)
	if "$repo/deploy/drill/stack.sh" run node "$here/$name.mjs"; then verdict=PASS; else verdict=FAIL; failed=1; fi
	echo ">>> $name: $verdict ($(($(date +%s) - started)) s)"
done
exit $failed
