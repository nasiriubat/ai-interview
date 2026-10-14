#!/bin/bash
# Write deploy/.env for a production deployment, with strong random secrets.
#
#   deploy/generate-env.sh pilot.example.com ops@example.com
#
# Arguments: the public hostname DNS already points at this VPS, and the email address that
# becomes the platform operator, the first tenant's admin, and the ACME contact. Everything it
# writes can be edited afterwards except the secrets — see docs/DEPLOY.md, 'Secrets you cannot
# casually rotate'.
#
# It refuses to overwrite an existing file. Rotating PLATFORM_ENCRYPTION_KEY by regenerating
# this file locks the operator out of every stored provider key and SMTP password.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
# ENV_FILE_PATH lets a drill write somewhere other than the repository; it is the same variable
# dc, upgrade.sh and ensure-backup-key.sh read.
target="${ENV_FILE_PATH:-$here/.env}"

usage() {
	echo "usage: $0 <public-hostname> <operator-email> [admin-email]" >&2
	exit 64
}

[ $# -ge 2 ] || usage
hostname=$1
operator=$2
admin=${3:-$2}

case "$hostname" in
*.*) ;;
localhost) ;;
*) echo "$0: '$hostname' does not look like a hostname" >&2; exit 64 ;;
esac
case "$operator" in
*@*.*) ;;
*) echo "$0: '$operator' does not look like an email address" >&2; exit 64 ;;
esac

if [ -e "$target" ]; then
	echo "$0: $target already exists." >&2
	echo "Refusing to overwrite it: regenerating PLATFORM_ENCRYPTION_KEY would make every stored" >&2
	echo "provider key and SMTP password undecryptable. Edit the file by hand instead." >&2
	exit 1
fi

# 32 bytes base64 for the keys the application expects in that shape; hex for anything that ends
# up inside a connection URL, where +, / and = would need percent-encoding.
b64() { openssl rand -base64 32; }
hexs() { openssl rand -hex 24; }

command -v openssl >/dev/null || { echo "$0: openssl is required" >&2; exit 1; }

umask 077
cat >"$target" <<EOF
# Production environment for $hostname. Generated $(date -u +%Y-%m-%dT%H:%M:%SZ) by deploy/generate-env.sh.
# Mode 600, never committed, never copied into an image. Back it up somewhere other than this VPS:
# without PLATFORM_ENCRYPTION_KEY a database restore cannot decrypt provider keys.

# Names the volumes (aidp_pgdata, aidp_backups ...). An install made before this setting existed
# has volumes called deploy_pgdata and must put COMPOSE_PROJECT_NAME=deploy here instead, or the
# next upgrade starts on an empty database. upgrade.sh checks for exactly that and stops.
COMPOSE_PROJECT_NAME=aidp

PUBLIC_HOSTNAME=$hostname
ACME_EMAIL=$operator

# Secrets. Rotating the first two is not a routine operation; read docs/DEPLOY.md first.
PLATFORM_ENCRYPTION_KEY=$(b64)
AUTH_SECRET=$(b64)
POSTGRES_PASSWORD=$(hexs)
APP_DB_PASSWORD=$(hexs)

# First boot. Idempotent: these identities are created once and then ignored.
BOOTSTRAP_OPERATOR_EMAIL=$operator
BOOTSTRAP_ADMIN_EMAIL=$admin
BOOTSTRAP_TENANT_NAME=First tenant

# Outbound email. Magic links and invitations do not arrive until this points at a real relay.
# Empty EMAIL_SMTP_URL logs the message instead of sending it, which is fine for a smoke test
# and not fine for a pilot.
EMAIL_SMTP_URL=
EMAIL_FROM=no-reply@$hostname

# Optional: seeds a platform provider with default routes at first boot. Can also be done in the
# admin UI afterwards. Nothing works until 'interview_turn' has a route.
#
# Anthropic or OpenRouter runs the interviews. OPENAI_API_KEY is separate and worth setting even
# if you use one of the others: it is the only one that can transcribe audio, speak, or produce
# embeddings, so it is what turns on voice answers and semantic clustering in the analysis.
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=
OPENAI_API_KEY=

# Optional: Google sign-in for staff.
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Backups. Time is the container clock, which is UTC; a comma list runs it more than once a day.
BACKUP_AT=03:20
BACKUP_RETENTION_DAYS=14
# The backup is reported unhealthy, and alerted, when the last success is older than this.
BACKUP_MAX_AGE_HOURS=26

# Offsite copy of the (already encrypted) backups. Empty means none, and docs/OPERATIONS.md says
# what that costs you. rclone reads the remote from these variables, so there is no config file:
# name the remote 'offsite', give it a type and its credentials, and point RCLONE_REMOTE at a bucket
# on it. Example for an S3-compatible bucket (Hetzner, Scaleway):
#   RCLONE_REMOTE=offsite:my-aidp-backups
#   RCLONE_CONFIG_OFFSITE_TYPE=s3
#   RCLONE_CONFIG_OFFSITE_PROVIDER=Other
#   RCLONE_CONFIG_OFFSITE_ENDPOINT=https://fsn1.your-objectstorage.com
#   RCLONE_CONFIG_OFFSITE_ACCESS_KEY_ID=...
#   RCLONE_CONFIG_OFFSITE_SECRET_ACCESS_KEY=...
# Backblaze B2: RCLONE_CONFIG_OFFSITE_TYPE=b2, RCLONE_CONFIG_OFFSITE_ACCOUNT=..., RCLONE_CONFIG_OFFSITE_KEY=...
RCLONE_REMOTE=

# Where the operator is told when something breaks (docs/OPERATIONS.md has a section for each
# alert). Either or both. The settings screen (Operations alerts) overrides these once someone has
# set it; these are what works before that, and what the sidecar that runs when the application
# does not reads. ntfy: https://ntfy.sh/<a-long-random-topic>. Slack: an incoming-webhook URL, and
# ALERT_WEBHOOK_FORMAT=slack. Empty ALERT_EMAIL falls back to the operator address above.
ALERT_EMAIL=
ALERT_WEBHOOK_URL=
ALERT_WEBHOOK_FORMAT=ntfy

# Outbound model-call limits, in milliseconds. Empty keeps the defaults (120000 total, 20000 to
# the first token, 30000 of silence mid-stream, 2 retries); raise the first two for a slow
# self-hosted gateway.
PROVIDER_TIMEOUT_MS=
PROVIDER_FIRST_TOKEN_TIMEOUT_MS=
PROVIDER_IDLE_TIMEOUT_MS=
PROVIDER_MAX_RETRIES=

# Observability. Empty disables OTLP export.
OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=info

# Leave empty for Let's Encrypt. Set to 'local_certs' only to test without a public domain.
CADDY_LOCAL_CERTS=
EOF

chmod 600 "$target"
echo "wrote $target (mode 600)"

# The backup encryption key pair (D-95). Made here when this machine has age-keygen; otherwise
# deploy/upgrade.sh makes it from the backup image once that is built, before the first backup can
# run. Either way it ends up in this file, which is why the file must be copied off the host.
ENV_FILE_PATH="$target" "$here/ensure-backup-key.sh" || echo "(the backup key will be created by deploy/upgrade.sh)"

echo
echo "Next:"
echo "  1. set EMAIL_SMTP_URL to your relay (and ALERT_EMAIL / ALERT_WEBHOOK_URL, so a failure reaches you)"
echo "  2. copy $target somewhere other than this host (your password manager): it holds the keys to"
echo "     the database backups and to the stored provider keys"
echo "  3. ./deploy/upgrade.sh        # builds the images, starts the stack, checks it"
