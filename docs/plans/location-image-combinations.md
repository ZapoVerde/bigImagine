# Replacing Background Prompt Hashing with Location + Optional Time-of-Day Combinations

*Written 2026-08-20. Governed by `bi_principles.md`. Plan only — not yet implemented. Reviewed
against current source (`generateLocationImage.ts`, `locationAndPresenceScraper.ts`,
`locationImages.ts`, migration `0076_location_swipe_images.sql`) before writing this revision; the
four corrections below (settings CHECK constraint, boolean-read convention, eligibility-clause
carry-forward, fake-pool test risk) came out of that pass. See "Note on precedent" before treating
`character_visual_combinations` (migration `0125`) as a proven reference — it isn't one yet.*

---

## Note on precedent

This design is structurally similar to `character_visual_combinations`
(`db/migrations/0125_character_visual_states.sql`, `orchestrator/src/orchestrator/
characterVisualAutofire.ts`): both replace an inputs-hash cache with a persistent-identity
combination table. That system is **not** a validated reference — it's gated behind
`character_visual_state_enabled` (default off, migration `0126`, whose own comment says "this
feature is new and untested against a live household"). Treat the resemblance as a useful naming/
shape convention to stay consistent with, not as evidence that the in-flight-guard/cache-lookup/
insert-on-conflict mechanics have been proven in production. This plan's design is justified below
on its own merits — the location case has one simplification the character case doesn't:
`locations.image_url` is already shared cross-chat (locations are a reusable library, linked to
chats via `location_chat_links`), so unlike `character_visual_combinations`, the new
`location_image_combinations` table deliberately carries **no `chat_id`** — that would be a
regression from today's already-cross-chat-shared cache, not a parity feature.

---

## Goal

Replace BigImagine's current prompt-hash background cache with a persistent-identity cache.

Background identity becomes:

```
location_id + optional time_of_day_key
    ↓
image_url
```

Location is always part of the identity. Time of day is the only optional variant dimension. No
mood support.

The generated prompt, model, seed, image dimensions, CFG, sampler, style prefix, etc. must no
longer determine whether an existing background is reused. Those values may remain as render
provenance/debug metadata if useful, but they are not cache identity.

Default behaviour:

```
Location             always enabled
Time-of-day variants OFF
```

With TOD variants disabled, one location gets one persistent background URL. With TOD variants
enabled, one location may have multiple persistent URLs keyed by canonical TOD.

Existing generated URLs must be preserved wherever practical. Changing the TOD setting must never
delete previous combinations.

---

## Desired Behaviour

### TOD variants OFF

```
kitchen  (first visit)   → no combination → render → save URL_A
kitchen  (every later visit) → URL_A
```

Morning/night/date/environment/provider-setting changes do not cause another generation.

### TOD variants ON

```
kitchen + morning → URL_A
kitchen + evening → URL_B
```

A later evening visit resolves URL_B directly.

```
kitchen + night → cache miss → render once → save URL_C
```

### Swipe behaviour

A swipe records which background combination it used. It does not own a separate image.

```
swipe_id → background_combination_id → image_url
```

Cycling back to an old swipe resolves the exact combination that swipe used. No generation should
occur merely because the user cycled backwards or forwards.

---

## Data Model

### New migration

Create `db/migrations/0129_location_image_combinations.sql` — the next append-only migration after
the current head (`0128_remove_chat_archive.sql`). Do not modify `0076_location_swipe_images.sql`.

```sql
create table location_image_combinations (
  combination_id       uuid primary key default gen_random_uuid(),
  location_id          uuid not null references locations(location_id) on delete cascade,
  time_of_day_key       text null,
  image_url            text not null,
  image_generated_at   timestamptz not null default now(),
  -- provenance only, never part of cache identity:
  rendered_prompt      text null,
  provider_kind        text null,
  provider_model       text null,
  seed                 bigint null,
  render_metadata      jsonb null
);
```

Do NOT make provenance fields part of the combination identity.

#### Uniqueness

Postgres nullable-unique behaviour makes this worth doing deliberately. We need exactly one base
combination per location and exactly one TOD-specific combination per location/TOD. Use partial
unique indexes:

```sql
create unique index location_image_combinations_base_uq
  on location_image_combinations (location_id) where time_of_day_key is null;

create unique index location_image_combinations_tod_uq
  on location_image_combinations (location_id, time_of_day_key) where time_of_day_key is not null;
```

This prevents duplicate provider spends even if two code paths race.

RLS: `location_image_combinations` has no `user_id` of its own — scope it the same way
`location_swipe_images` scopes through `chat_message_swipes`/`chat_messages` (migration 0076): here,
through `locations.user_id` via a join, matching how every other `locations`-child table in this
schema is scoped.

### Existing `location_swipe_images`

Keep this table — its purpose (swipe provenance) is still correct. Change it away from storing its
own render hash/cache identity. Add:

```sql
alter table location_swipe_images add column combination_id uuid
  references location_image_combinations(combination_id) on delete set null;
```

`on delete set null` is load-bearing, not incidental: it's what makes the "Broken URL Handling"
section below safe — a broken combination can be deleted without deleting swipe history (see that
section).

Runtime association becomes: `chat_id, swipe_id, location_id, combination_id`.

The existing `image_url`, `render_hash`, and `image_generated_at` columns can initially remain for
compatibility during migration, but new code must resolve through `combination_id`. Once all
readers have moved across and migration/backfill is proven, obsolete columns can be deprecated in a
later cleanup migration rather than mixing structural cleanup into this change. Do not delete old
data in this implementation.

### Migration / Existing Image Preservation

Existing `locations.image_url` values represent work already paid for. Backfill them as base
combinations:

```sql
insert into location_image_combinations (location_id, time_of_day_key, image_url, image_generated_at)
select location_id, null, image_url, coalesce(image_generated_at, now())
from locations
where image_url is not null
on conflict do nothing;
```

Do this only where `image_url is not null`. If multiple same-named historical location rows exist
because of old swipe churn, do not attempt clever cross-row collapsing in this migration —
combination identity is by `location_id`, not name. The existing resolver already contains
same-place carry logic for row churn (`locationAndPresenceScraper.ts`'s `resolveOrCreateLocationRow`
"prior" lookup); leave that concern separate (see "Same-Location Carry Logic" below for how it
changes).

For existing `location_swipe_images` rows:

- where a row's location has a newly backfilled base combination, populate `combination_id` with
  that combination. This means old swipes continue to point at the URL they effectively used.
- If an old swipe has a URL differing from the location's current URL, preserve it rather than
  silently changing history: create an appropriate legacy/base combination for that URL if
  necessary, or leave its existing direct `image_url` fallback in place until a later migration. Do
  not throw away a previously generated URL merely to normalize the database.

### Setting

Add one household/background setting: `background_tod_variants_enabled`. Boolean. Default `false`.

**Correction — settings CHECK constraint.** `orchestrator_settings.key` is a hand-maintained closed
vocabulary, enforced by `orchestrator_settings_key_check`, rebuilt wholesale on every migration that
adds a key (most recently `0126_character_visual_state_enabled_setting.sql`; ~15 prior precedents).
The `0129` migration must `drop constraint if exists orchestrator_settings_key_check` and
`add constraint ... check (key in (...))` reproducing the **current complete vocabulary as of 0126**
plus `'background_tod_variants_enabled'`. Forgetting this means the first write to the new setting
fails with a constraint violation, not a missing-key no-op — read `0126`'s full list as the base to
extend, don't hand-type it from memory.

**Correction — boolean-read convention.** This codebase has two conventions depending on default:
default-on settings are read `!== 'false'` (e.g. `location_split_enabled`); default-off settings are
read `=== 'true'` (e.g. `character_visual_state_enabled`, see `characterVisualState.ts:64`). Since
`background_tod_variants_enabled` defaults to `false`, read it as
`(await settings.get('background_tod_variants_enabled')) === 'true'` — not the inverse pattern.

This is the only variant setting. The UI should communicate the semantic meaning clearly:

```
Background variants
Time of day  [ ]
```

Location is not shown as a checkbox because location identity is mandatory. No Mood field. No
generic variant list. No extensible slot system. Keep this deliberately narrow.

Persist through the normal orchestrator settings API/store so it is read live, no restart. If there
is already an RP/background settings group in the frontend, place it there — verify this at
implementation time rather than assuming; it wasn't confirmed during this review.

---

## Canonical TOD Key

Do not use arbitrary raw environment JSON as the combination key. Use only the scraper's parsed
`timeOfDay` — confirmed live at `locationAndPresenceScraper.ts`'s `resolveLocation`:
`environment = JSON.stringify({ time_of_day: header.timeOfDay, date: header.dateLine })`, merged
into `locations.environment` via jsonb `||`. `environment.time_of_day` is exactly the raw string the
scene header carried (whatever case/whitespace the model emitted).

Add a tiny pure normalization function, preferably near the background-combination logic:

```
"Morning"     → "morning"
" morning "   → "morning"
"EVENING"     → "evening"
```

At minimum: `trim()`, lowercase. Do not invent semantic bucketing in this change. If the model
writes `late evening`, the canonical key is `late evening`. The LLM is already responsible for
emitting the scene header; this layer normalizes, not interprets.

When TOD variants are disabled: `time_of_day_key = null`, regardless of the current scene TOD.

---

## `orchestrator/src/orchestrator/locationAndPresenceScraper.ts`

Current behaviour refreshes the location's `environment` with `time_of_day`/`date` on every visit
(`resolveOrCreateLocationRow`'s `update locations set environment = environment || $3::jsonb ...`).
That can stay — the mutable environment must no longer indirectly invalidate an image, but the
scraper keeps owning scene extraction. Do not move image-cache decisions into this file.

Preferred approach: continue persisting `environment.time_of_day`; combination resolution reads
that specific value; ignore `environment.date` and every other environment property for identity.
Do not make the whole `environment` JSON part of any cache comparison.

### Same-Location Carry Logic

`resolveOrCreateLocationRow`'s no-match mint path currently carries `seed`, `image_url`,
`image_rendered_input`, `image_render_hash`, `visual_description`, `definition` from the most recent
same-named prior row (scoped to this chat, via the `join location_chat_links ... where lcl.chat_id =
$3` in its "prior" query) when same-named row churn mints a new `location_id`. That carry exists
largely to make the old prompt-hash cache survive swipe churn.

Rework this:

- Continue carrying `seed`, `visual_description`, `definition`.
- Do not treat `image_url`/`image_rendered_input`/`image_render_hash` as the new cache mechanism.
- After the new row is created, copy the prior row's `location_image_combinations` to the new
  `location_id`. Copy URLs only; no image generation. For TOD variants:

  ```
  prior kitchen/base    → new kitchen/base
  prior kitchen/morning → new kitchen/morning
  prior kitchen/evening → new kitchen/evening
  ```

  Do the clone with `insert into location_image_combinations (location_id, time_of_day_key,
  image_url, image_generated_at, ...) select $new_location_id, time_of_day_key, image_url,
  image_generated_at, ... from location_image_combinations where location_id = $prior_location_id
  on conflict do nothing`.

This keeps the existing "same room never wastes a generation because swipe churn minted another DB
row" guarantee, on the new identity model, at the one call site that currently does the carry.

---

## `orchestrator/src/orchestrator/generateLocationImage.ts`

This is the main rewrite. The current implementation: loads location → resolves provider →
synthesizes prompt → hashes prompt + provider params → compares `locations.image_render_hash` →
generates if hash differs. That is what causes existing locations to recook when environment/
provider inputs change. Replace that cache section.

**Correction — preserve `BG_ELIGIBILITY_CLAUSE` unchanged.** The current file has a fairly
intricate eligibility filter (`status is null OR linked-to-this-chat-and-not-inactive OR
this-chat's-active-swipe-has-a-location_swipe_images-association`) used both in the initial location
lookup and the pre-provider-call recheck. This is orthogonal to cache identity — it governs whether
a location is renderable *at all* for this chat, not whether a given combination should be reused.
It must carry forward into the rewrite exactly as-is, in both of its current call sites (the initial
load and the "Recheck cache immediately before provider call" step below). Do not simplify or merge
it into the combination-lookup logic.

### New execution flow

1. **Load location** — `location_id`, `visual_description`, `environment`, `seed`, status/
   eligibility fields (via the unchanged `BG_ELIGIBILITY_CLAUSE`). No render hash is required for
   cache resolution.

2. **Resolve TOD policy** — read `background_tod_variants_enabled` (`=== 'true'`). If false:
   `todKey = null`. If true: `todKey = normalize(environment.time_of_day)`. If TOD is missing/empty:
   `todKey = null`. Do not fail generation because TOD could not be resolved.

3. **Lookup combination BEFORE resolving image provider** — query `location_image_combinations`
   where `location_id = ?` and `time_of_day_key` matches `todKey`. If found: record swipe →
   combination, return cached URL. This lookup must happen before provider resolution and prompt
   synthesis — a cached image should not care whether the active image connection has since
   changed. That's a genuine improvement over the current flow, not just a refactor: today's cache
   check (the hash comparison) already requires resolving the provider and synthesizing the prompt
   first, since the hash is *over* those inputs; moving the check earlier removes that dependency
   entirely.

4. **In-flight protection** — change the current in-memory guard from `location_id` to the actual
   combination identity: `` `${locationId}:${todKey ?? '__base__'}` ``. Otherwise `kitchen + morning`
   rendering could unnecessarily block `kitchen + evening` when TOD variants are enabled. The
   database uniqueness constraints remain the final race guard.

5. **Recheck cache immediately before provider call** — after entering the in-flight section, query
   the combination table again (closes the normal race window) and re-run the eligibility recheck
   (the existing "superseded" drop rule — a swipe may have landed while this pass was starting up).
   If another caller created the combination: use it, record swipe mapping, return cached.

6. **Only now resolve provider and synthesize prompt** — if the combination genuinely does not
   exist: resolve active background image connection, synthesize prompt, generate URL. The prompt
   may still include time/date/environment if desired — that's independent from cache identity.
   Important consequence: with TOD variants OFF, the first render wins permanently even though
   later visits could produce a somewhat different prompt. That is intentional.

7. **Insert combination** — after generation, insert into `location_image_combinations`. Use the
   unique indexes to protect against races. If insertion conflicts because another render somehow
   won: fetch the winning stored combination, use its URL, do not overwrite it with the later URL.
   Log the duplicate provider spend — it indicates the in-flight/race guard failed to prevent wasted
   work.

8. **Record swipe mapping** — update `recordSwipeImage()` to record `combination_id`. The swipe
   association no longer needs a render hash.

9. **Stop mutating `locations.image_url` as the primary cache** — the combination table becomes
   authoritative. Update the readers (`locationImages.ts`, below) to resolve combinations directly
   and treat `locations.image_url` only as legacy/backfill state. Do not maintain two competing
   authoritative cache systems long-term.

### Remove prompt-hash cache semantics

Remove runtime use of `renderInputHash()`, the `image_render_hash` comparison, and
`inputsMatchSnapshot()` for cache decisions. `image_rendered_input` and `image_render_hash` may
remain physically present in `locations` during this change for backward compatibility — they
simply stop deciding whether to regenerate. Do not drop the columns yet. That keeps the migration
reversible and prevents this change from ballooning into unrelated schema cleanup.

---

## `orchestrator/src/server/locationImages.ts`

This file currently resolves chat backgrounds through `locations.image_url` in three separate
query paths inside `resolveChatLocationImage` (the scene_id-pointer current lookup, the
active-swipe fallback lookup, and the previous-scene lookup). All three need to resolve through
combinations instead.

### Current active scene

For the current location: determine whether TOD variants are enabled, resolve the current TOD key,
resolve the matching `location_image_combinations` row, expose that URL. If no combination exists:
`imageUrl = null` — the existing async discovery path then generates it.

### Swipe fallback

When resolving a specific active swipe, prefer `location_swipe_images.combination_id →
location_image_combinations.image_url`. This is stronger than recalculating the current combination
from mutable scene state, because the swipe explicitly remembers what it used.

### Previous scene

Resolve the previous scene's appropriate combination rather than reading `locations.image_url`. Be
careful here: if the previous visual is shown purely as a temporary fallback while the new scene
renders, use its most recently associated background combination rather than reinterpreting the
previous location under the current turn's TOD. A previous-swipe association is preferable wherever
available.

---

## Broken URL Handling

`handleLocationImageBroken()` currently clears `locations.image_url` and (location-wide)
`location_swipe_images.image_url`, so the next cache check reruns — meaning today, one broken TOD
variant would blank every background for that location. Rewrite this around combinations:

- Identify the broken combination (by URL or combination id) and delete that
  `location_image_combinations` row — not every combination for the location.
- Because `location_swipe_images.combination_id` uses `on delete set null` (see the schema section
  above), deleting the row leaves swipe history intact; only the FK reference clears.
- Next active lookup misses on that combination and regenerates.

Example: `kitchen + morning` broken, `kitchen + evening` healthy — only morning should be
invalidated.

---

## Tests

### `orchestrator/scripts/verify-location-tracker.mjs`

Extend the existing location tracking tests:

- **Existing location reuse** — two turns resolve the same location; environment date/TOD changes.
  With TOD variants OFF: same `location_id`, same `combination_id`, same `image_url`, one provider
  call.
- **Same-location transient re-anchor** — a transient location is re-anchored to a later swipe;
  verify its background combination remains reusable.
- **Same-name row churn** — force the case where an old row becomes ineligible and the same named
  location is recreated; verify combinations are copied/reused and there is no provider call.

### `orchestrator/scripts/verify-location-image-combinations.mjs` (new)

**Correction — fake-pool drift risk.** This repo's fake-pool verify scripts match SQL by string
against a hand-maintained fake `pg` client, and a mismatch can silently pass-through wrong data or
hang forever if a query shape isn't recognized (seen before with background-job pollers in this
codebase). Match every query this rewrite introduces — the combination lookup, the in-flight
recheck, the insert-with-conflict-handling, and the `location_swipe_images.combination_id` update —
carefully against the fake pool's dispatch, and prefer failing loudly (throw on an unrecognized
query, as the existing scaffolds already do) over a silent no-op.

