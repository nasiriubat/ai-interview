#!/bin/bash
# deploy/autodeploy.sh deploys only a verified commit (D-493): one with a `verified/<sha>` tag,
# which `pnpm ship` pushes after the gate, the browser suite and the dependency audit passed. A
# plain push is skipped and reported once; `--allow-unverified` deploys it anyway, on the record.
. "$(dirname "$0")/harness.sh"
trap cleanup_sandbox EXIT

# A sandbox whose git answers from files: the branch head, the running commit, and which commits
# carry a verified tag on the remote. upgrade.sh is replaced by a stub that records it ran.
autodeploy_sandbox() {
	new_sandbox
	cp "$DEPLOY_DIR/autodeploy.sh" "$SB/repo/deploy/autodeploy.sh"
	chmod +x "$SB/repo/deploy/autodeploy.sh"
	cat >"$SB/repo/deploy/upgrade.sh" <<'STUB'
#!/bin/bash
echo "upgraded" >>"$SB/upgrades"
STUB
	chmod +x "$SB/repo/deploy/upgrade.sh"
	echo "head000000000000000000000000000000000000" >"$SB/state/head"
	echo "next000000000000000000000000000000000000" >"$SB/state/target"
	cat >"$SB/bin/git" <<'FAKE'
#!/bin/bash
echo "git $*" >>"$SB/git.log"
state="$SB/state"
case "$1" in
rev-parse)
	case "$*" in
	*origin/*) cat "$state/target" ;;
	*--short*) cut -c1-7 <"$state/${@: -1}" 2>/dev/null || echo "${@: -1}" | cut -c1-7 ;;
	*) cat "$state/head" ;;
	esac
	;;
fetch)
	case "$*" in
	*refs/tags/verified/*)
		args="$*"
		sha=${args##*refs/tags/verified/}
		sha=${sha%%:*}
		[ -e "$state/verified-$sha" ] || exit 1
		;;
	esac
	exit 0
	;;
checkout) cp "$state/target" "$state/head" ;;
esac
exit 0
FAKE
	chmod +x "$SB/bin/git"
}

run_autodeploy() {
	(cd "$SB/repo" && deploy/autodeploy.sh "$@" 2>&1)
}

echo "a verified commit is deployed"
autodeploy_sandbox
: >"$SB/state/verified-$(cat "$SB/state/target")"
OUT=$(run_autodeploy)
assert_status "exits 0" 0 "$?"
assert_eq "upgrade ran once" "upgraded" "$(cat "$SB/upgrades" 2>/dev/null)"
cleanup_sandbox

echo "an unverified push is skipped and reported once"
autodeploy_sandbox
OUT=$(run_autodeploy)
assert_status "exits 0" 0 "$?"
assert_eq "upgrade did not run" "" "$(cat "$SB/upgrades" 2>/dev/null)"
assert_contains "says why" "$OUT" "has no verified/ tag; not deploying"
assert_contains "and how to deploy it anyway" "$OUT" "--allow-unverified"
OUT=$(run_autodeploy)
assert_not_contains "the next tick stays quiet about the same commit" "$OUT" "has no verified/ tag"
assert_eq "and still does not deploy it" "" "$(cat "$SB/upgrades" 2>/dev/null)"
cleanup_sandbox

echo "--allow-unverified deploys it, on the record"
autodeploy_sandbox
OUT=$(run_autodeploy --allow-unverified)
assert_status "exits 0" 0 "$?"
assert_eq "upgrade ran" "upgraded" "$(cat "$SB/upgrades" 2>/dev/null)"
assert_contains "and says it was not verified" "$OUT" "WITHOUT verification (override)"
cleanup_sandbox

echo "the running commit is left alone"
autodeploy_sandbox
cp "$SB/state/target" "$SB/state/head"
OUT=$(run_autodeploy)
assert_eq "nothing happens" "" "$OUT$(cat "$SB/upgrades" 2>/dev/null)"
cleanup_sandbox

finish
