#!/bin/bash
# The image builds, checked without building them.
#
# `docker build` is the one thing the deploy harnesses never ran, and the first time it ran after
# the M3 merge the web image did not build: `next build` type-checks everything tsconfig.json
# includes, e2e/fixtures.ts among it, and that file imports a template from packages/db, which the
# Dockerfile did not copy. These checks are the cheap half of that lesson: every file outside
# apps/web that a type-checked file reaches must be in the Dockerfile's build stage, and the
# compose files must be what the drill scripts expect.
. "$(dirname "$0")/harness.sh"

REPO=$(cd "$DEPLOY_DIR/.." && pwd)
WEB="$REPO/apps/web"
DOCKERFILE="$WEB/Dockerfile"

echo "web image: files the type check reaches outside apps/web"
# Relative imports that climb out of apps/web, from every directory its tsconfig includes.
imports=$(grep -rhoE "from \"(\.\./){3,}(packages|evals|scripts|tools)/[^\"]+\"|import\(\"(\.\./){3,}(packages|evals|scripts|tools)/[^\"]+\"" \
	"$WEB/src" "$WEB/test" "$WEB/e2e" "$WEB/scripts" "$WEB/vitest.setup.ts" "$WEB/playwright.config.ts" 2>/dev/null |
	grep -oE "(packages|evals|scripts|tools)/[^\"]+" | sort -u)
if [ -z "$imports" ]; then
	pass "no file under apps/web imports from outside it (nothing to copy)"
else
	while IFS= read -r rel; do
		[ -n "$rel" ] || continue
		# Covered when some COPY line in the Dockerfile copies a directory that contains the file.
		covered=0
		dir=$(dirname "$rel")
		while [ "$dir" != "." ] && [ "$dir" != "/" ]; do
			if grep -qE "^COPY ${dir//./\\.} " "$DOCKERFILE"; then covered=1; break; fi
			dir=$(dirname "$dir")
		done
		if [ "$covered" = 1 ]; then pass "$rel is copied into the web build"; else fail "$rel is imported by a type-checked file and not copied by apps/web/Dockerfile"; fi
	done <<<"$imports"
fi

echo "the fake-provider overlay"
overlay="$DEPLOY_DIR/compose.fake.yml"
assert_contains "the overlay adds the fake provider" "$(cat "$overlay")" "fake-provider:"
assert_contains "the overlay adds a mail catcher" "$(cat "$overlay")" "mailpit:"
assert_not_contains "the production file never mentions the fake" "$(cat "$DEPLOY_DIR/compose.prod.yml")" "fake-provider"
assert_not_contains "the production file never mentions the mail catcher" "$(cat "$DEPLOY_DIR/compose.prod.yml")" "mailpit"
dockerfile_fake="$REPO/tools/fake-provider/Dockerfile"
assert_contains "the fake's Dockerfile builds from the repository root" "$(cat "$dockerfile_fake")" "COPY tools/fake-provider/src"

echo "grants.sql repairs what only a restore loses"
grants="$(cat "$DEPLOY_DIR/grants.sql")"
# preflight.sh refuses to start the stack without CREATE on the database; a restore recreates the
# database and the dump carries no database-level GRANT, so this file is the only place left to say it.
assert_contains "grants CREATE on the database to app_api" "$grants" "GRANT CREATE ON DATABASE"
assert_contains "and preflight is what asks for it" "$(cat "$DEPLOY_DIR/preflight.sh")" "'CREATE'"

echo "the Caddyfile"
caddyfile="$DEPLOY_DIR/Caddyfile"
# A log filter field takes one filter type. A `regexp` and a `query` on request>uri in the same
# block made Caddy refuse the whole file and restart forever; the pair has to be one multi_regexp.
mixed=$(awk '
	/request>uri[[:space:]]+regexp/ {re=1}
	/request>uri[[:space:]]+query/ {q=1}
	END {print (re && q) ? "mixed" : "ok"}' "$caddyfile")
assert_eq "request>uri does not mix regexp and query filters" "ok" "$mixed"
assert_contains "the access log redacts path tokens and secret query values" "$(cat "$caddyfile")" "multi_regexp"

# The real parser, when this machine has Docker and the Caddy image already: the adapter is the
# only thing that knows what Caddy accepts. Not pulled here: the harness is offline by contract.
if docker image inspect caddy:2-alpine >/dev/null 2>&1; then
	out=$(docker run --rm -e ACME_EMAIL=ops@example.com -e PUBLIC_HOSTNAME=pilot.example.com -e CADDY_LOCAL_CERTS= \
		-v "$caddyfile:/etc/caddy/Caddyfile:ro" caddy:2-alpine caddy adapt --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1)
	status=$?
	assert_status "caddy adapts the Caddyfile" 0 "$status"
	[ "$status" = 0 ] || echo "$out" | tail -n 5
else
	echo "  note caddy:2-alpine is not on this machine; the adapter check was not run"
fi

finish
