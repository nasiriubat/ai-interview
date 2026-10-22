#!/bin/bash
# ops-notify: the alerting path that does not depend on the application being up (D-94).
#
# The application raises most alerts itself (packages/core/src/alerts). Five things it cannot
# report about itself, and this sidecar exists for them:
#
#   1. Files that shell producers drop in /ops-state/alerts/*.json: the RLS preflight (which runs
#      before the application and is the reason it will not start), the backup (offsite copy
#      failed), anything else that runs outside Node. Each file is one alert, in the field names
#      of packages/core/src/alerts/port.ts, posted to the same webhook and mailed to the same
#      operator, then moved to alerts/sent/.
#   2. worker.heartbeat_stale: the worker's heartbeat file has not been refreshed. A worker that
#      cannot reach the job queue cannot say so.
#   3. api.down: the API's readiness check has not answered for five minutes.
#   4. tls.renewal: the certificate Caddy is serving expires within 14 days, which means ACME
#      renewal has been failing for weeks without anyone being told.
#   5. While the worker is down: the backup status and the disk, because the sweep that normally
#      reads them is the worker.
#
# Configuration, all from .env through compose:
#   ALERT_WEBHOOK_URL, ALERT_WEBHOOK_FORMAT (ntfy|slack|generic, default ntfy)
#   ALERT_EMAIL (falls back to BOOTSTRAP_OPERATOR_EMAIL), EMAIL_FROM, and the relay:
#     SMTP_HOST, SMTP_PORT, SMTP_SECURITY (none|starttls|tls, default starttls), SMTP_USER,
#     SMTP_PASSWORD; or the deprecated EMAIL_SMTP_URL when SMTP_HOST is empty. The same rule as
#     resolveSmtpEnv in packages/shared/src/smtp.ts (D-447), written again here because this image
#     carries no Node.
#   PUBLIC_HOSTNAME (subjects, TLS check), API_READY_URL, TLS_CONNECT (default caddy:443)
#   CADDY_LOCAL_CERTS (set: Caddy issues its own short-lived certificates, so no expiry check)
#   ALERT_EMAIL_MIN_SEVERITY (warning), ALERT_WEBHOOK_MIN_SEVERITY (info)
#   DISK_WARN_PERCENT (80), DISK_CRITICAL_PERCENT (90), DISK_PATH (/watch/uploads)
#   BACKUP_MAX_AGE_HOURS (26)
#   NOTIFY_ONCE=1 runs one pass and exits (tests); NOTIFY_INTERVAL seconds between passes (60).
#
# Written for bash 3.2 and busybox userland: no associative arrays, no GNU-only flags.
set -u

STATE="${OPS_STATE_DIR:-/ops-state}"
INTERVAL="${NOTIFY_INTERVAL:-60}"
ONCE="${NOTIFY_ONCE:-0}"
HOST="${PUBLIC_HOSTNAME:-localhost}"
WEBHOOK_URL="${ALERT_WEBHOOK_URL:-}"
WEBHOOK_FORMAT="${ALERT_WEBHOOK_FORMAT:-ntfy}"
MAIL_TO="${ALERT_EMAIL:-${BOOTSTRAP_OPERATOR_EMAIL:-}}"
SMTP_URL="${EMAIL_SMTP_URL:-}"
RELAY_HOST="${SMTP_HOST:-}"
RELAY_SECURITY=$(printf '%s' "${SMTP_SECURITY:-starttls}" | tr 'A-Z' 'a-z')
RELAY_USER="${SMTP_USER:-}"
RELAY_PASSWORD="${SMTP_PASSWORD:-}"
case "$RELAY_SECURITY" in
'' | starttls) RELAY_SECURITY=starttls RELAY_DEFAULT_PORT=587 ;;
tls | ssl) RELAY_SECURITY=tls RELAY_DEFAULT_PORT=465 ;;
none) RELAY_DEFAULT_PORT=25 ;;
*) RELAY_SECURITY=invalid RELAY_DEFAULT_PORT=0 ;;
esac
RELAY_PORT="${SMTP_PORT:-$RELAY_DEFAULT_PORT}"
MAIL_FROM="${EMAIL_FROM:-no-reply@$HOST}"
EMAIL_MIN="${ALERT_EMAIL_MIN_SEVERITY:-warning}"
WEBHOOK_MIN="${ALERT_WEBHOOK_MIN_SEVERITY:-info}"
API_READY_URL="${API_READY_URL:-http://api:4000/api/v1/health/ready}"
TLS_CONNECT="${TLS_CONNECT:-caddy:443}"
DISK_PATH="${DISK_PATH:-/watch/uploads}"
DISK_WARN="${DISK_WARN_PERCENT:-80}"
DISK_CRIT="${DISK_CRITICAL_PERCENT:-90}"
BACKUP_MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
HEARTBEAT_STALE_SECONDS="${HEARTBEAT_STALE_SECONDS:-300}"
API_DOWN_SECONDS="${API_DOWN_SECONDS:-300}"
TLS_WARN_DAYS="${TLS_WARN_DAYS:-14}"
case "${CADDY_LOCAL_CERTS:-}" in
'' | 0 | false | no | off) LOCAL_CERTS=0 ;;
*) LOCAL_CERTS=1 ;;
esac

