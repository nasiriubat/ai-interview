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
target="$here/.env"

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
ANTHROPIC_API_KEY=
OPENROUTER_API_KEY=

# Optional: Google sign-in for staff.
AUTH_GOOGLE_ID=
AUTH_GOOGLE_SECRET=

# Backups. Time is the container clock, which is UTC.
BACKUP_AT=03:20
BACKUP_RETENTION_DAYS=14

# Observability. Empty disables OTLP export.
OTEL_EXPORTER_OTLP_ENDPOINT=
LOG_LEVEL=info

# Leave empty for Let's Encrypt. Set to 'local_certs' only to test without a public domain.
CADDY_LOCAL_CERTS=
EOF

chmod 600 "$target"
echo "wrote $target (mode 600)"
echo
echo "Next: set EMAIL_SMTP_URL to your relay, then"
echo "  docker compose -f deploy/compose.prod.yml --env-file deploy/.env up -d --build"
