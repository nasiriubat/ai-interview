#!/bin/bash
# Runs the k6 load scenarios against the drill stack (tools/rehearsal/drill/stack.sh up), from inside its
# Docker network, and records what each container used while it ran.
#
#   tools/load/run.sh smoke          # 4 interviews, 1 voice call, 12 link opens: about two minutes
#   tools/load/run.sh full           # 40 interviews x 20 turns, 5 voice calls, 100 opens, admin reads
#   tools/load/run.sh single-ip      # negative control: 200 opens from ONE address must hit the limiter
#   tools/load/run.sh office         # 40 colleagues behind ONE office address open the link in two minutes
#
#   LINKS=1 tools/load/run.sh full   # everything through one campaign's link (default: all of them)
#
#   PARTICIPANTS=20 HOLD=2m tools/load/run.sh full      # knobs: see tools/load/k6/full.js
#   FAKE_LATENCY_MS=400                           # the provider's own latency (docs/DEPLOY.md)
#
# k6 runs in a container on the stack's network with its own source addresses (k6 --local-ips and
# `ip addr add`), so Caddy sees distinct client addresses, the way a campaign launch looks. That is
# the only way to check that the rate limiter keys on the client and not on the proxy. Output goes to
# $AIDP_DRILL_DIR/load/<scenario>-<time>/: summary.json, k6.log, stats.csv and peaks.txt.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
scenario=${1:-smoke}
shift || true

# The drill's environment (paths, ports, emails), as `tools/rehearsal/drill/stack.sh env` prints it.
eval "$("$repo/tools/rehearsal/drill/stack.sh" env)"
project=${COMPOSE_PROJECT_NAME:-aidpfull}
network="${project}_default"
K6_IMAGE=${K6_IMAGE:-grafana/k6:latest}

case "$scenario" in
smoke) script=smoke.js ;;
full) script=full.js ;;
single-ip) script=single-ip.js ;;
connect) script=connect.js ;;
office) script=office.js ;;
*) echo "usage: $0 smoke|full|single-ip|office" >&2; exit 64 ;;
esac

[ -f "$AIDP_DRILL_DIR/campaign.json" ] || "$repo/tools/rehearsal/drill/stack.sh" configure
link=$(jq -r .linkToken "$AIDP_DRILL_DIR/campaign.json")
campaign=$(jq -r .campaignId "$AIDP_DRILL_DIR/campaign.json")
# Every campaign's link, comma separated: a launch is spread over several (D-310). LINKS=1 is the
# concentrated case, everything through one campaign's link.
links=$(jq -r --argjson n "${LINKS:-0}" '[.campaigns[]?.linkToken] | (if $n > 0 then .[:$n] else . end) | join(",")' "$AIDP_DRILL_DIR/campaign.json")
[ -n "$links" ] || links=$link
cookie=$(node "$repo/tools/rehearsal/drill/session.mjs" admin)

caddy_id=$(docker ps -q --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=caddy")
[ -n "$caddy_id" ] || { echo "load: the stack is not running (tools/rehearsal/drill/stack.sh up)" >&2; exit 1; }
caddy_ip=$(docker inspect -f "{{(index .NetworkSettings.Networks \"$network\").IPAddress}}" "$caddy_id")
prefix=${caddy_ip%.*}
first=100
last=250

out="$AIDP_DRILL_DIR/load/$scenario-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$out"
echo "load: $scenario against https://aidp.localhost via $caddy_ip, results in $out"

# Resource use while it runs: one sample every 5 s, from the Docker daemon.
(
	while :; do
		docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}},{{.MemPerc}},{{.NetIO}}' |
			grep "^${project}-" | sed "s/^/$(date +%s),/" >>"$out/stats.csv" || true
		sleep 5
	done
) &
sampler=$!
trap 'kill $sampler 2>/dev/null || true' EXIT

# Version and the provider's configured latency, written beside the numbers.
fake=$(curl -fsS "$AIDP_FAKE_URL/__control" | jq -c .behaviour)
{
	echo "scenario=$scenario"
	echo "version=$(grep '^AIDP_VERSION=' "$VERSIONS_FILE_PATH" | cut -d= -f2)"
	echo "provider=$fake"
	echo "host_cpus=$(docker info --format '{{.NCPU}}')"
	echo "host_memory_bytes=$(docker info --format '{{.MemTotal}}')"
	echo "k6_image=$K6_IMAGE"
	echo "links=$(echo "$links" | tr ',' '\n' | grep -c .)"
} >"$out/run.txt"

set +e
docker run --rm --network "$network" --cap-add NET_ADMIN --user root \
	--add-host "aidp.localhost:$caddy_ip" \
	--entrypoint sh \
	-e BASE_URL=https://aidp.localhost -e LINK_TOKEN="$link" -e LINK_TOKENS="$links" -e CAMPAIGN_ID="$campaign" -e ADMIN_COOKIE="$cookie" \
	-e PARTICIPANTS -e VOICE_SESSIONS -e BURST_OPENS -e HOLD -e INTERVIEW_TURNS -e THINK_MIN -e THINK_MAX \
	-e VOICE_EXCHANGES -e SINGLE_IP_OPENS -e ONLY -e OFFICE_PEOPLE -e OFFICE_MINUTES \
	-v "$repo/tools/load/k6:/scripts:ro" -v "$out:/out" \
	"$K6_IMAGE" -c "
		for i in \$(seq $first $last); do ip addr add $prefix.\$i/24 dev eth0 2>/dev/null; done
		# One connection from each address, one at a time, before the run. A hundred first
		# connections from fresh addresses at the same moment each waited about 20 s in this
		# Docker network (ARP resolution for new neighbours on the bridge; a second connection from
		# the same address took 0.1 ms). That is the harness, not the product, and a real launch
		# arrives from routed addresses; warming the neighbour entries keeps the run measuring Caddy
		# and the application.
		for i in \$(seq $first $last); do nc -z -w 3 -s $prefix.\$i $caddy_ip 443 2>/dev/null; done
		k6 run --local-ips=$prefix.$first-$prefix.$last --summary-export=/out/summary.json /scripts/$script
	" 2>&1 | tee "$out/k6.log"
status=${PIPESTATUS[0]}
set -e

kill $sampler 2>/dev/null || true
wait $sampler 2>/dev/null || true
# Peaks per container, from the samples: memory in MiB, CPU in percent of one core.
awk -F, '
	function mib(s,  v) {
		v = s + 0
		if (s ~ /GiB/) v *= 1024
		else if (s ~ /KiB/) v /= 1024
		else if (s !~ /MiB/) v /= 1048576
		return v
	}
	{
		split($4, m, " / ")
		mem = mib(m[1]); cpu = $3 + 0; name = $2
		if (mem > pm[name]) pm[name] = mem
		if (cpu > pc[name]) pc[name] = cpu
	}
	END { for (n in pm) printf "%-34s peak_mem_MiB=%8.1f peak_cpu_pct=%6.1f\n", n, pm[n], pc[n] }
' "$out/stats.csv" | sort >"$out/peaks.txt" || true
echo "load: peaks"
cat "$out/peaks.txt"
echo "load: k6 exit status $status ($out)"
exit "$status"
