#!/bin/bash
# generate-env.sh and ensure-backup-key.sh: that a fresh env file carries the project name, the
# alerting and offsite settings and a backup key pair, that an existing key is never replaced
# (replacing it would make every earlier backup unreadable), and that a machine with no age-keygen
# gets the key from the backup image instead.
. "$(dirname "$0")/harness.sh"
trap 'rm -rf "${SB:-}"' EXIT

ORIG_PATH=$PATH
setup() {
	# Each case starts from the real PATH; path_for_test narrows it again where a case needs that.
	export PATH=$ORIG_PATH
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-env-test.XXXXXX")
	# The repository layout the scripts expect: <repo>/deploy/{generate-env.sh,lib,backup}, and the
	# env file at <repo>/.env (D-450). $SB is the repository root.
	mkdir -p "$SB/bin" "$SB/deploy/lib" "$SB/deploy/backup"
	cp "$DEPLOY_DIR/generate-env.sh" "$SB/deploy/"
	cp "$DEPLOY_DIR/lib/lib.sh" "$SB/deploy/lib/"
	cp "$DEPLOY_DIR/backup/ensure-backup-key.sh" "$SB/deploy/backup/"
	cat >"$SB/age-keygen.out" <<'EOF'
# created: 2026-10-13T10:00:00Z
# public key: age1abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvw
AGE-SECRET-KEY-1ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789
EOF
	export SB
}
with_local_age() {
	cat >"$SB/bin/age-keygen" <<'FAKE'
#!/bin/bash
cat "$SB/age-keygen.out"
FAKE
	chmod +x "$SB/bin/age-keygen"
}
with_image_age() {
	cat >"$SB/bin/docker" <<'FAKE'
#!/bin/bash
echo "docker $*" >>"$SB/docker.log"
case "$1 $2" in
"image inspect") exit 0 ;;
"run --rm") cat "$SB/age-keygen.out" ;;
esac
FAKE
	chmod +x "$SB/bin/docker"
}
# A PATH of the fakes plus exactly the system tools the scripts use. The host's own age-keygen (a
# machine that has one, as the CI image of this test does) must not be reachable, or the "no
# age-keygen" cases would quietly test the other branch.
path_for_test() {
	local t p
	mkdir -p "$SB/bin"
	for t in bash sh sed grep egrep date cat chmod mkdir openssl head tr cut mktemp dirname basename stat \
		id rm mv cp env awk wc ls cksum tail sort uname printf; do
		p=$(type -P "$t" 2>/dev/null) || continue
		[ -e "$SB/bin/$t" ] || ln -s "$p" "$SB/bin/$t"
	done
	export PATH="$SB/bin"
}

echo "generate-env.sh with age-keygen on the machine"
setup
path_for_test
with_local_age
OUT=$("$SB/deploy/generate-env.sh" pilot.example.com ops@example.com 2>&1)
env="$SB/.env"
assert_eq "writes the file" 1 "$([ -f "$env" ] && echo 1 || echo 0)"
perm=$(stat -c %a "$env" 2>/dev/null || stat -f %Lp "$env")
assert_eq "with mode 600" 600 "$perm"
content=$(cat "$env")
assert_contains "pins the compose project name" "$content" "COMPOSE_PROJECT_NAME=aidp"
assert_contains "writes the backup recipient" "$content" "BACKUP_AGE_RECIPIENT=age1abcdefghijklmnopqrstuvwxyz"
assert_contains "and the identity" "$content" "BACKUP_AGE_IDENTITY=AGE-SECRET-KEY-1ABCDEF"
assert_contains "offers the alert variables" "$content" "ALERT_WEBHOOK_URL="
assert_contains "and the offsite variables" "$content" "RCLONE_REMOTE="
assert_contains "and the provider limits" "$content" "PROVIDER_TIMEOUT_MS="
for k in SMTP_HOST SMTP_PORT SMTP_SECURITY SMTP_USER SMTP_PASSWORD EMAIL_FROM; do
	assert_contains "writes the relay line $k (D-445)" "$content" "
$k="
done
assert_not_contains "and not the deprecated one-URL relay" "$content" "EMAIL_SMTP_URL"
assert_not_contains "nor tells anyone to write a URL with credentials" "$content" "smtp://"
assert_contains "the next steps name the split variables" "$OUT" "set SMTP_HOST"
assert_contains "tells the operator to copy the file off the host" "$OUT" "copy"
assert_contains "writes the repository-root .env, the one env file (D-450)" "$OUT" "wrote $(cd "$SB" && pwd)/.env (mode 600)"
assert_contains "lists the key names it wrote" "$OUT" "keys: COMPOSE_PROJECT_NAME PUBLIC_HOSTNAME"
secret=$(grep '^PLATFORM_ENCRYPTION_KEY=' "$env" | cut -d= -f2-)
assert_not_contains "and prints no secret value" "$OUT" "$secret"
assert_eq "nothing is written under deploy/" 0 "$(ls -A "$SB/deploy" | grep -c '^\.env' || true)"
before=$(cksum <"$env")
OUT=$("$SB/deploy/generate-env.sh" pilot.example.com ops@example.com 2>&1)
assert_status "refuses to overwrite an existing file" 1 "$?"
assert_contains "and says so" "$OUT" "already exists"
assert_contains "and names the way out" "$OUT" "--force"
assert_eq "the file is untouched" "$before" "$(cksum <"$env")"
OUT=$(ENV_FILE_PATH="$env" "$SB/deploy/backup/ensure-backup-key.sh" 2>&1)
assert_contains "ensure-backup-key leaves an existing key alone" "$OUT" "left as it is"
assert_eq "byte for byte" "$before" "$(cksum <"$env")"
rm -rf "$SB"

