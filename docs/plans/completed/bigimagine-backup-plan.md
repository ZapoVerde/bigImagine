# BigImagine Offsite Backup Plan

*Created 2026-08-11. Governed by `bi_principles.md`; closes the gap `spec.md` §6 (Admin overhead)
and §3 flag "Single-user backup strategy — bigBrain's offsite backup pipeline was pruned wholesale
(§3); whether BigImagine wants a simpler equivalent is an open, not-yet-raised question." This
document is the build plan for giving BigImagine its own offsite backup, riding on the pipeline
already built and verified for bigBrain (`bigBrain/backup/`, `docs/plans/completed/dedicated-infra-plan.md`'s
sibling stack).*

*Status tags follow spec.md's convention: **(built)**, **(designed)**, **(parked)**. **(built,
verified 2026-08-13)** — all of §5's steps are implemented and deployed: `stacks/bigimagine`'s
`backup` service runs nightly (`15 3 * * *`), its manual-run + retention-prune checks against R2
under the `bigimagine/` prefix passed, the orchestrator reports `backupConfigured: true`, and the
`spec.md` §3/§8 flags below now point here as resolved. §7's open questions were answered with the
plan's defaults: retention `5`, cron `15 3 * * *`, and a full standalone restore runbook (not a
pointer) in `BigImagine/backup/README.md`. **Update 2026-08-13:** the initial build's residual gap
(the `bigimagine-character-media` volume — real avatar PNGs with no provider to re-fetch from —
wasn't in the bundle, since `backup.sh` mirrored bigBrain's script which predates character media)
is now closed: `backup.sh` tars `/character-media` alongside the document store, the compose
service mounts the volume, and the restore runbook covers it. Vistalyze's location/scene images
were considered and excluded on purpose — they're provider CDN URLs already inside
`postgres.dump`, and the app already treats a dead URL as expected (regenerates on next visit).*

---

## 1. Purpose

`stacks/bigimagine/docker-compose.yml` has no `backup` service today, and its orchestrator's
`BIGBRAIN_BACKUP_CONFIGURED` is hardcoded to `"false"` (line 53) — deliberately deferred when the
dedicated stack was stood up (`dedicated-infra-plan.md` §4.1). BigImagine's Postgres (chat history,
characters, locations, scenes) and its document/character-media volumes currently have no offsite
copy at all: a lost or corrupted `bigimagine-postgres` volume is unrecoverable.

`BigImagine/backup/` already exists in the tree, but it's a byte-identical, unmodified copy of
`bigBrain/backup/` — still named for bigbrain throughout (container name, `BIGBRAIN_BACKUP_*` var
names, the `bigbrain/` R2 object-key prefix, restore-doc paths pointing at `stacks/bigbrain/`) and
not referenced anywhere in `stacks/bigimagine/docker-compose.yml`. It's dead code, not a partial
integration — this plan replaces it rather than building on it as-is.

## 2. Non-Goals

