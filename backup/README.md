# BigImagine — Offsite Backup & Restore

What the `backup` service (`docker-compose.yml`) does every night (default cron `15 3 * * *`,
§4.5 of the plan that built this — see `docs/plans/completed/bigimagine-backup-plan.md`):
`pg_dump` the whole database, tar the per-user document store, tar the character avatar PNGs,
copy in `secrets.enc.env`, bundle the four into one archive, encrypt it with `age`, and push it
to whatever S3-compatible bucket `BIGIMAGINE_BACKUP_S3_*` points at. Cloudflare R2 today, sharing
the `bigbrain-backups` bucket with bigBrain under the `bigimagine/` object-key prefix (`bigbrain/`
stays bigBrain's) — nothing here is R2-specific, see `backup.sh`.

Vistalyze's location/scene images are *not* separately archived here — they're just provider CDN
URLs in `locations.image_url` / `location_swipe_images.image_url`, already inside `postgres.dump`,
and the app already treats a dead URL as expected (nulls it out and regenerates on next visit).
Character avatars are different: real PNG bytes on disk with no provider to re-fetch from, hence
their own tar step.

Trigger a run on demand instead of waiting for cron: `docker exec bigimagine-backup /backup.sh`

## What a backup does *not* cover

The `age` **private key** that decrypts every backup (and `secrets.enc.env`) is deliberately never
on this host — see `docs/bootstrap.md`'s Secrets section. Losing that key means losing the ability
to read every backup this service has ever produced, not just future ones. Keep it somewhere
durable and outside this host, independent of everything else here.

## Restoring a full account

You need: the `age` private key, and a fresh host with Docker + this repo checked out (or
`stacks/bigimagine/` recreated per `docs/bootstrap.md`'s workspace/stacks split).

1. **Fetch and decrypt the bundle** (pick the object you want from the bucket — object keys are
   `bigimagine/<UTC timestamp>.tar.age`):
   ```
   age -d -i /path/to/backup-key.txt bigimagine-<timestamp>.tar.age | tar -xf -
   ```
   This produces `postgres.dump`, `documents.tar.gz`, `character-media.tar.gz`, and
   `secrets.enc.env` in the current directory.

2. **Bring up Postgres only**, empty, then restore into it:
   ```
   docker compose up -d postgres
   docker exec -i bigimagine-postgres pg_restore -U bigimagine_admin -d bigimagine --clean --if-exists < postgres.dump
   ```
   `--clean --if-exists` makes this safe to run against a database that already has the
   `docker-entrypoint-initdb.d` migrations applied (a fresh volume runs those on first boot) —
   it drops and recreates each object before restoring it, rather than erroring on conflicts.

3. **Restore the document store** into the named volume:
   ```
   docker run --rm -v bigimagine-documents:/documents -v "$PWD":/backup alpine \
     tar -C /documents -xzf /backup/documents.tar.gz
   ```

4. **Restore character avatars** into their named volume:
   ```
   docker run --rm -v bigimagine-character-media:/character-media -v "$PWD":/backup alpine \
     tar -C /character-media -xzf /backup/character-media.tar.gz
   ```

5. **Restore secrets** (the file itself is already encrypted — just place it back):
   ```
   cp secrets.enc.env stacks/bigimagine/secrets.enc.env
   ```

6. **Bring up the rest of the stack** (decrypts secrets in-memory, never to a plaintext `.env`):
   ```
   scripts/secrets.sh deploy
   ```

Verify against `docs/bootstrap.md` and `docs/spec.md` for anything that's drifted since this
runbook was written — restoring is rare enough that it's worth a sanity pass before trusting it
blind.
