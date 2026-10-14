#!/bin/bash
# deploy/ops/notify.sh, the alerting path that must work when the application does not (D-94).
#
# Run for real, one pass at a time (NOTIFY_ONCE=1, NOTIFY_NOW for the clock), against stand-ins for
# curl and openssl that record what would have gone on the wire. Each shell-side alert kind is
# provoked here: rls.preflight_failed (a file from the preflight), worker.heartbeat_stale, api.down,
# tls.renewal, and, with the worker down, backup.failed, backup.missing and disk.high.
. "$(dirname "$0")/harness.sh"
trap 'rm -rf "${SB:-}"' EXIT

command -v jq >/dev/null || { echo "notify.test.sh: jq is required"; exit 1; }

setup() {
	SB=$(mktemp -d "${TMPDIR:-/tmp}/aidp-notify-test.XXXXXX")
	mkdir -p "$SB/bin" "$SB/state" "$SB/ops/alerts" "$SB/ops/heartbeat" "$SB/ops/status" "$SB/uploads"
	: >"$SB/curl.log"
	cat >"$SB/bin/curl" <<'FAKE'
#!/bin/bash
# stand-in: logs the call, keeps a posted body, fails readiness / webhook / smtp on request
echo "curl $*" >>"$SB/curl.log"
url=""
body=""
prev=""
for a in "$@"; do
	case "$prev" in --data) body=$a ;; esac
	case "$a" in http*|smtp*) url=$a ;; esac
	prev=$a
done
case "$url" in
*api*/health/ready) [ -e "$SB/state/api-down" ] && exit 22; exit 0 ;;
smtp*) [ -e "$SB/state/smtp-fails" ] && exit 55; exit 0 ;;
esac
[ -e "$SB/state/webhook-fails" ] && exit 22
[ -n "$body" ] && printf '%s\n' "$body" >>"$SB/posts.log"
exit 0
FAKE
	cat >"$SB/bin/openssl" <<'FAKE'
#!/bin/bash
case "$1" in
s_client) [ -e "$SB/state/tls-unreachable" ] && exit 1; echo "CERT" ;;
x509)
	shift
	for a in "$@"; do
		case "$a" in
		-outform) cat; exit 0 ;;
		esac
	done
	# -checkend SECONDS: succeeds when the certificate is valid for at least that long
	secs=""
	prev=""
	for a in "$@"; do
		[ "$prev" = "-checkend" ] && secs=$a
		prev=$a
	done
	days=$(cat "$SB/state/tls-days" 2>/dev/null || echo 80)
	[ $((days * 86400)) -gt "$secs" ]
	exit $?
	;;
esac
FAKE
	cat >"$SB/bin/df" <<'FAKE'
#!/bin/bash
echo "Filesystem 1024-blocks Used Available Capacity Mounted"
echo "/dev/x 1000 100 100 $(cat "$SB/state/disk" 2>/dev/null || echo 40)% /"
FAKE
	chmod +x "$SB/bin/"*
	: >"$SB/posts.log"
	export SB PATH="$SB/bin:$PATH"
	export OPS_STATE_DIR="$SB/ops" NOTIFY_ONCE=1 PUBLIC_HOSTNAME=pilot.example.com
	export ALERT_WEBHOOK_URL="https://ntfy.example.com/aidp-ops" ALERT_WEBHOOK_FORMAT=ntfy
	export ALERT_EMAIL="" EMAIL_SMTP_URL="" EMAIL_FROM="no-reply@pilot.example.com"
	export SMTP_HOST="" SMTP_PORT="" SMTP_SECURITY="" SMTP_USER="" SMTP_PASSWORD=""
	export DISK_PATH="$SB/uploads" TLS_CONNECT="caddy:443"
	export API_READY_URL="http://api:4000/api/v1/health/ready"
	export NOTIFY_STARTED NOTIFY_NOW
	NOTIFY_STARTED=$(date +%s)
	NOTIFY_NOW=$NOTIFY_STARTED
	# a healthy worker unless a test says otherwise
	date +%s >"$SB/ops/heartbeat/worker"
	: >"$SB/ops/watchdog-seed"
	# the daily TLS check has run today, so a pass does not do it unless a test asks
	mkdir -p "$SB/ops/watchdog" && echo "$NOTIFY_NOW" >"$SB/ops/watchdog/tls-checked"
}

