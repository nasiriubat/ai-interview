#!/bin/bash
# upgrade.sh and rollback.sh, run for real against a fake docker/git/curl (see harness.sh).
#
# What is proved here is the ORDER and the DECISIONS: that nothing is built before the backup
# succeeded, that the maintenance page is up around the switch and always comes down, that a failed
# migrate leaves the old version recorded and running, that a failed smoke test rolls back without
# a build, and that rollback.sh never builds or pulls. What needs a real Docker is in the drill.
. "$(dirname "$0")/harness.sh"
trap cleanup_sandbox EXIT

run() { # runs a script from the sandbox repo, capturing output and status
	OUT=$(cd "$SB/repo" && "$@" 2>&1)
	STATUS=$?
}
events() { cat "$SB/events.log" 2>/dev/null; }
versions() { cat "$SB/repo/deploy/versions.env" 2>/dev/null; }
upgrade() { run "$SB/repo/deploy/upgrade.sh" --yes "$@"; }

echo "first deployment"
new_sandbox
upgrade
assert_status "succeeds" 0 "$STATUS"
assert_contains "records the git sha as the version" "$(versions)" "AIDP_VERSION=aaaaaaaaaaaa"
assert_contains "has no previous version" "$(versions)" "AIDP_PREVIOUS_VERSION="
assert_not_contains "takes no backup when nothing is running" "$(events)" "backup-once"
assert_not_contains "has no maintenance page to raise" "$(events)" "maintenance-on"
assert_contains "builds the images tagged with the sha" "$(events)" "compose-build version=aaaaaaaaaaaa"
assert_contains "starts the stack on that tag" "$(events)" "compose-up version=aaaaaaaaaaaa"
assert_contains "switches with --no-build" "$(events)" "--no-build"
cleanup_sandbox

echo "upgrade from a running stack"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/running-caddy"
# A real sha, so the script lists what changed since it; and no dump key at all, as an old file has.
printf 'AIDP_VERSION=oldoldoldold\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
for i in aidp-server aidp-web aidp-backup aidp-ops-notify; do echo "$i:oldoldoldold" >>"$SB/state/images"; done
echo "bbbbbbbbbbbb" >"$SB/state/sha"
upgrade
assert_status "succeeds" 0 "$STATUS"
E=$(events)
assert_before "backs up before it builds" "$E" "backup-once" "compose-build"
assert_before "raises maintenance before the switch" "$E" "maintenance-on" "compose-up"
assert_before "lowers maintenance only after the switch" "$E" "compose-up" "maintenance-off"
assert_contains "records the new version" "$(versions)" "AIDP_VERSION=bbbbbbbbbbbb"
assert_contains "remembers the old one for rollback" "$(versions)" "AIDP_PREVIOUS_VERSION=oldoldoldold"
assert_contains "names the dump taken before the switch" "$(versions)" "AIDP_PREUPGRADE_DUMP=ai_discovery-20261013T100000Z.dump.age"
assert_contains "starts the new tag" "$E" "compose-up version=bbbbbbbbbbbb"
cleanup_sandbox

echo "it lists what changed when the previous version is a sha"
new_sandbox
printf 'AIDP_VERSION=a1b2c3d4e5f6\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
echo "bbbbbbbbbbbb" >"$SB/state/sha"
upgrade
assert_contains "shows the commits" "$OUT" "1111111 a change"
cleanup_sandbox

echo "image generations are pruned to three, never the running or the previous one"
new_sandbox
touch "$SB/state/running-backup"
for t in v1v1v1v1v1v1 v2v2v2v2v2v2 v3v3v3v3v3v3 v4v4v4v4v4v4; do for i in aidp-server aidp-web aidp-backup aidp-ops-notify; do echo "$i:$t" >>"$SB/state/images"; done; done
printf 'AIDP_VERSION=v4v4v4v4v4v4\nAIDP_PREVIOUS_VERSION=v3v3v3v3v3v3\n' >"$SB/repo/deploy/versions.env"
echo "cccccccccccc" >"$SB/state/sha"
upgrade
E=$(events)
assert_contains "removes the oldest generation" "$E" "image-rm aidp-server:v1v1v1v1v1v1"
assert_not_contains "keeps the one it just deployed" "$E" "image-rm aidp-server:cccccccccccc"
assert_not_contains "keeps the previous one, which is what rollback needs" "$E" "image-rm aidp-server:v4v4v4v4v4v4"
cleanup_sandbox

