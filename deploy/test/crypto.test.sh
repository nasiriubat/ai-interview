#!/bin/bash
# The real age, not the stand-in: a dump written through backup.sh's pipeline is ciphertext, only
# the matching identity reads it, and what comes back is byte for byte what went in.
#
# Needs `age` and `age-keygen` on PATH (the aidp-backup image has them; so does `apk add age`).
# Where they are missing this says so and exits 0: the plumbing tests in backup.test.sh and
# restore.test.sh run everywhere, and this one is the evidence that the plumbing's contract holds
# against the real tool. deploy/test/README in docs/OPERATIONS.md says how to run it in a container.
. "$(dirname "$0")/harness.sh"
trap 'rm -rf "${SB:-}"' EXIT

if ! command -v age >/dev/null || ! command -v age-keygen >/dev/null; then
	echo "crypto.test.sh: age is not installed here; not run"
	exit 0
fi

SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-crypto-test.XXXXXX")
keys=$(age-keygen 2>/dev/null)
recipient=$(echo "$keys" | sed -n 's/^# public key: //p')
echo "$keys" | grep '^AGE-SECRET-KEY-' >"$SB/identity"
other=$(age-keygen 2>/dev/null | grep '^AGE-SECRET-KEY-')
echo "$other" >"$SB/other-identity"

head -c 200000 /dev/urandom >"$SB/plain"
age -r "$recipient" <"$SB/plain" >"$SB/cipher"

assert_eq "ciphertext is not the plaintext" 1 "$(cmp -s "$SB/plain" "$SB/cipher" && echo 0 || echo 1)"
assert_eq "and does not contain it" 0 "$(grep -c 'PGDMP' "$SB/cipher" || true)"
age -d -i "$SB/identity" <"$SB/cipher" >"$SB/back"
assert_eq "the matching identity reads it back exactly" 1 "$(cmp -s "$SB/plain" "$SB/back" && echo 1 || echo 0)"
age -d -i "$SB/other-identity" <"$SB/cipher" >/dev/null 2>&1
assert_eq "another identity cannot" 1 "$([ $? -ne 0 ] && echo 1 || echo 0)"

finish