pass_once() { OUT=$("$DEPLOY_DIR/ops/notify.sh" 2>&1); }
posts() { cat "$SB/posts.log"; }
sent() { ls "$SB/ops/alerts/sent" 2>/dev/null; }
drop() { printf '%s\n' "$2" >"$SB/ops/alerts/$1"; }
PREFLIGHT='{"kind":"rls.preflight_failed","severity":"critical","key":"rls.preflight_failed","title":"RLS preflight failed on boot","message":"these tables carry a companyId but have no row-level security: OpsAlert. api and worker did not start.","occurredAt":"2026-10-13T10:00:00Z"}'

echo "a file from the preflight"
setup
drop "rls.preflight_failed-1.json" "$PREFLIGHT"
pass_once
body=$(posts | head -n1)
assert_eq "is posted to the ntfy server root" 1 "$(grep -c 'ntfy.example.com/' "$SB/curl.log")"
assert_eq "as a message for the topic" aidp-ops "$(echo "$body" | jq -r .topic)"
assert_eq "at the top priority" 5 "$(echo "$body" | jq -r .priority)"
assert_contains "with the subject prefix" "$(echo "$body" | jq -r .title)" "[aidp pilot.example.com] RLS preflight failed on boot"
assert_contains "and the runbook the shell producer did not know" "$(echo "$body" | jq -r .message)" "docs/OPERATIONS.md#rlspreflight_failed"
assert_eq "moves the file to sent/" 1 "$(sent | grep -c 'rls.preflight_failed-1.json')"
assert_eq "leaves nothing queued" 0 "$(ls "$SB/ops/alerts"/*.json 2>/dev/null | wc -l | tr -d ' ')"
drop "rls.preflight_failed-2.json" "$PREFLIGHT"
pass_once
assert_eq "the same key again inside the window is not posted twice" 1 "$(posts | wc -l | tr -d ' ')"
assert_eq "but is not left queued" 0 "$(ls "$SB/ops/alerts"/*.json 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "formats"
setup
export ALERT_WEBHOOK_FORMAT=generic ALERT_WEBHOOK_URL="https://hooks.example.com/x"
drop "a.json" "$PREFLIGHT"
pass_once
generic=$(posts | head -n1)
assert_eq "generic carries the fields TypeScript's generic body carries" \
	"companyId,context,count,key,kind,links,message,occurredAt,runbook,severity,title" \
	"$(echo "$generic" | jq -r 'keys | join(",")')"
assert_eq "to the URL as given" 1 "$(grep -c 'https://hooks.example.com/x' "$SB/curl.log")"
rm -rf "$SB"
setup
export ALERT_WEBHOOK_FORMAT=slack ALERT_WEBHOOK_URL="https://hooks.slack.example/T/B/x"
drop "a.json" "$PREFLIGHT"
pass_once
slack=$(posts | head -n1)
assert_eq "slack is text plus one section block" "section" "$(echo "$slack" | jq -r '.blocks[0].type')"
assert_contains "whose title is the subject" "$(echo "$slack" | jq -r .text)" "RLS preflight failed"
rm -rf "$SB"

echo "email through the split SMTP_* variables (D-447)"
setup
export ALERT_WEBHOOK_URL="" ALERT_EMAIL="ops@example.com"
export SMTP_HOST="smtp.example.com" SMTP_PORT="587" SMTP_SECURITY="starttls" SMTP_USER="relay@x"
export SMTP_PASSWORD='p@ss:w/rd#1 %41 x'
export EMAIL_SMTP_URL="smtp://legacy.example.com:25"
drop "a.json" "$PREFLIGHT"
pass_once
smtp=$(grep -- '--mail-rcpt' "$SB/curl.log" | head -n1)
assert_contains "SMTP_HOST wins over the legacy URL" "$smtp" "--url smtp://smtp.example.com:587"
assert_contains "starttls is required, not attempted" "$smtp" "--ssl-reqd"
assert_contains "the credentials go through as written, nothing decoded" "$smtp" "--user relay@x:p@ss:w/rd#1 %41 x"
assert_eq "and the file counts as delivered" 1 "$(sent | grep -c 'a.json')"
rm -rf "$SB"