- **Not row-level encryption of chat content.** `chat_messages.content` is a plain `text` column
  with no field-level cipher (confirmed: `chatSessions.ts` does a live `ILIKE` search against it,
  which ciphertext couldn't support). This plan relies on the backup bundle's own `age` encryption
  to cover the "leaked offsite backup" threat instead — see §4.2. Encrypting the live column is a
  separate, larger change (breaks in-DB search, needs a backfill) and is not part of this plan.
- **Not changing bigBrain's own backup service.** `bigBrain/backup/` and `stacks/bigbrain`'s
  `backup` service are untouched except for the one shared-script parameterization in §4.4.
- **Not provisioning new Cloudflare resources.** §4.1 reuses the existing `bigbrain-backups`
  bucket, R2 API token, and `age` keypair rather than minting new ones.

## 3. Current State (verified 2026-08-11)

- `stacks/bigimagine/docker-compose.yml` defines only `postgres` and `orchestrator` — no `backup`
  service, no backup-related volumes or secrets wired in.
- `BigImagine/backup/backup.sh`, `entrypoint.sh`, `Dockerfile`, `README.md` are unmodified copies
  of `bigBrain/backup/`'s files (`diff` is empty) — every `bigbrain`/`BIGBRAIN_BACKUP_*` reference
  in them is stale for this context.
- `stacks/bigimagine/secrets.enc.env` has no `BIGIMAGINE_BACKUP_*` keys.
- `stacks/bigimagine/secrets.enc.env` and `stacks/bigbrain/secrets.enc.env` are already sops-
  encrypted to the *same* age recipient (`age1x5fp2q9t860k0ktpxk8cusq2w6fhq9x0g5jslsv36ypnwl6qw4gq0yxgy0`)
  — an existing coupling between the two stacks, independent of this plan.

## 4. Design Decisions

### 4.1 Shared bucket, shared `age` keypair, distinct object-key prefix — decided 2026-08-11

BigImagine's backups will land in the same `bigbrain-backups` R2 bucket under a `bigimagine/`
prefix (`bigbrain/` stays bigBrain's), encrypted with the same `age` keypair bigBrain's backup
already uses, and pushed with the same R2 API token (already scoped to this one bucket — no new
token needed since nothing changes about what bucket is being written to).

Rejected alternative: a dedicated bucket + dedicated `age` keypair per stack, matching the "own
Postgres, own everything" isolation principle that motivated splitting BigImagine into its own
stack in the first place (`dedicated-infra-plan.md`). Decided against because:
- The threat this would guard against — one compromised key exposing both stacks' backups — is
  already accepted at the sops layer (§3's existing shared recipient) and judged acceptable by the
  user for the deployment's actual threat model: a single homelab operator for whom host compromise
  already means bigger problems than backup-bucket cross-exposure.
- `backup.sh` only ever touches the `age` *public* key at write time (`age -r
  "$BACKUP_AGE_PUBLIC_KEY"`); the private key that would actually let anyone decrypt anything stays
  exactly as off-host as it already is regardless of this choice.
- Avoids provisioning a second Cloudflare bucket/token/keypair for marginal isolation benefit that
  isn't load-bearing against the real threat model.

### 4.2 Chat content protection: backup-layer `age` encryption, not row-level — decided 2026-08-11

`chat_messages.content` stays plaintext in Postgres and in `postgres.dump`. The backup bundle
(`postgres.dump` + `documents.tar.gz` + `secrets.enc.env`) is `age`-encrypted in whole before it
ever leaves the host (`backup.sh`'s existing design, unchanged by this plan) — that closes the
"leaked/stolen offsite backup" exposure for chat content without touching `chatSessions.ts` at all.

What this does **not** cover: anyone with access to the *live* Postgres container (stolen host
disk, `psql` with valid creds) still sees chat content in the clear — backup-layer encryption never
touches the live database. Accepted for the same single-operator-homelab reason as §4.1; consistent
with the existing `fieldCipher.ts` threat model already deployed for notes/credentials ("stolen
disk, a leaked backup, casual `psql`" — backup-layer encryption is the direct analog of the "leaked
backup" leg of that same list, just applied at the bundle level instead of the column level).

### 4.3 Var naming: `BIGIMAGINE_BACKUP_*`, not a `BIGBRAIN_BACKUP_*` clone

Unlike the orchestrator's env block in `stacks/bigimagine/docker-compose.yml` (which deliberately
keeps `BIGBRAIN_*` var *names* because they're baked into the shared `@bigbrain/orchestrator`
package — `dedicated-infra-plan.md` §4.2's comment), `backup.sh` is a standalone shell script, not
shared package code. There's no reason for its copy to keep bigBrain's naming, and doing so is what
makes today's `BigImagine/backup/` read as a confusing, half-adapted clone. This plan renames every
`BIGBRAIN_BACKUP_*` reference in the BigImagine copy to `BIGIMAGINE_BACKUP_*`.

### 4.4 Parameterize the object-key prefix in `backup.sh` — decided 2026-08-11

`backup.sh` currently hardcodes `bigbrain/` as the object-key prefix in three places (upload
destination, retention listing, retention delete). Rather than hand-maintaining two diverging
copies of the same script, this plan adds one new env var (`BACKUP_OBJECT_PREFIX`, no `BIGBRAIN_`/
`BIGIMAGINE_` prefix since it's generic to whichever stack sets it) that both stacks' `backup.sh`
read, defaulting nothing (must be set explicitly by each stack's compose file) so a missing value
fails loudly rather than silently reusing bigBrain's prefix. `bigBrain/backup/backup.sh` and
`BigImagine/backup/backup.sh` become identical again after this change, differing only in which
compose file sets `BACKUP_OBJECT_PREFIX` to `bigbrain` vs `bigimagine`.

### 4.5 Cron offset

Both jobs `pg_dump`ing and hitting the same R2 bucket at the exact same instant is harmless but
needless contention. BigImagine's cron defaults to `15 3 * * *` (bigBrain stays at its existing
`0 3 * * *`) — a minor scheduling nicety, not a correctness requirement.

## 5. Concrete build steps

1. **Parameterize the shared script** (§4.4): edit `bigBrain/backup/backup.sh` to read
   `BACKUP_OBJECT_PREFIX` instead of the hardcoded `bigbrain` string in the upload destination
   (currently line 32), the retention `rclone lsf` listing (line 49), and the retention
   `rclone deletefile` call (line 56). Add `BACKUP_OBJECT_PREFIX: bigbrain` to `stacks/bigbrain`'s
   existing `backup` service so its behavior is unchanged.
2. **Replace `BigImagine/backup/`'s files** with the now-parameterized `backup.sh`/`entrypoint.sh`/
   `Dockerfile`, renaming every `BIGBRAIN_BACKUP_*` reference to `BIGIMAGINE_BACKUP_*` (§4.3) and
   every `bigbrain-backup` container-name/restore-path mention in `README.md` to `bigimagine-backup`
   / `stacks/bigimagine/`.
3. **Add a `backup` service to `stacks/bigimagine/docker-compose.yml`**, mirroring
   `stacks/bigbrain`'s block (its own `docker-compose.yml` lines 142–181):
   - `container_name: bigimagine-backup`, `build.context: ../../BigImagine/backup`
   - `BACKUP_OBJECT_PREFIX: bigimagine`
   - `BIGIMAGINE_BACKUP_*` env vars sourced from `stacks/bigimagine/secrets.enc.env` (bucket,
     endpoint, access key ID/secret, `age` public key — same values as bigBrain's per §4.1)
   - volumes: `bigimagine-documents:/documents:ro`, and
     `/opt/stacks/bigimagine/secrets.enc.env:/secrets/secrets.enc.env:ro` — **absolute path**, not
     relative (`stacks/bigbrain`'s backup service hit exactly this bug once already: a relative
     bind-mount source resolves against the Docker daemon's filesystem, not the sandbox client's,
     and silently produces a phantom empty directory instead of erroring — `dedicated-infra-plan.md`
     equivalent incident, documented inline in `stacks/bigbrain/docker-compose.yml`'s own comment).
4. **Add the `BIGIMAGINE_BACKUP_*` secrets** to `stacks/bigimagine/secrets.enc.env`:
   `BIGIMAGINE_BACKUP_CONFIGURED=true`, `BIGIMAGINE_BACKUP_S3_BUCKET` (same bucket name as
   bigBrain's), `BIGIMAGINE_BACKUP_S3_ENDPOINT`/`_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` (same values,
   reused token), `BIGIMAGINE_BACKUP_AGE_PUBLIC_KEY` (same public key as bigBrain's), plus the
   non-secret knobs `BIGIMAGINE_BACKUP_CRON_SCHEDULE` (`15 3 * * *`, §4.5) and
   `BIGIMAGINE_BACKUP_RETAIN_COUNT` (default `5`, matching bigBrain's — revisit if the user wants a
   different count).
5. **Flip `stacks/bigimagine/docker-compose.yml`'s orchestrator env** (line 53) from the hardcoded
   `BIGBRAIN_BACKUP_CONFIGURED: "false"` to `${BIGIMAGINE_BACKUP_CONFIGURED:-false}`, matching every
   other var in that block's `BIGBRAIN_<name>: ${BIGIMAGINE_<name>:-...}` pattern — this is what
   turns off the frontend's dismissible "backup not configured" warning modal once real credentials
   are in place.
6. **Update the stale top-of-file comment** in `stacks/bigimagine/docker-compose.yml` (lines 1–5,
   "no doc-sandbox or backup service yet... Add both later by copying stacks/bigbrain's versions
   verbatim") — backup is no longer "not yet," and it wasn't copied verbatim (§4.3).
7. **Update `docs/spec.md`'s §3/§6 flags** referencing the open "single-user backup strategy"
   question to point at this plan and mark it resolved once built.

## 6. Build order

1. §5 step 1 (parameterize `backup.sh` + update `stacks/bigbrain`'s compose var) — touches
   bigBrain's live backup service, so verify it still runs clean against R2 with the same
   `bigbrain/` prefix before moving on (a broken `BACKUP_OBJECT_PREFIX` default would silently stop
   bigBrain's own nightly backups).
2. §5 steps 2–4 (BigImagine's own files, compose service, secrets) — no risk, nothing live depends
   on these until the service is actually brought up.
3. §5 step 5 (flip `BIGIMAGINE_BACKUP_CONFIGURED`) — do last, after steps 2–4 are confirmed correct,
   since this is what makes the container start running real backups on its cron schedule instead of
   idling (`entrypoint.sh`'s existing `BACKUP_CONFIGURED != true` idle guard).
4. Trigger one manual run (`docker exec bigimagine-backup /backup.sh`), confirm the object lands in
   R2 under `bigimagine/`, and — same as bigBrain's own verification — do one retention-pruning
   check with `BIGIMAGINE_BACKUP_RETAIN_COUNT` temporarily forced low via `docker exec -e` to
   confirm pruning only ever removes from the old end and never the just-uploaded object.
5. §5 steps 6–7 (doc cleanup) — after step 4 is confirmed working end-to-end.

## 7. Open questions for the user

- **Retention count**: defaulting to `5`, same as bigBrain's. Confirm, or pick a different count.
- **Cron offset**: defaulting to `15 3 * * *` (§4.5). Confirm, or pick a different time.
- **`BigImagine/backup/README.md`'s restore runbook**: should it stay a full standalone copy (so a
  restore doesn't require cross-referencing bigBrain's docs), or become a short pointer to
  `bigBrain/backup/README.md` noting only what differs (prefix, paths)? Leaning standalone copy for
  restore-time clarity, but flagging since it's a judgment call, not a technical constraint.
