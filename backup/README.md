# bigBrain — Offsite Backup & Restore

What the `backup` service (`docker-compose.yml`) does every night: `pg_dump` the whole database,
tar the per-user document git repos, copy in `secrets.enc.env`, bundle the three into one archive,
encrypt it with `age`, and push it to whatever S3-compatible bucket `BIGBRAIN_BACKUP_S3_*` points
at (`.env.example` has the vars; Cloudflare R2 today, but nothing here is R2-specific — see
`backup.sh`).

Trigger a run on demand instead of waiting for cron: `docker exec bigbrain-backup /backup.sh`

## What a backup does *not* cover

The `age` **private key** that decrypts every backup (and `secrets.enc.env`) is deliberately never
on this host — see `docs/bootstrap.md`'s Secrets section. Losing that key means losing the ability
to read every backup this service has ever produced, not just future ones. Keep it somewhere
durable and outside this host, independent of everything else here.

## Restoring a full account

You need: the `age` private key, and a fresh host with Docker + this repo checked out (or
`stacks/bigbrain/` recreated per `docs/bootstrap.md`'s workspace/stacks split).

1. **Fetch and decrypt the bundle** (pick the object you want from the bucket — object keys are
   `bigbrain/<UTC timestamp>.tar.age`):
   ```
   age -d -i /path/to/backup-key.txt bigbrain-<timestamp>.tar.age | tar -xf -
   ```
   This produces `postgres.dump`, `documents.tar.gz`, and `secrets.enc.env` in the current
   directory.

2. **Bring up Postgres only**, empty, then restore into it:
   ```
   docker compose up -d postgres
   docker exec -i bigbrain-postgres pg_restore -U bigbrain_admin -d bigbrain --clean --if-exists < postgres.dump
   ```
   `--clean --if-exists` makes this safe to run against a database that already has the
   `docker-entrypoint-initdb.d` migrations applied (a fresh volume runs those on first boot) —
   it drops and recreates each object before restoring it, rather than erroring on conflicts.

3. **Restore the document repos** into the named volume:
   ```
   docker run --rm -v bigbrain-documents:/documents -v "$PWD":/backup alpine \
     tar -C /documents -xzf /backup/documents.tar.gz
   ```

4. **Restore secrets and decrypt to `.env`**:
   ```
   cp secrets.enc.env stacks/bigbrain/secrets.enc.env
   sops --input-type dotenv --output-type dotenv --decrypt secrets.enc.env > stacks/bigbrain/.env
   ```

5. **Bring up the rest of the stack**:
   ```
   docker compose up -d --build
   ```

Verify against `docs/bootstrap.md` and `docs/spec.md` for anything that's drifted since this
runbook was written — restoring is rare enough that it's worth a sanity pass before trusting it
blind.