Required cases:

- **Base cache** — TOD disabled. Kitchen morning, kitchen evening → one combination, one provider
  generation.
- **TOD cache** — TOD enabled. Kitchen morning, kitchen evening, kitchen morning again → two
  combinations, two generations, third resolution reuses the morning URL.
- **Date ignored** — TOD enabled. Monday morning, Tuesday morning → same `morning` combination.
- **Prompt changes ignored for existing combo** — after kitchen/base exists, change the image
  prompt template, style prefix, model/settings → existing kitchen/base URL reused, zero new
  provider calls. (Important: this is the test that actually proves prompt hashing is gone.)
- **New location after provider change** — generate kitchen, change provider settings, generate
  bedroom for the first time → kitchen keeps its old URL, bedroom uses the new provider
  configuration.
- **Swipe cycle-back** — generate swipe A's combination, generate swipe B's, reactivate swipe A →
  the exact combination recorded for A is returned, zero generation.
- **Broken URL** — delete/mark broken one combination → that combination rerenders, another
  combination for the same location remains untouched.
- **Concurrency** — fire two simultaneous requests for kitchen + morning → one stored combination,
  ideally one provider call. If a provider race does occur despite the guard, the DB uniqueness
  constraint must select one canonical result, and the duplicate spend must be logged.

