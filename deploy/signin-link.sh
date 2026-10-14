#!/bin/bash
# Break-glass sign-in: prints a one-time sign-in link for an existing staff user (D-440).
#
#   deploy/signin-link.sh admin@example.com
#
# For the day the mail relay is wrong or down and nobody can get a sign-in email: a fresh install
# with a mistyped EMAIL_SMTP_URL, or the only admin signed out while the relay is broken. Shell
# access to this server already means full control (deploy/.env holds AUTH_SECRET), so this adds no
# privilege. It runs `node apps/api/dist/cli/signin-link.js <email>` inside the running api
# container, which:
#   - refuses an address that is not an existing, enabled staff user (operator, admin or member),
#     and a tenant user whose organization is suspended;
#   - stores a token exactly as the email sign-in would (hashed with AUTH_SECRET, single use), valid
#     for 15 minutes, and prints the link built from PUBLIC_WEB_URL on stdout, nothing else secret;
#   - writes the audit row auth.signin_link_issued (actor "cli", target the user, no token) and a
#     warning line on stderr.
# Open the link in the browser that should be signed in. Then fix the relay: invitations, reports
# and everyone else's sign-in still need EMAIL_SMTP_URL (docs/OPERATIONS.md, "Locked out / email
# not working").
#
# Exit status: 0 issued, 1 refused, 2 usage or configuration.
set -euo pipefail

usage() { echo "usage: deploy/signin-link.sh <email>" >&2; exit 2; }
case "${1:-}" in
-h | --help) sed -n '2,21p' "$0"; exit 0 ;;
"" | -*) usage ;;
esac
[ $# -eq 1 ] || usage

here=$(cd "$(dirname "$0")" && pwd)
# -T: no terminal, so the link is the only thing on stdout and `url=$(deploy/signin-link.sh x)` works.
exec "$here/dc" exec -T api node apps/api/dist/cli/signin-link.js "$1"