setup
export ALERT_WEBHOOK_URL="" ALERT_EMAIL="ops@example.com" SMTP_HOST="mail.example.com" SMTP_SECURITY="tls"
drop "a.json" "$PREFLIGHT"
pass_once
smtp=$(grep -- '--mail-rcpt' "$SB/curl.log" | head -n1)
assert_contains "tls is implicit TLS on 465 by default" "$smtp" "--url smtps://mail.example.com:465"
assert_not_contains "with no user, no --user" "$smtp" "--user"
rm -rf "$SB"

setup
export ALERT_WEBHOOK_URL="" ALERT_EMAIL="ops@example.com" SMTP_HOST="mailpit" SMTP_PORT="1025" SMTP_SECURITY="none"
drop "a.json" "$PREFLIGHT"
pass_once
smtp=$(grep -- '--mail-rcpt' "$SB/curl.log" | head -n1)
assert_contains "none is plain SMTP" "$smtp" "--url smtp://mailpit:1025"
assert_not_contains "without asking for TLS" "$smtp" "--ssl"
rm -rf "$SB"

setup
export ALERT_WEBHOOK_URL="" ALERT_EMAIL="ops@example.com" SMTP_HOST="smtp.example.com" SMTP_SECURITY="maybe"
drop "a.json" "$PREFLIGHT"
pass_once
assert_eq "an unknown SMTP_SECURITY sends nothing" 0 "$(grep -c -- '--mail-rcpt' "$SB/curl.log")"
rm -rf "$SB"

echo "email through the deprecated EMAIL_SMTP_URL"
setup
export ALERT_WEBHOOK_URL="" ALERT_EMAIL="ops@example.com" EMAIL_SMTP_URL="smtp://relay%40x:p%40ss@smtp.example.com:587"
drop "a.json" "$PREFLIGHT"
pass_once
smtp=$(grep -- '--mail-rcpt' "$SB/curl.log" | head -n1)
assert_contains "goes to the operator" "$smtp" "--mail-rcpt ops@example.com"
assert_contains "through the relay, without credentials in the URL" "$smtp" "--url smtp://smtp.example.com:587"
assert_contains "with the credentials decoded" "$smtp" "--user relay@x:p@ss"
assert_eq "and the file counts as delivered" 1 "$(sent | grep -c 'a.json')"
touch "$SB/state/smtp-fails"
drop "b.json" '{"kind":"backup.offsite_failed","severity":"critical","key":"backup.offsite_failed","title":"t","message":"m"}'
pass_once
assert_eq "an undeliverable file stays queued for the next pass" 1 "$(ls "$SB/ops/alerts"/b.json 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "the severity floors"
setup
drop "info.json" '{"kind":"alerts.storm","severity":"info","key":"x","title":"t","message":"m"}'
export ALERT_WEBHOOK_MIN_SEVERITY=warning
pass_once
assert_eq "an alert below every floor is not posted" 0 "$(posts | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "worker.heartbeat_stale"
setup
touch -t 202601010000 "$SB/ops/heartbeat/worker"
pass_once
assert_contains "a stale heartbeat is posted" "$(posts | jq -r .title)" "Worker heartbeat stale"
assert_eq "once" 1 "$(posts | wc -l | tr -d ' ')"
date +%s >"$SB/ops/heartbeat/worker"
pass_once
assert_eq "a fresh one raises nothing more" 1 "$(posts | wc -l | tr -d ' ')"
assert_eq "and clears the condition so the next failure is announced" 0 "$(ls "$SB/ops/watchdog"/file-worker* 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$SB"
setup
rm "$SB/ops/heartbeat/worker"
pass_once
assert_eq "a heartbeat that never appeared is not stale at boot" 0 "$(posts | wc -l | tr -d ' ')"
export NOTIFY_NOW=$((NOTIFY_STARTED + 400))
pass_once
assert_contains "but is, once the sidecar has been up long enough" "$(posts | jq -r .title)" "Worker heartbeat stale"
rm -rf "$SB"