ALERTS="$STATE/alerts"
SENT="$ALERTS/sent"
WATCH="$STATE/watchdog"
STARTED="${NOTIFY_STARTED:-$(date +%s)}"

log() { echo "ops-notify: $(date -u +%Y-%m-%dT%H:%M:%SZ) $*"; }
now() { echo "${NOTIFY_NOW:-$(date +%s)}"; }
iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

sev_rank() {
	case "$1" in
	info) echo 0 ;;
	warning) echo 1 ;;
	critical) echo 2 ;;
	*) echo 1 ;;
	esac
}

file_mtime() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || echo 0; }

# Percent-decoding for the user and password inside an SMTP URL.
urldecode() {
	local s=${1//+/ }
	printf '%b' "${s//%/\\x}"
}

# ---- delivery ---------------------------------------------------------------------------------

# Renders one alert file as a webhook body in the configured shape. Mirrors webhookBody() in
# packages/core/src/alerts/webhook-alerts.ts; deploy/test/notify.test.sh holds them to the same
# fields.
render_webhook() {
	local file=$1 title text
	title="[aidp $HOST] $(jq -r '.title' "$file")"
	text=$(jq -r '.message + "\n\nWhat to do: " + .runbook' "$file")
	case "$WEBHOOK_FORMAT" in
	slack)
		jq -cn --arg title "$title" --arg text "$text" \
			'{text:$title,blocks:[{type:"section",text:{type:"mrkdwn",text:("*"+$title+"*\n"+$text)}}]}'
		;;
	generic)
		jq -c '{kind,severity,key,title,message,companyId:null,occurredAt,count:1,links:[],runbook,context:(.context // {})}' "$file"
		;;
	*)
		local rest topic
		rest=${WEBHOOK_URL#*://}
		topic=${rest#*/}
		topic=${topic%/}
		jq -c --arg topic "$topic" --arg title "$title" --arg text "$text" \
			'{topic:$topic,title:$title,message:$text,
			  priority:(if .severity=="critical" then 5 elif .severity=="warning" then 4 else 3 end),
			  tags:(if .severity=="critical" then ["rotating_light"] elif .severity=="warning" then ["warning"] else ["information_source"] end)}' "$file"
		;;
	esac
}