echo "a failed pre-upgrade backup stops everything"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/backup-fails"
printf 'AIDP_VERSION=oldoldoldold\n' >"$SB/repo/deploy/versions.env"
echo "dddddddddddd" >"$SB/state/sha"
upgrade
assert_status "exits non-zero" 1 "$STATUS"
assert_not_contains "builds nothing" "$(events)" "compose-build"
assert_not_contains "switches nothing" "$(events)" "compose-up"
assert_contains "leaves the recorded version alone" "$(versions)" "AIDP_VERSION=oldoldoldold"
assert_contains "says why" "$OUT" "pre-upgrade backup failed"
cleanup_sandbox

echo "migrate fails during the switch"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/running-caddy" "$SB/state/up-fails"
printf 'AIDP_VERSION=oldoldoldold\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
echo "eeeeeeeeeeee" >"$SB/state/sha"
upgrade
E=$(events)
assert_status "exits non-zero" 1 "$STATUS"
assert_contains "puts the old version back on record" "$(versions)" "AIDP_VERSION=oldoldoldold"
assert_contains "takes the maintenance page down again" "$E" "maintenance-off"
assert_contains "points at the migrate.failed runbook" "$OUT" "docs/OPERATIONS.md#migratefailed"
assert_contains "names the dump to restore from" "$OUT" "ai_discovery-20261013T100000Z.dump.age"
assert_not_contains "does not roll back code that was never replaced" "$E" "compose-up version=oldoldoldold"
cleanup_sandbox

echo "the smoke test fails after the switch"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/running-caddy" "$SB/state/smoke-api-fails"
for i in aidp-server aidp-web aidp-backup aidp-ops-notify; do echo "$i:oldoldoldold" >>"$SB/state/images"; done
printf 'AIDP_VERSION=oldoldoldold\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
echo "ffffffffffff" >"$SB/state/sha"
upgrade
E=$(events)
assert_status "exits non-zero" 1 "$STATUS"
assert_contains "rolls back to the old tag automatically" "$E" "compose-up version=oldoldoldold"
assert_contains "records the old version as running again" "$(versions)" "AIDP_VERSION=oldoldoldold"
builds=$(echo "$E" | grep -c "compose-build")
assert_eq "built once, for the upgrade, and not again for the rollback" 1 "$builds"
assert_contains "warns that migrations are not undone" "$OUT" "Migrations that ran are NOT undone"
last_page=$(echo "$E" | grep "^maintenance-" | tail -n 1)
assert_eq "leaves the maintenance page up when the stack still cannot be checked" "maintenance-on" "$last_page"
cleanup_sandbox

echo "the smoke test is made through Caddy, which answers 503 while the maintenance page is up"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/running-caddy"
for i in aidp-server aidp-web aidp-backup aidp-ops-notify; do echo "$i:oldoldoldold" >>"$SB/state/images"; done
printf 'AIDP_VERSION=oldoldoldold\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
echo "hhhhhhhhhhhh" >"$SB/state/sha"
upgrade
E=$(echo "$(events)")
assert_status "a healthy upgrade succeeds with the real flag semantics" 0 "$STATUS"
assert_not_contains "and does not roll itself back" "$E" "compose-up version=oldoldoldold"
last_page=$(echo "$E" | grep "^maintenance-" | tail -n 1)
assert_eq "and ends with the page down" "maintenance-off" "$last_page"
cleanup_sandbox

echo "refusals"
new_sandbox
echo " M apps/api/src/x.ts" >"$SB/state/dirty"
upgrade
assert_status "a dirty tree is refused" 1 "$STATUS"
assert_not_contains "and nothing is built" "$(events)" "compose-build"
upgrade --allow-dirty
assert_status "unless it is allowed" 0 "$STATUS"
assert_contains "and is tagged as dirty, not as the sha" "$(versions)" "AIDP_VERSION=aaaaaaaaaaaa-dirty-"
cleanup_sandbox

