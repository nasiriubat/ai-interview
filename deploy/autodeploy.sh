#!/bin/bash
# Deploys the newest commit on the deploy branch, if it is not already the one running. Run every
# minute by the aidp-autodeploy systemd timer (deploy/autodeploy/), so a push to `main` reaches the
# server without a CI runner, inbound port or deploy credentials anywhere but here: the server
# fetches with a read-only deploy key.
#
#   deploy/autodeploy.sh                 # once, by hand: same as the timer
#   AIDP_DEPLOY_BRANCH=main              # the branch it follows (default main)
#
# A commit whose deploy failed is remembered in deploy/.autodeploy-failed and not retried, so a
# broken build costs one attempt, not one a minute; the next push is tried as usual. upgrade.sh has
# already rolled back by then and the previous version is still serving. To retry the same commit,
# delete that file.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/.." && pwd)
cd "$repo"
# shellcheck source=lib/lib.sh
. "$here/lib/lib.sh"
branch="${AIDP_DEPLOY_BRANCH:-main}"
failed_file="$here/.autodeploy-failed"
skipped_file="$here/.autodeploy-unverified"
allow_file="$here/.autodeploy-allow-unverified"

git fetch --quiet origin "$branch"
target=$(git rev-parse "origin/$branch")
[ "$target" != "$(git rev-parse HEAD)" ] || exit 0
[ "$target" != "$(cat "$failed_file" 2>/dev/null || true)" ] || exit 0

# Only a verified commit is deployed (D-493): `pnpm ship` pushes `verified/<sha>` once the gate, the
# browser suite and the dependency audit have passed for exactly that commit. A plain push to the
# branch is skipped and the operator is told once. The emergency way past it is explicit and leaves
# an alert behind:
#
#   deploy/autodeploy.sh --allow-unverified     # deploys the branch head as it is, now
if [ "${1:-}" = "--allow-unverified" ]; then
	echo "$target" >"$allow_file"
fi
if git fetch --quiet origin "refs/tags/verified/$target:refs/tags/verified/$target" 2>/dev/null; then
	rm -f "$skipped_file"
elif [ "$(cat "$allow_file" 2>/dev/null || true)" = "$target" ]; then
	echo "autodeploy: deploying $(git rev-parse --short "$target") WITHOUT verification (override)"
	host_alert deploy.unverified warning "Deployed an unverified commit" \
		"$target was deployed with --allow-unverified: the gate, browser tests and dependency audit were not confirmed for it."
else
	if [ "$(cat "$skipped_file" 2>/dev/null || true)" != "$target" ]; then
		echo "$target" >"$skipped_file"
		echo "autodeploy: $(git rev-parse --short "$target") has no verified/ tag; not deploying (run pnpm ship, or deploy/autodeploy.sh --allow-unverified)" >&2
		host_alert deploy.skipped_unverified warning "A push to $branch was not deployed" \
			"$target has no verified/$target tag, so the server kept the running version. Push with pnpm ship, or run deploy/autodeploy.sh --allow-unverified on the server."
	fi
	exit 0
fi

echo "autodeploy: $(git rev-parse --short HEAD) -> $(git rev-parse --short "$target") ($branch)"
# Check out first and run the NEW upgrade.sh: bash reads a script as it runs, so letting the old one
# check out its own replacement would execute a mixture of the two.
git checkout --quiet --detach "$target"
if "$here/upgrade.sh" --yes; then
	rm -f "$failed_file"
else
	echo "$target" >"$failed_file"
	echo "autodeploy: $target failed to deploy; the previous version is still serving (journalctl -u aidp-autodeploy)" >&2
	exit 1
fi