echo "--force replaces the file and keeps the old one"
setup
path_for_test
with_local_age
"$SB/deploy/generate-env.sh" pilot.example.com ops@example.com >/dev/null 2>&1
before=$(cksum <"$SB/.env")
OUT=$("$SB/deploy/generate-env.sh" other.example.com ops@example.com --force 2>&1)
assert_status "--force succeeds" 0 "$?"
assert_contains "the new file is written" "$(cat "$SB/.env")" "PUBLIC_HOSTNAME=other.example.com"
kept=$(ls "$SB"/.env.replaced-* 2>/dev/null | head -n1)
assert_eq "the old file is kept beside it" "$before" "$(cksum <"${kept:-/dev/null}")"
perm=$(stat -c %a "$kept" 2>/dev/null || stat -f %Lp "$kept")
assert_eq "with mode 600" 600 "$perm"
assert_contains "and the operator is told where" "$OUT" ".env.replaced-"
rm -rf "$SB"

echo "a legacy deploy/.env stops generate-env (D-450)"
setup
path_for_test
with_local_age
echo "AUTH_SECRET=legacy" >"$SB/deploy/.env"
OUT=$("$SB/deploy/generate-env.sh" pilot.example.com ops@example.com 2>&1)
assert_status "refused" 1 "$?"
assert_contains "with the move to make" "$OUT" "mv deploy/.env .env"
assert_eq "and no root .env was written" 0 "$([ -f "$SB/.env" ] && echo 1 || echo 0)"
rm -rf "$SB"

echo "no age-keygen and no image"
setup
path_for_test
OUT=$("$SB/deploy/generate-env.sh" pilot.example.com ops@example.com 2>&1)
STATUS=$?
assert_status "generate-env still succeeds" 0 "$STATUS"
assert_not_contains "and writes no empty key lines" "$(cat "$SB/.env")" "BACKUP_AGE_RECIPIENT="
assert_contains "and says upgrade.sh will make the key" "$OUT" "created by deploy/upgrade.sh"
OUT=$(ENV_FILE_PATH="$SB/.env" "$SB/deploy/backup/ensure-backup-key.sh" 2>&1)
assert_status "ensure-backup-key exits 2" 2 "$?"
rm -rf "$SB"

echo "the key comes from the backup image when the machine has none"
setup
path_for_test
with_image_age
"$SB/deploy/generate-env.sh" pilot.example.com ops@example.com >/dev/null 2>&1
OUT=$(ENV_FILE_PATH="$SB/.env" "$SB/deploy/backup/ensure-backup-key.sh" --image aidp-backup:abc 2>&1)
assert_status "succeeds" 0 "$?"
assert_contains "ran age-keygen in the image" "$(cat "$SB/docker.log")" "--entrypoint age-keygen aidp-backup:abc"
assert_contains "appended the recipient" "$(cat "$SB/.env")" "BACKUP_AGE_RECIPIENT=age1abcdefghijklmnopqrstuvwxyz"
perm=$(stat -c %a "$SB/.env" 2>/dev/null || stat -f %Lp "$SB/.env")
assert_eq "and kept mode 600" 600 "$perm"
assert_contains "and warned to copy the file off the host" "$OUT" "copy"
rm -rf "$SB"

echo "size presets and an env file outside the repository"
setup
with_local_age
cp -R "$DEPLOY_DIR/sizes" "$SB/deploy/sizes"
OUT=$(ENV_FILE_PATH="$SB/elsewhere.env" "$SB/deploy/generate-env.sh" pilot.example.com ops@example.com --size 4gb 2>&1)
STATUS=$?
assert_status "--size 4gb succeeds" 0 "$STATUS"
assert_eq "ENV_FILE_PATH is honoured: nothing is written at the root .env" 0 "$([ -f "$SB/.env" ] && echo 1 || echo 0)"
content=$(cat "$SB/elsewhere.env")
assert_contains "the 4 GB limits are appended" "$content" "API_MEMORY_LIMIT=1024M"
assert_contains "including the database buffers" "$content" "POSTGRES_SHARED_BUFFERS=192MB"
assert_not_contains "without the preset's comments" "$content" "Resource limits for a 4 GB host (deploy/generate-env.sh"
assert_contains "and the secrets are still generated" "$content" "PLATFORM_ENCRYPTION_KEY="
OUT=$("$SB/deploy/generate-env.sh" pilot.example.com ops@example.com --size 2gb 2>&1)
assert_status "an unknown size is refused" 64 "$?"
assert_contains "and the presets are named" "$OUT" "4gb"
# Every limit variable the production file reads has a value in the 8 GB preset, so the two cannot drift.
for var in $(grep -oE '\$\{[A-Z_]+_(MEMORY_LIMIT|SHARED_BUFFERS|MAX_CONNECTIONS):-' "$DEPLOY_DIR/compose.yml" | sed -E 's/\$\{([A-Z_]+):-/\1/'); do
	assert_contains "8gb.env sets $var" "$(cat "$DEPLOY_DIR/sizes/8gb.env")" "$var="
	assert_contains "4gb.env sets $var" "$(cat "$DEPLOY_DIR/sizes/4gb.env")" "$var="
done
rm -rf "$SB"

finish
