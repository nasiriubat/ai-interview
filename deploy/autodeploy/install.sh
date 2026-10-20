#!/bin/bash
# Installs the push-to-deploy timer for this checkout: every minute it fetches the deploy branch and
# runs deploy/upgrade.sh when it moved (deploy/autodeploy.sh). Run once, as the user that owns the
# checkout and is in the docker group; it asks sudo only to write the two systemd units.
#
#   deploy/autodeploy/install.sh
#   journalctl -u aidp-autodeploy -f      # watch deploys
#   sudo systemctl disable --now aidp-autodeploy.timer   # stop deploying on push
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../.." && pwd)
user=$(id -un)
for unit in aidp-autodeploy.service aidp-autodeploy.timer; do
	sed -e "s#@REPO@#$repo#g" -e "s#@USER@#$user#g" "$here/$unit" | sudo tee "/etc/systemd/system/$unit" >/dev/null
done
sudo systemctl daemon-reload
sudo systemctl enable --now aidp-autodeploy.timer
systemctl list-timers aidp-autodeploy.timer --no-pager
