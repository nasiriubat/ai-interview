#!/bin/bash
# deploy/signin-link.sh, the break-glass sign-in wrapper (D-440). Run against the fake docker: it
# must call the CLI in the api container, through deploy/dc, with no terminal (so stdout is the link
# alone), pass the address as one argument, and refuse a missing or extra argument before docker.
# What the CLI itself does is apps/api/test/signin-link.e2e.test.ts.
. "$(dirname "$0")/harness.sh"
trap cleanup_sandbox EXIT

new_sandbox
cp "$DEPLOY_DIR/signin-link.sh" "$SB/repo/deploy/signin-link.sh"
chmod +x "$SB/repo/deploy/signin-link.sh"
echo "AIDP_VERSION=v1" >"$SB/repo/deploy/versions.env"
script="$SB/repo/deploy/signin-link.sh"

out=$("$script" 2>&1)
assert_status "no argument is a usage error" 2 $?
assert_contains "no argument prints usage" "$out" "usage: deploy/signin-link.sh <email>"

"$script" a@example.com b@example.com >/dev/null 2>&1
assert_status "two arguments are a usage error" 2 $?
"$script" --all >/dev/null 2>&1
assert_status "a flag is not an address" 2 $?
assert_eq "nothing reached docker on a usage error" "" "$(cat "$SB/docker.log")"

out=$("$script" --help)
assert_status "--help succeeds" 0 $?
assert_contains "--help explains the 15-minute single-use link" "$out" "valid"

"$script" 'admin@example.com' >/dev/null 2>&1
assert_status "an address runs the CLI" 0 $?
log=$(cat "$SB/docker.log")
assert_contains "runs through compose with the production file" "$log" "compose.prod.yml"
assert_contains "runs the CLI in the api container without a terminal" "$log" \
	"exec -T api node apps/api/dist/cli/signin-link.js admin@example.com"

finish
