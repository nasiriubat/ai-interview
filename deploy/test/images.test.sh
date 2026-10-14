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

finish