### Existing tests to update

Search for assumptions involving `image_render_hash`, `render_hash`, `image_rendered_input`,
`locations.image_url`, `location_swipe_images.image_url`. Update assertions to reflect: combination
identity determines reuse; prompt/provider inputs do not. Convert old cache tests into tests proving
the new invariants rather than deleting them.

---

## Files Expected to Change

**New**
- `db/migrations/0129_location_image_combinations.sql`
- `orchestrator/scripts/verify-location-image-combinations.mjs`

**Edited**
- `orchestrator/src/orchestrator/generateLocationImage.ts` — remove hash-based cache identity;
  resolve/create location + TOD combinations; combination-scoped in-flight guard; record swipe →
  combination; preserve `BG_ELIGIBILITY_CLAUSE` unchanged.
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts` — stop relying on image/hash carry
  as cache semantics; clone prior combinations when same-name row churn requires a new location row.
- `orchestrator/src/server/locationImages.ts` — resolve background URLs from combinations across
  all three lookup paths; prefer swipe combination mappings; broken-link handling targets
  combinations.
- Orchestrator settings surface/store/API — add `background_tod_variants_enabled`, including the
  `orchestrator_settings_key_check` rebuild.
- Frontend background/RP settings component — add one "Time-of-day variants" checkbox.
- `orchestrator/scripts/verify-location-tracker.mjs` and any other location/background verification
  scripts that assert hash behaviour.

Do not touch character visual combination logic in this change.

---

## Explicitly Remove / Deprecate

Runtime cache decisions must no longer depend on: synthesized prompt hash, date, full
`environment`, image provider, model, dimensions, steps, CFG, sampler, workflow parameters, style
prefix, negative prompt, seed. Those affect how a missing combination is generated. They do not
determine whether that combination already exists.

---

## Final Invariant

```
Background:  location + optional TOD  → persistent URL
swipe        → the combination it actually used
```

No image blobs. No recooking because a prompt hash changed. No mood dimension. No date dimension.
No hidden provider-dependent invalidation.
