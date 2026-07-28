#!/bin/bash
# One-shot backup run: pg_dump (the canonical record, bb_principles.md §1) + the per-user
# document git repos (docs/spec.md §6.6's known offsite-backup gap) + the already-encrypted
# secrets.enc.env, bundled and age-encrypted before it ever leaves this host, then pushed to
# whatever S3-compatible remote "backup" points at (see entrypoint.sh — provider-agnostic by
# design, only the rclone remote's env-var values are provider-specific).
set -euo pipefail

ts=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log() { echo "[$ts] backup: $*"; }

log "starting"

log "dumping postgres ($BIGBRAIN_PG_DATABASE)"
PGPASSWORD="$BIGBRAIN_PG_SUPERUSER_PASSWORD" pg_dump \
  -h postgres -p 5432 -U "$BIGBRAIN_PG_SUPERUSER" -d "$BIGBRAIN_PG_DATABASE" \
  -Fc -f "$work/postgres.dump"

log "archiving document repos"
tar -C /documents -czf "$work/documents.tar.gz" .

log "including secrets.enc.env"
cp /secrets/secrets.enc.env "$work/secrets.enc.env"

log "encrypting bundle"
tar -C "$work" -cf - postgres.dump documents.tar.gz secrets.enc.env \
  | age -r "$BIGBRAIN_BACKUP_AGE_PUBLIC_KEY" -o "$work/bundle.tar.age"

dest="backup:${BIGBRAIN_BACKUP_S3_BUCKET}/bigbrain/${ts}.tar.age"
log "uploading to $dest"
rclone copyto "$work/bundle.tar.age" "$dest"

log "done"
