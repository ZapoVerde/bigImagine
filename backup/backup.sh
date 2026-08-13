#!/bin/bash
# One-shot backup run, closing docs/spec.md §3/§8's offsite-backup gap (see
# docs/plans/completed/bigimagine-backup-plan.md): pg_dump (the canonical record,
# bi_principles.md §1) + the per-user document store + character avatar PNGs
# (plugins/characters/src/avatarStorage.ts — the one piece of character-card data that isn't in
# Postgres and isn't re-fetchable from a provider, unlike Vistalyze's location images, which are
# just provider URLs already covered by postgres.dump) + the already-encrypted secrets.enc.env,
# bundled and age-encrypted before it ever leaves this host, then pushed to whatever
# S3-compatible remote "backup" points at (see entrypoint.sh — provider-agnostic by design, only
# the rclone remote's env-var values are provider-specific).
#
# BACKUP_OBJECT_PREFIX (no BIGBRAIN_/BIGIMAGINE_ prefix — generic to whichever stack sets it)
# names this stack's object-key prefix under the shared bucket; each stack's docker-compose.yml
# sets it explicitly (bigbrain vs bigimagine). Deliberately no default below — an unset var
# fails loudly here (set -u) rather than silently writing under the wrong stack's prefix.
set -euo pipefail

ts=$(date -u +%Y%m%dT%H%M%SZ)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

log() { echo "[$ts] backup: $*"; }

log "starting"

log "dumping postgres ($BIGIMAGINE_PG_DATABASE)"
PGPASSWORD="$BIGIMAGINE_PG_SUPERUSER_PASSWORD" pg_dump \
  -h postgres -p 5432 -U "$BIGIMAGINE_PG_SUPERUSER" -d "$BIGIMAGINE_PG_DATABASE" \
  -Fc -f "$work/postgres.dump"

log "archiving document store"
tar -C /documents -czf "$work/documents.tar.gz" .

log "archiving character avatars"
tar -C /character-media -czf "$work/character-media.tar.gz" .

log "including secrets.enc.env"
cp /secrets/secrets.enc.env "$work/secrets.enc.env"

log "encrypting bundle"
tar -C "$work" -cf - postgres.dump documents.tar.gz character-media.tar.gz secrets.enc.env \
  | age -r "$BIGIMAGINE_BACKUP_AGE_PUBLIC_KEY" -o "$work/bundle.tar.age"

dest="backup:${BIGIMAGINE_BACKUP_S3_BUCKET}/${BACKUP_OBJECT_PREFIX}/${ts}.tar.age"
log "uploading to $dest"
# --s3-no-check-bucket: rclone's default preflight HeadBucket/list-style existence check needs
# broader (account-level) permission than an R2 API token scoped to just this one bucket grants
# (bi_principles.md's least-privilege instinct — no reason to give this token account-wide list
# access it never otherwise needs). Without this flag the actual upload never even gets attempted:
# rclone fails the preflight with AccessDenied first. Confirmed 2026-07-29 on bigBrain's copy of
# this script: the same credentials succeed via aws-cli's single put-object call (no preflight)
# and via rclone once this flag skips rclone's own check.
rclone copyto "$work/bundle.tar.age" "$dest" --s3-no-check-bucket

# Prune to the newest BIGIMAGINE_BACKUP_RETAIN_COUNT backups, oldest first — only runs after a
# confirmed-successful upload above (set -e would already have aborted the script otherwise), and
# only ever removes from the *old* end of the sorted list, so the backup just uploaded can never
# be among the ones deleted as long as retain >= 1.
retain="${BIGIMAGINE_BACKUP_RETAIN_COUNT:-5}"
log "pruning to newest $retain backup(s)"
mapfile -t all_backups < <(rclone lsf "backup:${BIGIMAGINE_BACKUP_S3_BUCKET}/${BACKUP_OBJECT_PREFIX}/" --s3-no-check-bucket | sort)
total="${#all_backups[@]}"
if [ "$total" -gt "$retain" ]; then
  to_remove=$((total - retain))
  for ((i = 0; i < to_remove; i++)); do
    old="${all_backups[$i]}"
    log "deleting old backup: $old"
    rclone deletefile "backup:${BIGIMAGINE_BACKUP_S3_BUCKET}/${BACKUP_OBJECT_PREFIX}/${old}" --s3-no-check-bucket
  done
fi

log "done"
