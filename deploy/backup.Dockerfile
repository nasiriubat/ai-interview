# The backup image (D-95): the Postgres image the server runs, so `pg_dump` is always the server's
# own major version, plus the three tools a trustworthy backup needs and the stock image lacks.
#
#   age     encrypts every dump and file archive before it touches the disk, so the copy that
#           leaves this host is ciphertext (docs/OPERATIONS.md, "Backups")
#   rclone  copies them offsite when RCLONE_REMOTE is set; configured from environment variables,
#           so there is no config file to mount, lose or leak
#   jq      writes the status file the health check, the sweep and the sidecar all read
#
# restore-drill.sh runs here too (D-227): the weekly restore into a scratch database, which needs
# the same pg_restore, age and jq, and nothing else.
#
# Built from deploy/ as the context, so the scripts below are baked in and carry the image's
# version: a rollback to a previous tag restores the backup logic of that release with it.
FROM pgvector/pgvector:pg16

RUN apt-get update \
 && apt-get install -y --no-install-recommends age rclone jq ca-certificates \
 && rm -rf /var/lib/apt/lists/*

COPY backup.sh /usr/local/bin/backup.sh
COPY backup-lib.sh /usr/local/bin/backup-lib.sh
COPY restore-drill.sh /usr/local/bin/restore-drill.sh
COPY backup-health.sh /usr/local/bin/backup-health.sh
RUN chmod 0755 /usr/local/bin/backup.sh /usr/local/bin/backup-lib.sh /usr/local/bin/restore-drill.sh /usr/local/bin/backup-health.sh

ENTRYPOINT ["/usr/local/bin/backup.sh"]
