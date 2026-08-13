# Standalone backup sidecar — never touches BIGIMAGINE_FIELD_ENCRYPTION_KEY or any provider
# credential, only Postgres's own dump and the already-encrypted secrets.enc.env. Kept out of
# the orchestrator image entirely, same "one thing, isolated" instinct as bigBrain's own backup
# sidecar — the orchestrator image stays a single service with a single job.
#
# postgresql16-client to match pgvector/pgvector:pg16 (docker-compose.yml's postgres service) —
# pg_dump's format is forward-compatible but not backward-compatible, so this must track the
# server's major version if that image tag ever changes.
FROM alpine:3.20
RUN apk add --no-cache bash postgresql16-client age rclone tzdata

COPY entrypoint.sh /entrypoint.sh
COPY backup.sh /backup.sh
RUN chmod +x /entrypoint.sh /backup.sh

ENTRYPOINT ["/entrypoint.sh"]