webhook_target() {
	if [ "$WEBHOOK_FORMAT" = "ntfy" ]; then
		local proto=${WEBHOOK_URL%%://*} rest=${WEBHOOK_URL#*://}
		echo "$proto://${rest%%/*}/"
	else
		echo "$WEBHOOK_URL"
	fi
}

post_webhook() {
	local file=$1 body
	body=$(render_webhook "$file") || return 1
	curl -fsS --max-time 10 -X POST -H 'content-type: application/json' --data "$body" "$(webhook_target)" >/dev/null
}

# Whether a relay is configured at all: SMTP_HOST, or the deprecated EMAIL_SMTP_URL.
mail_relay_set() { [ -n "$RELAY_HOST" ] || [ -n "$SMTP_URL" ]; }

send_mail() {
	local file=$1 msg subject rest hostport userinfo user pass url scheme tls_flag
	[ -n "$MAIL_TO" ] && mail_relay_set || return 1
	if [ -n "$RELAY_HOST" ] && [ "$RELAY_SECURITY" = invalid ]; then
		log "SMTP_SECURITY must be one of none, starttls, tls; not sending mail"
		return 1
	fi
	subject="[aidp $HOST] $(jq -r '.title' "$file" | tr -d '\r\n')"
	msg=$(mktemp)
	{
		printf 'From: %s\r\nTo: %s\r\nSubject: %s\r\nDate: %s\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n' \
			"$MAIL_FROM" "$MAIL_TO" "$subject" "$(date -u '+%a, %d %b %Y %H:%M:%S +0000')"
		jq -r '.message + "\n\nWhat to do: " + .runbook + "\n\nSent by ops-notify, which runs outside the application."' "$file"
	} >"$msg"
	if [ -n "$RELAY_HOST" ]; then
		# The split variables: credentials are used as written, nothing to decode.
		case "$RELAY_SECURITY" in
		tls) url="smtps://$RELAY_HOST:$RELAY_PORT" tls_flag="" ;;
		none) url="smtp://$RELAY_HOST:$RELAY_PORT" tls_flag="" ;;
		*) url="smtp://$RELAY_HOST:$RELAY_PORT" tls_flag="--ssl-reqd" ;;
		esac
		if [ -n "$RELAY_USER" ]; then
			curl -fsS --max-time 20 $tls_flag --url "$url" --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \
				--user "$RELAY_USER:$RELAY_PASSWORD" --upload-file "$msg" >/dev/null
		else
			curl -fsS --max-time 20 $tls_flag --url "$url" --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \
				--upload-file "$msg" >/dev/null
		fi
		local rc=$?
		rm -f "$msg"
		return $rc
	fi
	# Deprecated EMAIL_SMTP_URL: the credentials inside it are percent-encoded.
	scheme=${SMTP_URL%%://*}
	rest=${SMTP_URL#*://}
	userinfo=""
	hostport=$rest
	case "$rest" in *@*) userinfo=${rest%@*}; hostport=${rest##*@} ;; esac
	hostport=${hostport%%/*}
	url="$scheme://$hostport"
	if [ -n "$userinfo" ]; then
		user=$(urldecode "${userinfo%%:*}")
		pass=$(urldecode "${userinfo#*:}")
		curl -fsS --max-time 20 --ssl --url "$url" --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \
			--user "$user:$pass" --upload-file "$msg" >/dev/null
	else
		curl -fsS --max-time 20 --ssl --url "$url" --mail-from "$MAIL_FROM" --mail-rcpt "$MAIL_TO" \
			--upload-file "$msg" >/dev/null
	fi
	local rc=$?
	rm -f "$msg"
	return $rc
}

# Delivers one alert file through every channel its severity reaches. Returns 0 when at least one
# channel took it; 1 when it should be tried again.
deliver() {
	local file=$1 severity rank ok=1
	severity=$(jq -r '.severity // "warning"' "$file")
	rank=$(sev_rank "$severity")
	if [ -n "$WEBHOOK_URL" ] && [ "$rank" -ge "$(sev_rank "$WEBHOOK_MIN")" ]; then
		if post_webhook "$file"; then ok=0; else log "webhook delivery failed"; fi
	fi
	if [ -n "$MAIL_TO" ] && mail_relay_set && [ "$rank" -ge "$(sev_rank "$EMAIL_MIN")" ]; then
		if send_mail "$file"; then ok=0; else log "email delivery failed"; fi
	fi
	return $ok
}

# ---- alert files ------------------------------------------------------------------------------

repeat_seconds() {
	case "$1" in
	worker.heartbeat_stale | api.down | rls.preflight_failed) echo 3600 ;;
	*) echo 21600 ;;
	esac
}

# Runbook pointer for a kind: the heading GitHub generates drops the dots.
runbook_for() { echo "docs/OPERATIONS.md#$(echo "$1" | tr -d '.')"; }

process_files() {
	local f kind key last t repeat base
	mkdir -p "$SENT" "$WATCH" 2>/dev/null
	for f in "$ALERTS"/*.json; do
		[ -f "$f" ] || continue
		if ! jq -e '.kind and .title and .message' "$f" >/dev/null 2>&1; then
			log "ignoring $(basename "$f"): not an alert file"
			mv "$f" "$SENT/invalid-$(basename "$f")" 2>/dev/null
			continue
		fi
		kind=$(jq -r '.kind' "$f")
		key=$(jq -r '.key // .kind' "$f")
		# Fill the runbook pointer when the producer did not: the shell producers do not know the docs.
		if [ "$(jq -r '.runbook // empty' "$f")" = "" ]; then
			jq -c --arg r "$(runbook_for "$kind")" '. + {runbook:$r}' "$f" >"$f.tmp" && mv "$f.tmp" "$f"
		fi
		t=$(now)
		repeat=$(repeat_seconds "$kind")
		last=$(cat "$WATCH/file-$(echo "$key" | tr -c 'A-Za-z0-9._-' '_')" 2>/dev/null || echo 0)
		base=$(basename "$f")
		if [ $((t - last)) -lt "$repeat" ]; then
			mv "$f" "$SENT/duplicate-$base" 2>/dev/null
			continue
		fi
		if deliver "$f"; then
			echo "$t" >"$WATCH/file-$(echo "$key" | tr -c 'A-Za-z0-9._-' '_')"
			mv "$f" "$SENT/$base"
			log "delivered $kind ($base)"
		else
			log "could not deliver $kind ($base); will retry"
			# A file nobody can deliver for a day is moved aside so the directory does not grow.
			if [ $((t - $(file_mtime "$f"))) -gt 86400 ]; then mv "$f" "$SENT/undelivered-$base" 2>/dev/null; fi
		fi
	done
}

# ---- watchdog ---------------------------------------------------------------------------------

# Raises a watchdog condition as an alert file of our own, so it goes through the same
# deduplicating delivery as everything else; clears the marker when the condition is gone.
raise() {
	local kind=$1 severity=$2 key=$3 title=$4 message=$5 safe file
	safe=$(echo "$key" | tr -c 'A-Za-z0-9._-' '_')
	file="$ALERTS/watchdog-$safe.json"
	jq -cn --arg kind "$kind" --arg severity "$severity" --arg key "$key" --arg title "$title" \
		--arg message "$message" --arg at "$(iso)" \
		'{kind:$kind,severity:$severity,key:$key,title:$title,message:$message,occurredAt:$at}' >"$file.tmp" &&
		mv "$file.tmp" "$file"
}

clear_condition() { rm -f "$WATCH/file-$(echo "$1" | tr -c 'A-Za-z0-9._-' '_')" "$WATCH/since-$(echo "$1" | tr -c 'A-Za-z0-9._-' '_')"; }

worker_is_stale() {
	local hb="$STATE/heartbeat/worker" t age
	t=$(now)
	if [ -f "$hb" ]; then
		age=$((t - $(file_mtime "$hb")))
		[ "$age" -gt "$HEARTBEAT_STALE_SECONDS" ] && { STALE_FOR=$age; return 0; }
		return 1
	fi
	# Never written: only a problem once we have been up long enough for it to have been.
	age=$((t - STARTED))
	[ "$age" -gt "$HEARTBEAT_STALE_SECONDS" ] && { STALE_FOR=$age; return 0; }
	return 1
}

check_worker() {
	if worker_is_stale; then
		WORKER_DOWN=1
		raise worker.heartbeat_stale critical worker.heartbeat_stale "Worker heartbeat stale" \
			"The worker has not confirmed that it can reach the job queue for $((STALE_FOR / 60)) minutes; the container may be restarting or pg-boss cannot reach Postgres. Jobs are not being processed."
	else
		WORKER_DOWN=0
		clear_condition worker.heartbeat_stale
	fi
}

check_api() {
	local since_file="$WATCH/since-api.down" t first
	t=$(now)
	if curl -fsS --max-time 5 "$API_READY_URL" >/dev/null 2>&1; then
		rm -f "$since_file"
		clear_condition api.down
		return
	fi
	[ -f "$since_file" ] || echo "$t" >"$since_file"
	first=$(cat "$since_file" 2>/dev/null || echo "$t")
	if [ $((t - first)) -ge "$API_DOWN_SECONDS" ]; then
		raise api.down critical api.down "API is not answering" \
			"The API readiness check at $API_READY_URL has failed for $(((t - first) / 60)) minutes. Participants and staff cannot use the product."
	fi
}

# While the worker is down the application's own sweep is not running, so the two things it would
# have read are read here instead. When the worker is healthy the sweep owns them, and this stays
# quiet so one failure is one page.
check_backup() {
	local file="$STATE/status/backup.json" result ref age limit t
	t=$(now)
	[ -f "$file" ] || return 0
	result=$(jq -r '.lastResult // "none"' "$file" 2>/dev/null || echo none)
	if [ "$result" = "failed" ]; then
		raise backup.failed critical backup.failed "Backup failed" \
			"The last backup run failed: $(jq -r '.error // "no reason recorded"' "$file"). Last good: $(jq -r '.lastSuccessAt // "none recorded"' "$file")."
	else
		clear_condition backup.failed
	fi
	ref=$(jq -r '.lastSuccessEpoch // .startedEpoch // empty' "$file" 2>/dev/null)
	[ -n "$ref" ] || return 0
	age=$((t - ref))
	limit=$((BACKUP_MAX_AGE_HOURS * 3600))
	if [ "$age" -gt "$limit" ]; then
		raise backup.missing critical backup.missing "No successful backup for $((age / 3600)) h" \
			"The last successful backup was $((age / 3600)) hours ago; the limit is $BACKUP_MAX_AGE_HOURS."
	else
		clear_condition backup.missing
	fi
}

check_disk() {
	local used
	[ -d "$DISK_PATH" ] || return 0
	used=$(df -P "$DISK_PATH" 2>/dev/null | awk 'NR==2 {gsub("%","",$5); print $5}')
	case "$used" in '' | *[!0-9]*) return 0 ;; esac
	if [ "$used" -ge "$DISK_CRIT" ]; then
		raise disk.high critical disk.high:critical "Disk ${used}% used" \
			"The disk holding the uploads and the database is ${used}% used. Free space before Postgres stops accepting writes."
		clear_condition disk.high:warning
	elif [ "$used" -ge "$DISK_WARN" ]; then
		raise disk.high warning disk.high:warning "Disk ${used}% used" \
			"The disk holding the uploads and the database is ${used}% used."
		clear_condition disk.high:critical
	else
		clear_condition disk.high:warning
		clear_condition disk.high:critical
	fi
}

# Once a day: is the certificate Caddy serves going to be valid for another TLS_WARN_DAYS days.
# `openssl x509 -checkend` answers exactly that without parsing a date, which differs by userland.
# With CADDY_LOCAL_CERTS (behind a proxy such as Cloudflare) Caddy's internal authority issues
# 12-hour certificates and renews them itself, so every one is under the threshold by design and
# the visitor-facing certificate belongs to the proxy: there is nothing here to check.
check_tls() {
	local marker="$WATCH/tls-checked" t last cert days
	if [ "$LOCAL_CERTS" = 1 ]; then
		clear_condition tls.renewal
		return 0
	fi
	t=$(now)
	last=$(cat "$marker" 2>/dev/null || echo 0)
	[ $((t - last)) -ge 86400 ] || return 0
	echo "$t" >"$marker"
	cert=$(mktemp)
	if ! printf '' | openssl s_client -connect "$TLS_CONNECT" -servername "$HOST" 2>/dev/null |
		openssl x509 -outform PEM >"$cert" 2>/dev/null || [ ! -s "$cert" ]; then
		rm -f "$cert"
		log "tls check: could not read a certificate from $TLS_CONNECT"
		return 0
	fi
	if openssl x509 -in "$cert" -noout -checkend $((TLS_WARN_DAYS * 86400)) >/dev/null 2>&1; then
		clear_condition tls.renewal
	else
		days=0
		while [ "$days" -lt "$TLS_WARN_DAYS" ] && openssl x509 -in "$cert" -noout -checkend $(((days + 1) * 86400)) >/dev/null 2>&1; do
			days=$((days + 1))
		done
		raise tls.renewal critical tls.renewal "Certificate for $HOST expires in under $((days + 1)) days" \
			"The certificate served for $HOST expires in less than $((days + 1)) days and Caddy has not renewed it. Look at the ACME messages: dc logs caddy | grep -i acme."
	fi
	rm -f "$cert"
}

watchdog() {
	check_worker
	check_api
	if [ "${WORKER_DOWN:-0}" = 1 ]; then
		check_backup
		check_disk
	fi
	check_tls
}

# ---- main -------------------------------------------------------------------------------------

pass() {
	mkdir -p "$ALERTS" "$SENT" "$WATCH" "$STATE/heartbeat" "$STATE/status" 2>/dev/null
	watchdog
	process_files
	date +%s >"$WATCH/alive" 2>/dev/null || true
}

if [ "$ONCE" = 1 ]; then
	pass
	exit 0
fi

# The webhook URL is a credential (a Slack hook, an ntfy topic) and is never printed.
if [ -n "$WEBHOOK_URL" ]; then webhook_state="configured ($WEBHOOK_FORMAT)"; else webhook_state="none"; fi
# Only which variables configure the relay is printed: the values hold a password.
if [ -n "$RELAY_HOST" ]; then relay_state="SMTP_HOST ($RELAY_SECURITY)"; elif [ -n "$SMTP_URL" ]; then relay_state="EMAIL_SMTP_URL (deprecated)"; else relay_state="none"; fi
log "up: webhook $webhook_state, mail to ${MAIL_TO:-nobody} via relay $relay_state"
[ -n "$WEBHOOK_URL" ] || [ -n "$MAIL_TO" ] || log "WARNING: no ALERT_WEBHOOK_URL and no ALERT_EMAIL; alerts queue in $ALERTS and reach nobody"
while true; do
	pass
	sleep "$INTERVAL"
done
