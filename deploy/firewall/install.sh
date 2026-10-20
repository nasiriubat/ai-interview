#!/bin/bash
# Installs and starts the aidp-firewall unit (cloudflare-only.sh at every boot). Run once, after
# Cloudflare forwards to this host: before that it blocks nothing anyone uses.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
sed "s#@REPO@#$repo#g" "$here/aidp-firewall.service" | sudo tee /etc/systemd/system/aidp-firewall.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now aidp-firewall.service
sudo systemctl restart aidp-firewall.service
