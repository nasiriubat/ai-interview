#!/bin/bash
# Makes sure deploy/.env holds the backup encryption keypair (D-95), creating it if it does not.
#
#   deploy/ensure-backup-key.sh [--image aidp-backup:<tag>]
#
# Backups are encrypted with `age`: the PUBLIC key (BACKUP_AGE_RECIPIENT) is all the backup job
# needs to write one, and the PRIVATE key (BACKUP_AGE_IDENTITY) is what restore.sh and the drill
# need to read one. Both live in deploy/.env, which is already the file that holds
# PLATFORM_ENCRYPTION_KEY and the database passwords. It does not add a secret to the host that
# was not there; what it changes is that the copy of the backup that leaves the host is ciphertext.
#
# The keypair is made by `age-keygen`, from the local machine when it has one, else from the
# backup image given with --image (which upgrade.sh builds first). Idempotent: a file that already
# has a recipient is left exactly as it is, because replacing the key would make every earlier
# backup unreadable.
#
# Exit codes: 0 present or created, 2 could not create (no age-keygen and no image).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
env_file="${ENV_FILE_PATH:-$here/.env}"
image=""
while [ $# -gt 0 ]; do
	case "$1" in
	--image) image=${2:?--image needs an image name}; shift ;;
	-h | --help) sed -n '2,20p' "$0"; exit 0 ;;
	*) echo "ensure-backup-key: unknown argument $1" >&2; exit 64 ;;
	esac
	shift
done

[ -f "$env_file" ] || { echo "ensure-backup-key: no env file at $env_file" >&2; exit 1; }

if grep -Eq '^BACKUP_AGE_RECIPIENT=age1[a-z0-9]+' "$env_file"; then
	echo "ensure-backup-key: $env_file already has a backup key; left as it is"
	exit 0
fi

if command -v age-keygen >/dev/null 2>&1; then
	generated=$(age-keygen 2>/dev/null)
elif [ -n "$image" ] && docker image inspect "$image" >/dev/null 2>&1; then
	generated=$(docker run --rm --entrypoint age-keygen "$image" 2>/dev/null)
else
	echo "ensure-backup-key: no age-keygen on this machine and no backup image to run it from." >&2
	echo "                   Run deploy/upgrade.sh, which builds the image first, or install age." >&2
	exit 2
fi

recipient=$(printf '%s\n' "$generated" | sed -n 's/^# public key: \(age1[a-z0-9]*\)$/\1/p' | head -n1)
identity=$(printf '%s\n' "$generated" | grep -E '^AGE-SECRET-KEY-' | head -n1)
if [ -z "$recipient" ] || [ -z "$identity" ]; then
	echo "ensure-backup-key: age-keygen produced no usable key pair" >&2
	exit 1
fi

umask 077
{
	printf '\n# Backup encryption (D-95), written by deploy/ensure-backup-key.sh on %s.\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	printf '# The recipient encrypts, the identity decrypts. LOSE THE IDENTITY AND EVERY BACKUP IS NOISE:\n'
	printf '# copy this file to your password manager now.\n'
	printf 'BACKUP_AGE_RECIPIENT=%s\n' "$recipient"
	printf 'BACKUP_AGE_IDENTITY=%s\n' "$identity"
} >>"$env_file"
chmod 600 "$env_file"

echo "ensure-backup-key: wrote a backup key pair to $env_file (recipient $recipient)"
echo "ensure-backup-key: copy $env_file somewhere other than this host NOW; without it the backups cannot be read"
