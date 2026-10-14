# The ops-notify sidecar (D-94): a shell script, curl, openssl and jq on a small base. It is its own
# image, and not the application's, because the one thing it must not share with the application is
# the thing that is broken when it is needed.
#
# Also what creates the ops_state directories (the `ops-state-init` one-shot), because the writers
# of that volume run as three different users and a named volume starts out root-owned.
FROM alpine:3.22

RUN apk add --no-cache bash curl openssl jq ca-certificates coreutils

COPY ops/notify.sh /usr/local/bin/notify.sh
RUN chmod 0755 /usr/local/bin/notify.sh

# Unprivileged (Trivy DS-0002, D-312). uid 10001 owns the alert and watchdog directories of the
# ops_state volume (made so by the `ops-state-init` one-shot, which is the only thing here that
# runs as root, through `user: "0:0"` in compose), so it may move and delete the files the other
# writers leave there even though the directories are sticky.
RUN adduser -D -u 10001 -h /home/notify notify
USER 10001:10001

ENTRYPOINT ["/usr/local/bin/notify.sh"]
