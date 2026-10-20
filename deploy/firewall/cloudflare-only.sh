#!/bin/bash
# Lets only Cloudflare reach the published HTTPS port, for an install behind Cloudflare
# (docs/DEPLOY.md, "Behind Cloudflare"). Without it anyone can skip Cloudflare by connecting to
# <server-ip>:<port>; the client address cannot be forged that way, but Cloudflare's DDoS and WAF
# protection can be skipped.
#
#   sudo deploy/firewall/cloudflare-only.sh apply    # idempotent; the aidp-firewall unit runs it at boot
#   sudo deploy/firewall/cloudflare-only.sh remove
#
# Docker-published ports bypass ufw and INPUT, so the rule lives in DOCKER-USER, in a chain of its
# own (AIDP-CF) that is flushed and rebuilt on every apply. It matches only connections that arrive
# on the external interface for this port: traffic between containers, including other products'
# services that listen on the same port number inside their own networks, never reaches it.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
env_file="$here/../../.env"
port=$(grep -E '^HTTPS_BIND=' "$env_file" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d "'\"")
port="${port##*:}"
[ -n "$port" ] || { echo "cloudflare-only: no HTTPS_BIND in $env_file; nothing to protect" >&2; exit 1; }
iface=$(ip route show default | awk '{for (i=1;i<NF;i++) if ($i=="dev") {print $(i+1); exit}}')
[ -n "$iface" ] || { echo "cloudflare-only: no default route interface" >&2; exit 1; }

# https://www.cloudflare.com/ips/ (the same list as trusted_proxies in deploy/Caddyfile).
v4="173.245.48.0/20 103.21.244.0/22 103.22.200.0/22 103.31.4.0/22 141.101.64.0/18 108.162.192.0/18 190.93.240.0/20 188.114.96.0/20 197.234.240.0/22 198.41.128.0/17 162.158.0.0/15 104.16.0.0/13 104.24.0.0/14 172.64.0.0/13 131.0.72.0/22"
v6="2400:cb00::/32 2606:4700::/32 2803:f800::/32 2405:b500::/32 2405:8100::/32 2a06:98c0::/29 2c0f:f248::/32"

jump=(DOCKER-USER -i "$iface" -p tcp -m conntrack --ctorigdstport "$port" --ctdir ORIGINAL -j AIDP-CF)

one() { # <iptables|ip6tables> <ranges>
	local ipt=$1 ranges=$2
	$ipt -n -L DOCKER-USER >/dev/null 2>&1 || return 0
	while $ipt -C "${jump[@]}" 2>/dev/null; do $ipt -D "${jump[@]}"; done
	if [ "$action" = remove ]; then
		$ipt -F AIDP-CF 2>/dev/null || true
		$ipt -X AIDP-CF 2>/dev/null || true
		return 0
	fi
	$ipt -N AIDP-CF 2>/dev/null || $ipt -F AIDP-CF
	for r in $ranges; do $ipt -A AIDP-CF -s "$r" -j RETURN; done
	$ipt -A AIDP-CF -j DROP
	$ipt -I DOCKER-USER 1 "${jump[@]:1}"
}

action=${1:-apply}
case "$action" in apply | remove) ;; *) echo "usage: $0 apply|remove" >&2; exit 64 ;; esac
one iptables "$v4"
one ip6tables "$v6"
echo "cloudflare-only: $action done for port $port on $iface"