new_sandbox
echo "deploy_pgdata" >"$SB/state/volumes"
upgrade
assert_status "an install made before the project was named is refused" 1 "$STATUS"
assert_contains "with the one sentence that says what to do" "$OUT" "COMPOSE_PROJECT_NAME=deploy"
assert_not_contains "and builds nothing" "$(events)" "compose-build"
printf 'COMPOSE_PROJECT_NAME=deploy\nPUBLIC_HOSTNAME=pilot.example.com\nBACKUP_AGE_RECIPIENT=age1testtesttesttesttesttesttesttesttesttesttesttesttesttesttest\n' >"$SB/repo/deploy/.env"
upgrade
assert_status "and goes ahead once the name matches" 0 "$STATUS"
cleanup_sandbox

new_sandbox
echo 1000000 >"$SB/state/free-kb"
upgrade
assert_status "a nearly full disk is refused before building" 1 "$STATUS"
assert_contains "and says so" "$OUT" "less than 3 GB free"
cleanup_sandbox

echo "dry run"
new_sandbox
touch "$SB/state/running-backup" "$SB/state/running-caddy"
printf 'AIDP_VERSION=oldoldoldold\n' >"$SB/repo/deploy/versions.env"
echo "gggggggggggg" >"$SB/state/sha"
upgrade --dry-run
assert_status "succeeds" 0 "$STATUS"
assert_eq "changes no event" "" "$(events)"
assert_contains "leaves versions.env alone" "$(versions)" "AIDP_VERSION=oldoldoldold"
assert_contains "prints the plan" "$OUT" "[dry-run]"
cleanup_sandbox

echo "rollback"
new_sandbox
touch "$SB/state/running-caddy"
for t in oldoldoldold newnewnewnew; do for i in aidp-server aidp-web aidp-backup aidp-ops-notify; do echo "$i:$t" >>"$SB/state/images"; done; done
printf 'AIDP_VERSION=newnewnewnew\nAIDP_PREVIOUS_VERSION=oldoldoldold\nAIDP_PREUPGRADE_DUMP=ai_discovery-X.dump.age\n' >"$SB/repo/deploy/versions.env"
run "$SB/repo/deploy/rollback.sh" --yes
E=$(events)
assert_status "succeeds" 0 "$STATUS"
assert_contains "brings up the previous tag" "$E" "compose-up version=oldoldoldold"
assert_contains "without building" "$E" "--no-build"
assert_not_contains "no compose build" "$E" "compose-build"
assert_not_contains "no docker build" "$E" "docker-build"
assert_not_contains "no pull anywhere" "$(cat "$SB/docker.log")" " pull"
assert_contains "swaps the versions" "$(versions)" "AIDP_VERSION=oldoldoldold"
assert_contains "so that running it again goes forward" "$(versions)" "AIDP_PREVIOUS_VERSION=newnewnewnew"
assert_contains "prints the data rollback instructions" "$OUT" "restore.sh ai_discovery-X.dump.age --force"
assert_before "maintenance page up around it" "$E" "maintenance-on" "compose-up"
cleanup_sandbox

new_sandbox
echo "aidp-server:oldoldoldold" >"$SB/state/images"
printf 'AIDP_VERSION=newnewnewnew\nAIDP_PREVIOUS_VERSION=oldoldoldold\n' >"$SB/repo/deploy/versions.env"
run "$SB/repo/deploy/rollback.sh" --yes
assert_status "is refused when the old images were pruned" 1 "$STATUS"
assert_contains "and names what is missing" "$OUT" "aidp-web:oldoldoldold"
assert_not_contains "and changes nothing" "$(events)" "compose-up"
assert_contains "and leaves the record alone" "$(versions)" "AIDP_VERSION=newnewnewnew"
cleanup_sandbox

new_sandbox
printf 'AIDP_VERSION=newnewnewnew\nAIDP_PREVIOUS_VERSION=\n' >"$SB/repo/deploy/versions.env"
run "$SB/repo/deploy/rollback.sh" --yes
assert_status "is refused when there is no previous version" 1 "$STATUS"
cleanup_sandbox

finish