echo "api.down"
setup
touch "$SB/state/api-down"
pass_once
assert_eq "one failed check is not an alert" 0 "$(posts | wc -l | tr -d ' ')"
export NOTIFY_NOW=$((NOTIFY_STARTED + 200))
date +%s >"$SB/ops/heartbeat/worker"
pass_once
assert_eq "nor is a short outage" 0 "$(posts | wc -l | tr -d ' ')"
export NOTIFY_NOW=$((NOTIFY_STARTED + 320))
pass_once
assert_contains "five minutes of failure is" "$(posts | jq -r .title)" "API is not answering"
rm "$SB/state/api-down"
pass_once
assert_eq "the outage ending clears it" 0 "$(ls "$SB/ops/watchdog"/file-api* 2>/dev/null | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "tls.renewal"
setup
rm -f "$SB/ops/watchdog/tls-checked"
echo 9 >"$SB/state/tls-days"
pass_once
assert_contains "a certificate with nine days left is posted" "$(posts | jq -r .title)" "expires in under 9 days"
assert_contains "naming the host" "$(posts | jq -r .title)" "pilot.example.com"
pass_once
assert_eq "and the check runs once a day, not every minute" 1 "$(posts | wc -l | tr -d ' ')"
rm -rf "$SB"
setup
rm -f "$SB/ops/watchdog/tls-checked"
echo 60 >"$SB/state/tls-days"
pass_once
assert_eq "a healthy certificate raises nothing" 0 "$(posts | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "with the worker down, the backup and the disk are read here"
setup
touch -t 202601010000 "$SB/ops/heartbeat/worker"
echo "{\"lastResult\":\"failed\",\"error\":\"pg_dump failed\",\"lastSuccessEpoch\":$((NOTIFY_NOW - 40 * 3600)),\"lastSuccessAt\":\"2026-10-11T03:20:00Z\"}" >"$SB/ops/status/backup.json"
echo 95 >"$SB/state/disk"
pass_once
titles=$(posts | jq -r .title)
assert_contains "a failed backup" "$titles" "Backup failed"
assert_contains "a missing backup" "$titles" "No successful backup for 40 h"
assert_contains "a full disk" "$titles" "Disk 95% used"
rm -rf "$SB"
setup
echo "{\"lastResult\":\"failed\",\"error\":\"pg_dump failed\"}" >"$SB/ops/status/backup.json"
echo 95 >"$SB/state/disk"
pass_once
assert_eq "with the worker healthy the sidecar leaves both to the sweep" 0 "$(posts | wc -l | tr -d ' ')"
rm -rf "$SB"

echo "the webhook URL is never printed"
setup
export ALERT_WEBHOOK_URL="https://hooks.example.com/SECRET-TOKEN-123"
export ALERT_WEBHOOK_FORMAT=generic NOTIFY_ONCE=0 NOTIFY_INTERVAL=1
# run the long-lived mode briefly: its start-up line is where a URL could leak
"$DEPLOY_DIR/ops/notify.sh" >"$SB/long.log" 2>&1 &
pid=$!
sleep 1
kill "$pid" 2>/dev/null
wait "$pid" 2>/dev/null
OUT=$(cat "$SB/long.log")
assert_not_contains "start-up log" "$OUT" "SECRET-TOKEN-123"
assert_contains "but says it is configured" "$OUT" "webhook configured (generic)"
touch "$SB/state/webhook-fails"
export NOTIFY_ONCE=1
drop "a.json" "$PREFLIGHT"
pass_once
assert_not_contains "nor a failed delivery's log" "$OUT" "SECRET-TOKEN-123"
rm -rf "$SB"

finish
