# Dedicated Infrastructure Plan

*Created 2026-08-04. Governed by `bi_principles.md`; scoped against `spec.md`'s implicit
assumption (never yet stated, because it was never yet questioned) that BigImagine runs inside
bigBrain's orchestrator process against bigBrain's Postgres. This document is the build plan for
giving BigImagine its own orchestrator process and its own Postgres instance.*

*Status tags follow spec.md's convention: **(built)**, **(designed)**, **(parked)**. **(built,
verified 2026-08-11)** — `stacks/bigimagine/` is live (own Postgres, own orchestrator, public
route), and the §4.5 cleanup (dropping BigImagine's tables/keys back out of the shared
`bigbrain-postgres`) is done. Two items from §8's follow-up list are still open: `db/migrations
/README.md`'s narrative entries for 0044–0048, and `recallCanonFactsTool.ts`'s `<->`→`<=>` operator
swap — both explicitly low-priority, not correctness bugs, per §8's own wording.*

---

## 1. Purpose

Today, BigImagine has no deployed container of its own. Its plugins (`characters`, `locations`,
`scenes`, `canonize`, `notes`, `context-stack-presets`, ...) are dev-time source code whose
migrations get applied by hand, in order, against `bigbrain-postgres` — the same live Postgres
instance backing the household's actually-running `bigbrain-orchestrator`. This was a reasonable
starting point (one Postgres to stand up, not two, while BigImagine was pure schema-and-plugin
work with zero real usage) but it has two concrete costs, one already realized:

1. **Shared-fate risk with a live production system.** Applying `0048_canon_settings.sql`
   (widening `orchestrator_settings.key`'s CHECK constraint for two new Canonize settings) briefly
   dropped that constraint entirely against a database bigBrain's live household orchestrator was
   actively reading/writing — because BigImagine's replacement CHECK list didn't know about
   bigBrain's own live keys (`calendar_owner_user_id`, `google_calendar_sync_token`, etc.). This
   was caught and fixed same-session, but it is a structural risk that recurs on every future
   BigImagine migration touching a table bigBrain also owns rows in, for as long as the two share
   one physical database.
2. **No independent embeddings config.** `BIGBRAIN_EMBEDDINGS_PROVIDER`/`MODEL`/`API_KEY`/
   `OUTPUT_DIMENSION` are read once per orchestrator *process* boot and shared by every plugin in
   that process. Since BigImagine's plugins run inside bigBrain's process today, they get
   bigBrain's embedding choice (`voyage-4`, 2048 dims) whether or not that's what BigImagine
   actually wants. A dedicated Postgres alone doesn't fix this — vector column width is
   per-table, not per-database — what actually gates independent embeddings is a **dedicated
   orchestrator process**, which a dedicated Postgres naturally comes bundled with.

**This is the cheapest point at which to do this split.** Every BigImagine-owned table
(`characters`, `locations`, `scenes`, `scene_presence`, `canon_facts`) currently has zero rows —
confirmed 2026-08-04. There is no data migration risk at all right now; there will be the first
real day someone uses the platform.

## 2. Non-Goals

- **Not touching bigBrain's own stack.** `stacks/bigbrain`'s compose file, container, volume, and
  live data are untouched by this plan except for the cleanup step in §4.5 (removing BigImagine's
  now-redundant tables/settings keys from it once the dedicated instance is verified working).
- **Not a multi-tenant redesign.** RLS stays exactly as it is (`docs/canonize-plan.md` §3.1,
  folded into `spec.md` §3) — this plan changes *which* Postgres instance BigImagine's
  already-RLS'd tables live in, not the RLS model itself.
- **Not fixing bigBrain's own copy of `0043`'s latent household-key gap.** `bigBrain/db/migrations
  /0043_chat_memory_digest_horizon.sql` has the same non-transactional DROP/ADD CHECK pattern this
  plan's §1.1 incident came from, but that file lives in bigBrain's own repo and is bigBrain's own
  problem to fix on its own schedule — out of scope here.
- **No data migration.** There is no data to migrate (§1) — this plan is schema replay onto an
  empty volume, not an ETL job. If real rows exist by the time this is built, that changes the
  plan and this document needs revisiting first.

## 3. Current State (verified 2026-08-04)

- **No BigImagine container exists.** `docker ps` shows exactly one Postgres container
  (`bigbrain-postgres`) and one orchestrator container (`bigbrain-orchestrator`) on this host.
  BigImagine's migrations have all been applied by hand via `docker exec -i bigbrain-postgres
  psql ...` per each migration file's own header comment.
- **BigImagine's migration history is already self-contained.** `BigImagine/db/migrations/`
  holds 33 files (`0001`–`0048`, `0044`–`0048` newest), forked from bigBrain's own history but
  already diverged where it needed to (e.g. its own `0002_schema.sql` drops bigBrain-only tables
  like `recipes_meals`/`shopping_logs`/`notion_sync_map`). Nothing in it has a foreign key or
  runtime dependency on bigBrain's actual live rows — it only happens to run against the same
  physical database today. Replaying `0001`–`0048` fresh against an empty volume is expected to
  work exactly as it did the first time.
- **The deployment scaffolding exists but is stale.** `BigImagine/Dockerfile` still builds
  bigBrain's *old* plugin list (`document-ingestion`, `documents`, `shopping-analytics`, `lists`,
  `recipes`, `notes`, `prompt-presets`, `calendar`, `web`, `weather`, `math-utils`, `temporal`,
  `notifications`) — several of those packages don't even exist in `BigImagine/plugins/`, and it's
  missing `canonize`, `characters`, `chat-memory`, `context-stack-presets`, `locations`, `scenes`
  entirely. `BigImagine/docker-compose.yml` and `.env.example` are near-verbatim copies of
  bigBrain's own (`bigbrain_admin`/`bigbrain_app` role names, `BIGBRAIN_*` env var names,
  bigBrain-specific comments about Notion/Google Calendar that don't apply to BigImagine at all).
  None of this is deployment-ready as-is.
- **`BIGBRAIN_*` env var names are baked into the shared `@bigbrain/orchestrator` package
  itself** (confirmed via grep — `process.env.BIGBRAIN_PG_HOST`, `BIGBRAIN_EMBEDDINGS_*`, etc. are
  literal string constants in the orchestrator's own source, not something bigBrain's compose file
  chose). A second, independently-deployed instance of this same code will still read env vars by
  these exact names — that's a property of the shared framework, not something this plan should
  try to rename. Each container just gets its own env block with its own values.
- **Deployment convention: `stacks/<name>/` holds the compose file, source repo does not.**
  `bigBrain/docker-compose.yml` is a stale duplicate; the actually-running compose file is
  `stacks/bigbrain/docker-compose.yml`, confirmed via `docker inspect bigbrain-postgres`'s mount
  source. This plan follows that convention: the new compose file belongs in a new
  `stacks/bigimagine/` directory, not inside `BigImagine/` itself.

## 4. Design Decisions

### 4.1 Two moves, not one

A dedicated Postgres without a dedicated orchestrator process doesn't unlock independent
embeddings (§1.2) — it only removes the shared-fate risk (§1.1). A dedicated orchestrator process
without its own Postgres doesn't make sense (it would need bigBrain's tables anyway). So this plan
stands up both together, as one new compose stack, mirroring `stacks/bigbrain`'s existing
service shape almost exactly: `postgres` + `orchestrator` (no `doc-sandbox` or `backup` service
yet — §4.7, §2's non-goals).

### 4.2 New stack lives at `stacks/bigimagine/`, not inside `BigImagine/`

Per §3's confirmed convention. `BigImagine/docker-compose.yml`, `.env.example`, and the two
top-level `Dockerfile`s that are stale copies of bigBrain's should be deleted once
`stacks/bigimagine/`'s versions replace them, rather than kept as dead, misleading duplicates.

### 4.3 Postgres role names: rename to `bigimagine_admin`/`bigimagine_app`

Free to do (RLS policies reference `app_current_user_id()`, not a hardcoded role name) and removes
a real point of future confusion — `docker exec bigimagine-postgres psql -U bigbrain_admin` reads
as a copy-paste bug waiting to be filed. Every migration's `grant ... to bigbrain_app` line needs
the corresponding rename when replayed (§4.4) — a mechanical find-and-replace across the copied
migration set used for the new instance, not a change to the checked-in files bigBrain's own
history still needs to read correctly.

### 4.4 Migration replay, not migration

Since zero rows exist (§1), `0001`–`0048` get applied in order against a fresh, empty
`bigimagine-postgres` volume — the same `docker-entrypoint-initdb.d` auto-run mechanism
`stacks/bigbrain` already uses for its own first-boot migrations 0001-0002, then hand-applied for
everything after. Two edits to the replayed set, both safe only because no rows exist yet: the
role rename (§4.3) and the household-key removal from `0043`/`0048`'s CHECK lists (§4.5).
`vector_embed` columns and their (absence of) indexing stay exactly as already written (§4.6) —
no schema change needed there. No other transformation of the SQL content.

### 4.5 `orchestrator_settings` CHECK simplifies back down

Once BigImagine has its own `orchestrator_settings` table that bigBrain's live orchestrator never
touches, `0048`'s CHECK list (and `0043`'s, both BigImagine's own copies) no longer need bigBrain's
household keys (`calendar_owner_user_id`, `mask_work_calendar`, `notion_*`, `google_calendar_*`,
`default_recipe_servings`) — those were only ever added to survive being applied against the
*shared* database. **On the new dedicated instance, replay `0043`/`0048` with those keys removed**
— a strictly BigImagine-only CHECK list, matching what those migrations would have looked like had
they never needed to coexist with bigBrain's live rows in the first place.

Separately, once the dedicated instance is verified working end-to-end (§6), the corresponding
tables and settings keys that were added to the *shared* `bigbrain-postgres` this session
(`characters`, `locations`, `scenes`, `scene_presence`, `canon_facts`, and the
`canon_recall_top_k`/`canon_extraction_prompt`/`chat_memory_*` keys `0048`'s superset CHECK
protects) should be dropped from it, and `bigbrain`'s own `orchestrator_settings` CHECK narrowed
back to a bigBrain-only list. This fully closes the shared-fate risk (§1.1) rather than leaving a
dormant, unused copy of BigImagine's schema sitting in bigBrain's live database indefinitely.

### 4.6 Embeddings: `voyage-4-large` at full 2048 dimensions, flat-scanned, no index — decided 2026-08-04

BigImagine reuses the same model CNZ (SillyTavern-Canonize) already uses —
`BIGIMAGINE_EMBEDDINGS_PROVIDER=voyage`, `BIGIMAGINE_EMBEDDINGS_MODEL=voyage-4-large` — at its
**full 2048-dimension tier**.

An earlier draft of this section chased the 2000-dimension pgvector index cap down a real but
ultimately unnecessary path: `halfvec(2048)` does support a real `hnsw` index (verified directly
against `pgvector 0.8.5` in `bigbrain-postgres`), so 2048 dims *and* indexing are technically both
available together. But indexing isn't solving a real problem here in the first place — the same
reasoning already applied to CNZ's own Postgres-backed RAG: at the row counts a single-user
platform's scoped candidate sets actually reach (`recall_canon_facts`'s scope filter narrows to a
scene's present characters/location *before* any vector comparison runs — dozens to low hundreds
of rows, not thousands), a flat linear scan is exact (100% recall, unlike HNSW's approximate
trade-off) and still executes in single-digit milliseconds. HNSW's own overhead — build time,
hyperparameters, approximate recall — only starts paying for itself well past that scale. This
also matches the existing, working precedent: bigBrain's own `vector(2048)` columns
(`chat_chunks`, `document_chunks`) have never had an index, at real production scale, and perform
fine.

**Decision: `vector_embed` columns in the replayed migrations (`chat_chunks`, `document_chunks`,
`canon_facts`) stay plain `vector(2048)`, with no index created at all.** Query via
`ORDER BY vector_embed <=> :query_embedding LIMIT :top_k` (cosine distance) directly — no
`CREATE INDEX` statement anywhere in the replayed migration set for these columns. This is
actually *no change at all* from `docs/canonize-plan.md` §4's original convention (already folded
into `spec.md` §4) — the `halfvec`/`hnsw` detour in an earlier draft of this section is reverted,
not adopted.

`recallCanonFactsTool.ts`'s existing query orders by `vector_embed <-> $5` (Euclidean/L2
distance) rather than `<=>` (cosine distance) — for normalized embedding vectors the two produce
the same ranking order, so this isn't a correctness bug, but `<=>` is the more standard, explicit
choice for embedding similarity and worth aligning on once this plan's migrations are actually
written (flagged in §8, not a blocker here).

(Env var *names* stay the `BIGBRAIN_*` strings the shared package reads — §3 — only the *values*
and the container they're set in are BigImagine's own.)

### 4.7 Networking: public route now — decided 2026-08-04

`bigimagine-orchestrator` gets a Traefik/Cloudflare Access route immediately, mirroring
bigBrain's own pattern exactly: a `bigimagine.your-domain.example`-style hostname, Google-login enforcement
at Cloudflare Access, every route underneath still requiring its own bearer token
(`BIGIMAGINE_ADMIN_API_KEY`/`BIGIMAGINE_API_KEYS`) exactly as bigBrain's does. Needs a DNS
entry/Cloudflare Access application for the new hostname before `docker compose up`, same
one-time setup bigBrain's own route required.

## 5. Concrete build steps

1. Create `stacks/bigimagine/docker-compose.yml`, adapted from `stacks/bigbrain/docker-compose.yml`:
   `postgres` (image `pgvector/pgvector:pg16`, container `bigimagine-postgres`, own named volume,
   `./db/migrations` mount pointing at a copy of `BigImagine/db/migrations` with the role rename
   applied) + `orchestrator` (container `bigimagine-orchestrator`, builds from `BigImagine/`'s
   `Dockerfile`, Traefik-routed per §4.7).
2. Fix `BigImagine/Dockerfile`'s workspace build list to the actual current plugin set
   (`canonize`, `characters`, `chat-memory`, `context-stack-presets`, `document-ingestion`,
   `documents`, `locations`, `math-utils`, `notes`, `notifications`, `prompt-presets`, `scenes`,
   `temporal`, `web`) instead of bigBrain's stale list.
3. Write `stacks/bigimagine/.env` (gitignored, from a new `.env.example` modeled on
   `BigImagine/.env.example` but with BigImagine-specific comments, no Notion/Google
   Calendar/backup vars that don't apply) — set `BIGIMAGINE_EMBEDDINGS_PROVIDER=voyage`,
   `BIGIMAGINE_EMBEDDINGS_MODEL=voyage-4-large`, `BIGIMAGINE_EMBEDDINGS_OUTPUT_DIMENSION=2048`
   per §4.6.
4. Apply the role-renamed, CHECK-simplified migration set (§4.3, §4.5) to the fresh
   `bigimagine-postgres` volume via its `docker-entrypoint-initdb.d` first-boot mechanism.
5. Boot `bigimagine-orchestrator`, confirm `/v1/whoami` or equivalent health check responds, run
   every plugin's verify script against it if a live-DB verify mode exists, otherwise confirm the
   existing fake-pool verify scripts still pass unchanged (they should — nothing about plugin code
   changes here, only deployment target).
6. Delete `BigImagine/docker-compose.yml`, `BigImagine/.env.example`'s stale root copy, and confirm
   `BigImagine/Dockerfile` is the one actually referenced by `stacks/bigimagine/docker-compose.yml`
   (§4.2).
7. Once step 5 is confirmed working, drop BigImagine's tables/settings keys from the shared
   `bigbrain-postgres` and narrow its `orchestrator_settings` CHECK back to bigBrain-only (§4.5,
   second paragraph).

## 6. Build order

1. §5 steps 1–2 (compose file + Dockerfile fix) — no risk, nothing live depends on these yet.
2. §5 step 3 (.env, per the embeddings choice already made in §4.6) — blocks step 4, since the
   migration set's `vector(2048)` columns (§4.6) and the `.env`'s `OUTPUT_DIMENSION` must agree.
3. §5 step 4 (migration replay) — cheap, reversible (just re-create the volume) since this is a
   fresh empty database.
4. §5 step 5 (boot + verify) — the actual proof this works end-to-end.
5. §5 steps 6–7 (cleanup) — only after step 4 above is confirmed solid; this is the point of no
   return for the shared-fate risk (§1.1), so it should not happen until the dedicated instance has
   been run against for real, not just booted once.

## 7. Open questions for the user

- **Embeddings provider/model/dimension**: **resolved (2026-08-04)** — `voyage-4-large` at full
  2048 dimensions, plain `vector` type, flat-scanned, no index (§4.6).
- **Networking**: **resolved (2026-08-04)** — public Traefik/Cloudflare Access route now, not
  loopback-only (§4.7).
- **Timing of the cleanup step** (§5 step 7 / §4.5's second paragraph — dropping BigImagine's
  tables/keys from the shared `bigbrain-postgres`): **resolved (2026-08-04)** — clean up promptly
  once the dedicated instance is verified working, per this plan's own recommendation.

## 8. Follow-up doc updates (once this plan is approved, not part of this document)

- `docs/bootstrap.md` — add BigImagine's own deployment section (currently only documents
  bigBrain's `stacks/bigbrain` setup), covering the new `stacks/bigimagine/.env` and first-boot
  steps.
- `BigImagine/db/migrations/README.md` — narrative entries for `0044`–`0048` are still missing
  (flagged during the Canonize recovery work, not yet done) — worth doing in the same pass as this
  plan's migration-set changes, since `0043`/`0048`'s CHECK lists are being edited anyway (§4.5).
- `spec.md` — once BigImagine has its own deployment, §3's "what was pruned from bigBrain" framing
  may be worth a short addendum noting BigImagine also no longer shares bigBrain's *infrastructure*,
  not just its schema decisions — a distinct fact from the RLS-retention note already folded in
  from `docs/canonize-plan.md`.
- `recallCanonFactsTool.ts`'s ranking query — switch `ORDER BY vector_embed <-> $5` (L2) to
  `<=>` (cosine), the more standard/explicit operator for embedding similarity (§4.6). Not a
  correctness bug for normalized vectors, just worth aligning once touched for another reason.
