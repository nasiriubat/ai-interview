#!/bin/bash
# Waits until no analysis.run or spec.generate job is `active` or `created` in the drill stack, so a
# scenario starts from a quiet queue. Prints what it is waiting for once a minute.
#
#   deploy/drill/stack.sh run deploy/drill/wait-jobs.sh [seconds]
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
limit=${1:-300}
deadline=$(($(date +%s) + limit))
while :; do
	n=$("$here/../dc" exec -T postgres psql -U app -d ai_discovery -tAc \
		"select count(*) from pgboss.job where name in ('analysis.run','spec.generate') and state in ('active','created','retry')")
	[ "$n" = 0 ] && { echo "queue quiet"; exit 0; }
	[ "$(date +%s)" -lt "$deadline" ] || { echo "still $n job(s) after ${limit}s" >&2; exit 1; }
	sleep 5
done
