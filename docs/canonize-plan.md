# Canonize Implementation Plan

*Created 2026-08-04. Governed by `bi_principles.md`; scoped against `spec.md` §4 (schema), §4.1
(chat memory relationship), §7.1 (tool spec), and §8 (not yet designed). This document is the
detailed build plan for turning §7.1 from **(designed)** into **(built)**. Where this plan adds
detail spec.md doesn't have (the category/arc_tag columns below), that detail should be folded
back into spec.md §4 once this plan is approved — see §13.*

*Status tags follow spec.md's convention: **(built)**, **(designed)**, **(parked)**. Everything
below is **(designed)** — nothing in this document is implemented yet.*

---

## 1. Purpose

Build Canonize — approved Canon Facts with human-in-the-loop proposal review — as BigImagine's
native lorebook replacement. This is the platform's core memory mechanism for anything that isn't
raw chat history: who resents whom, what was discovered, what changed about the world.

This plan exists because two things became clear during research:

1. **The logic is right, the implementation isn't there.** SillyTavern-Canonize's actual design
   (read from `SillyTavern-Canonize/docs/lorebook.md` and `architecture.md`) is the correct target
   — propose/approve/reject/recall, human-gated, semantic-only, no keyword fallback. spec.md §7.1
   already captures this at the tool-signature level. What's missing is everything underneath: the
   prerequisite schema, the category/continuity model that keeps a *plot* thread from becoming an
   unbounded pile of disconnected fact rows, and the wiring.
2. **This is not the same system as `chat_memory_entries`/`household_memory`.** That system (built
   in an earlier pass, see `docs/chat-memory.md` and spec.md §4.1) is recent-history-shaped
   recall — a rolling digest of *what was said*. Canon Facts are fact-shaped recall — a curated
   record of *what is true*. They're complementary, not overlapping, and this plan does not touch
   the chat-memory system at all.

## 2. Non-Goals (explicitly out of scope for this plan)

Pulling in any of these would turn a bounded plan into an unbounded one. Each is real future work,
tracked elsewhere or flagged here for its own later plan:

- **Vistalyze's image pipeline** (`generate_location_image`, cache-first backend selection). This
  plan builds `locations` as a bare data table (§4) because `canon_facts.linked_location_id` and
  `scenes.active_location_id` need it to exist — but no image generation, no backend config, no
  cache-invalidation logic. That's Vistalyze's own plan.
- **Triggeryze** (`rules`, `status_effects`, `evaluate_rules`). Not touched at all.
- **The Director Pass** (automatic speaker selection). `propose_canon_fact`'s trigger point (§7)
  is written as a direct, manually-invokable hook precisely *because* there's no turn loop yet to
  automatically hook into.
- **The Character Roster** — PNG/JSON card import/export, the drag-and-drop UI, the URL importer.
  §8 below adds the smallest possible `create_character`/`create_location`/`create_scene` tools
  needed to exercise Canonize in dev, not the Roster experience.
- **The Inspector Canvas** as a real HUD panel. §10 below adds the smallest possible approval-queue
  view, not the split-screen character/location/rules panel spec.md §6 describes.
- **Single-user conversion** (dropping RLS, per spec.md §3). Explicitly and permanently out of
  scope — see §3.1.

## 3. Design Decisions

### 3.1 RLS is retained — a deliberate, standing deviation from spec.md §3

spec.md §3 says every table drops its `user_id` column and RLS entirely, since BigImagine is
single-user. **That conversion has not happened and must not happen as a side effect of this
plan.** Every table below (`characters`, `locations`, `scenes`, `scene_presence`, `canon_facts`)
carries `user_id` and sits under the same `user_scoped` RLS policy every other BigImagine table
uses today (per the `db/migrations/README.md` precedent — junction tables like `scene_presence`
denormalize `user_id` onto themselves rather than relying on a join, the same way
`chat_messages.user_id` does).

This is a real, tracked disagreement between this plan and spec.md's current text. Per this
repo's own rule ("where this spec and the principles disagree, the principles win — update this
spec"), the correct resolution is *not* to make the code match spec.md, but to update spec.md §3
once this plan lands, to mark single-user conversion as a distinct, separately-decided future
step rather than bundled into "what gets pruned." Flagged in §13.

### 3.2 `canon_facts` needs a category and an arc continuity key

spec.md's `canon_facts` is flat: one row per fact, no grouping key. Real Canonize avoids an
unbounded pile of disconnected rows about one unfolding situation through two mechanisms that
have no equivalent in the current schema:

- **MECE category tags** (`#place`/`#thing`/`#concept`/`#person`) route each fact to the right
  curator and give `recall_canon_facts` a cheap pre-filter before vector search.
- **Arc tags**, reused across entries for a continuing thread (`#elara_seat`, `#foundation_contest`)
  — a new tag only for genuinely new stakes — are what keep the *plot* lane bounded. Without this,
  every background extraction pass about the same ongoing situation just inserts another
  unlinked row, and `recall_canon_facts` eventually surfaces three or four stale, partially
  contradictory fragments of the same thread instead of one current one.

**Resolution:** add two columns to `canon_facts`:

- `category` — `CHECK` enum: `'place' | 'thing' | 'concept' | 'person' | 'plot'`.
- `arc_tag` — nullable text; `CHECK (category <> 'plot' OR arc_tag IS NOT NULL)`. Required exactly
  when `category = 'plot'`, meaningless otherwise.

Unlike Canonize's flat file, BigImagine's boundedness concern is what gets *injected into a
turn* (`bi_principles.md` §16), not file size — the table itself can hold full history. So instead
of Canonize's in-place `UPDATE` on the same lorebook entry, `canon_facts` **keeps every row** (new
proposal, new row, same `arc_tag`) and `recall_canon_facts` selects only the most recent
`approved` row per `arc_tag` within scope. This gets Canonize's continuity property (one current
thread state gets injected, not a pile of fragments) while also getting a free, undeleted audit
trail of how a plot thread evolved — a strict improvement on the file-based original, not just a
port of it, and it needs no new `status` value or `supersedes_fact_id` column to achieve.

Non-`plot` categories (`place`/`thing`/`concept`/`person`) don't get this treatment — they're
Canonize's General/People lanes, which don't have a continuity mechanic in the original either.
Avoiding near-duplicate proposals there stays an LLM judgment call at extraction time
(`bi_principles.md` §2), exactly as it is in real Canonize (the `**dup**`-marker merge is also a
curator judgment call, not a mechanical constraint).

### 3.3 Division of labor between `characters` and `canon_facts(category='person')`

Real Canonize's People Curator writes lorebook entries with five fixed sections: Appearance,
Personality, Connections, Relationship-with-{{user}}, Goals — because SillyTavern has no
structured character table, so the *entire* character, static and evolving alike, has to live in
lorebook text.

BigImagine already has a structured `characters` table (`persona`, `scenario`,
`example_dialogue`, `greetings`) that Canonize's ST target never had. That changes what
`category = 'person'` canon facts are *for*:

| CNZ People Curator section | BigImagine home |
|---|---|
| Appearance (fixed at creation) | `characters.persona`/`source_json` — not canon_facts |
| Personality (fixed at creation) | `characters.persona`/`system_prompt` — not canon_facts |
| Connections (character↔character) | `canon_facts`, `category='person'`, `linked_character_ids` |
| Relationship with the user (live, evolving) | `canon_facts`, `category='person'` |
| Goals (evolving) | `canon_facts`, `category='person'` |

Extraction (§7) must **never** write to `characters` — only ever propose `canon_facts` rows. A
genuinely new static detail that emerges in play (a scar, a revealed backstory fact) isn't
captured mechanically by this plan; that's a human editing the Roster, which is `bi_principles.md`
§3 (explicit signal outranks inferred) applied to identity specifically. This is an accepted gap,
not an oversight — extraction inferring and silently rewriting a character's core definition would
be exactly the "second reasoning engine" `bi_principles.md` §2 warns against.

### 3.4 Recall scoping is simpler than Canonize's, because BigImagine has structured scene state

Real Canonize's hybrid RAG (vector search across 2 lanes + temporal decay + TF-IDF keyword +
micro-pool threshold + score combination) exists because a flat lorebook file has no structured
notion of "who's in the scene right now" — it has to reconstruct relevance from the text alone.

BigImagine already has `scene_presence` and `scenes.active_location_id`. `recall_canon_facts`
doesn't need a keyword lane or temporal decay to find "what's relevant right now" — trusted scene
state already answers most of that question before any ranking happens. The plan (§7) is: a scope
filter (present characters ∪ active location ∪ current scene's global facts ∪ platform-global
facts) narrows the candidate set first, mechanically, from trusted state
(`bi_principles.md` §4) — *then* vector similarity ranks within that already-small set. No
TF-IDF, no decay, no micro-pool logic. This is a deliberate simplification, not a missing feature —
re-add hybrid ranking later only if plain semantic-within-scope proves too coarse in practice.

### 3.5 Extraction cadence: per-turn, unconditionally, revisit with evidence

spec.md's loop diagram (§5, step 7) puts fact extraction after every character reply,
unconditionally — no threshold, no batching. That's also consistent with this workspace's general
preference for judgment calls over hardcoded gates: start simple, let real usage tell you if
per-turn extraction is too expensive before adding a cadence knob nobody's proven is needed. Cost
containment for now comes from the same place chat-memory's does — the LLM gate's cache-aware
provider selection (`bi_principles.md` §14) — not from skipping turns. If real usage shows this is
too expensive, the fix is a `canon_extraction_every_turns`-style setting analogous to
`chat_memory_sync_every_pairs`, added when the evidence exists, not pre-built now.

---

## 4. Schema

Five new tables, all `user_scoped` RLS (§3.1), migrations `0044`–`0048` (one concern per file,
following this repo's existing one-migration-per-feature-slice convention).

```sql
-- 0044_characters.sql
create table characters (
  character_id      uuid primary key default gen_random_uuid(),
  user_id           uuid not null references users(user_id),
  name              text not null,
  persona           text not null default '',
  scenario          text not null default '',
  system_prompt     text not null default '',
  example_dialogue  text not null default '',
  greetings         jsonb not null default '[]'::jsonb,
  avatar_path       text,
  spec_version      text not null default 'v2' check (spec_version in ('v2', 'v3')),
  source_json       jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);
-- standard user_scoped RLS policy + grant, per db/migrations/README.md precedent

-- 0045_locations.sql
create table locations (
  location_id         uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(user_id),
  name                text not null,
  visual_description  text not null default '',
  environment         jsonb not null default '{}'::jsonb,  -- time_of_day, weather, mood
  seed                bigint,
  image_path          text,          -- cache only, not source (spec.md §4)
  image_generated_at  timestamptz
);

-- 0046_scenes.sql
create table scenes (
  scene_id            uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(user_id),
  name                text not null,
  active_location_id  uuid references locations(location_id) on delete set null,
  created_at          timestamptz not null default now(),
  last_active_at       timestamptz not null default now(),
  archived_at          timestamptz
);

create table scene_presence (
  scene_id      uuid not null references scenes(scene_id) on delete cascade,
  character_id  uuid not null references characters(character_id) on delete cascade,
  user_id       uuid not null references users(user_id),  -- denormalized, RLS precedent
  joined_at     timestamptz not null default now(),
  primary key (scene_id, character_id)
);

-- 0047_canon_facts.sql
create table canon_facts (
  fact_id               uuid primary key default gen_random_uuid(),
  user_id               uuid not null references users(user_id),
  scene_id              uuid references scenes(scene_id) on delete set null,
  category              text not null check (category in ('place','thing','concept','person','plot')),
  arc_tag               text check (category <> 'plot' or arc_tag is not null),
  summary               text not null,
  detail                text not null default '',
  vector_embed          vector(1024),  -- Voyage AI dims, matches db/migrations/0003 precedent
  status                text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  linked_character_ids  uuid[] not null default '{}',
  linked_location_id    uuid references locations(location_id) on delete set null,
  proposed_at           timestamptz not null default now(),
  approved_at           timestamptz
);
create index canon_facts_arc_tag_idx on canon_facts (arc_tag) where arc_tag is not null;
create index canon_facts_vector_idx on canon_facts using hnsw (vector_embed vector_cosine_ops);
```

Notes:
- `linked_character_ids` is `uuid[]`, not `int[]` as spec.md's diagram shows — spec.md predates
  this repo settling on `uuid` primary keys elsewhere (`chat_sessions`, `notes`, etc.); this plan
  follows the repo's actual convention over the diagram's placeholder type. Flagged in §13.
- `'rejected'` rows are kept, never deleted (`bi_principles.md` §15) — same for old, no-longer-
  latest `'approved'` rows in a `plot` arc (§3.2) — nothing in this schema ever deletes a
  `canon_facts` row; `reject_canon_fact` and superseding-by-arc are both status/insert operations.

## 5. The Canonize Plugin (`plugins/canonize`)

Same package shape as `plugins/notes` / `plugins/context-stack-presets` (own `package.json`,
`tsconfig.json`, `src/` with module preambles per `docs/conventions.md`).

### `propose_canon_fact` — IO Wrapper, background tool

```
args: {
  category: 'place' | 'thing' | 'concept' | 'person' | 'plot',
  summary: string,
  detail?: string,
  scene_id?: string,
  linked_character_ids?: string[],
  linked_location_id?: string,
  arc_tag?: string,          // required by handler when category === 'plot'
}
```
Embeds `summary + detail` via the existing embeddings IO wrapper (`io/embeddings`) at proposal
time (§3.2 — harmless to embed before approval, since `recall_canon_facts` filters `status`
regardless) and inserts a `'proposed'` row. Never returns anything selectable into a prompt —
its only consumer is the approval queue (§10). No `focusHint` — proposals aren't the kind of thing
a Canvas should jump to mid-conversation; the queue is a deliberate, separate visit.

### `approve_canon_fact` / `reject_canon_fact` — IO Wrapper, human-in-the-loop

```
args: { fact_id: string }
```
Straight `status` update (`'approved'`/`'rejected'`) plus `approved_at = now()` on approval. Both
scoped via `withUserScope` like every other tool — no special-cased auth beyond the RLS the row
already carries.

### `recall_canon_facts` — IO Wrapper, semantic search

```
args: { query: string, scene_id: string, top_k?: number }
```
1. Reads `scene_presence` for `scene_id` → present `character_id`s; reads `scenes.active_location_id`.
2. Builds the scope filter (§3.4): `status = 'approved'` and (
   `linked_character_ids && present_character_ids`
   or `linked_location_id = active_location_id`
   or (`scene_id = $scene_id` and `linked_character_ids = '{}'` and `linked_location_id is null`)
   or (`scene_id is null` and `linked_character_ids = '{}'` and `linked_location_id is null`)
   ).
3. For `category = 'plot'` rows, further restricts to the most-recent-`approved_at`-per-`arc_tag`
   (a `DISTINCT ON (arc_tag) ... ORDER BY arc_tag, approved_at DESC` subquery) before ranking.
4. Embeds `query`, ranks the scoped candidate set by cosine distance, returns the top
   `top_k` (default from a new `canon_recall_top_k` orchestrator setting, §6).

No keyword fallback anywhere in this path (spec.md §7.1's own constraint, carried forward exactly).

## 6. Settings surface (`bi_principles.md` §13 and §18)

New `orchestrator_settings` keys, widening the existing `key` `CHECK` vocabulary (same pattern as
`0030_llm_vision_capable_profiles.sql`):

- `canon_recall_top_k` — integer as text, default `'8'`.
- `canon_extraction_prompt` — the background extraction call's prompt template, per §18: ships
  with a built-in default (the category-routing + Connections/Relationship/Goals guidance from
  §3.3, written out as the actual instruction text an LLM extraction call receives), empty override
  means "use the default," readable/editable from Settings exactly like
  `chat_memory_*_prompt`-style entries already are.

No new admin route needed if `adminServer.ts`'s existing generic settings-key read/write path
already covers arbitrary `orchestrator_settings` keys (confirm against the current admin route
before assuming this — if it's per-key, a small addition there is needed).

## 7. Orchestrator wiring (temporary, until the Director Pass exists)

There is no turn loop yet that produces "after a character reply" as an event to hook (§2's
Non-Goals). Until `loop.ts` gains scene-turn awareness, `propose_canon_fact` is reachable only the
same way any other tool is — called directly (by an LLM during a chat turn, or via the direct
tool-invoke surface `toolInvoke.ts` already provides for the frontend). This is not a workaround
to fix later; it's the correct shape for what's actually built today, the same reasoning
`context-stack-presets` already used for `assemblePromptStack` having no caller yet (spec.md
§7.4's "Deferred (not yet wired)" note). The real automatic hook point — "after every character
reply, propose_canon_fact runs as a background step" — is Director Pass work, not Canonize work,
and gets wired when that loop exists.

## 8. Minimal supporting tools (the data-only slice, not the Roster/Vistalyze)

Enough CRUD to create a character, a location, and a scene with presence, so `canon_facts` and
`recall_canon_facts` are actually exercisable in dev and in verify scripts:

- `create_character(name, persona?, scenario?, system_prompt?, example_dialogue?, greetings?)` —
  no PNG/JSON import, no card-spec chunk parsing. `source_json` stays null for anything created
  this way.
- `create_location(name, visual_description?, environment?, seed?)` — no image generation.
- `create_scene(name)`, `set_active_location(scene_id, location_id)`,
  `add_character_to_scene(scene_id, character_id)` — direct mutations, no Director Pass.

These live in their own small plugin packages (`plugins/characters`, `plugins/locations`,
`plugins/scenes`) mirroring the one-file-one-purpose split `plugins/notes` already demonstrates,
not bundled into `plugins/canonize` — Canonize's plugin boundary is `canon_facts` only.

## 9. Frontend (minimal)

A single new view: the canon-fact approval queue — list of `status = 'proposed'` rows (summary,
category, linked entities) with approve/reject buttons calling the two tools via the existing
generic `callTool` API pattern (`plugins/notes`'s dual-surface precedent). This is *not* the
Inspector Canvas (`bi_principles.md` §5 — specialist views stay additive, and the full Canvas with
character cards/location metadata/active rules is real future work once those pieces exist too).
Scoped narrowly: this view's only job is making `bi_principles.md` §15's approval gate usable by a
human, nothing more.

## 10. Verify scripts

Following `docs/verification.md`'s fake-pool/fake-provider pattern, one script per concern:

- `verify-canon-facts.mjs` — `propose_canon_fact` writes a `'proposed'` row with an embedding;
  `approve_canon_fact`/`reject_canon_fact` transition status correctly and only touch the row they
  target; a `plot`-category proposal without `arc_tag` is rejected by the handler before it ever
  reaches SQL (mirrors `isCreateNoteArgs`-style arg validation).
- `verify-canon-recall.mjs` — the scope filter proof: a fact linked to a character not present in
  the scene is excluded; a fact linked to the scene's active location is included; a `'proposed'`
  or `'rejected'` fact never comes back regardless of scope; a `plot` arc with three superseding
  proposals returns only the latest `approved` one.
- `verify-characters-locations-scenes.mjs` — the §8 minimal CRUD tools, same shape as
  `verify-chat-sessions.mjs`'s style for a multi-table feature.

All three get added to `orchestrator/package.json`'s `verify` chain in dependency order (schema
tools before recall, since recall's fake pool needs seeded rows from the same tables).

## 11. Build order

1. Migrations `0044`–`0048` (§4).
2. `plugins/characters`, `plugins/locations`, `plugins/scenes` — the data-only slice (§8), each
   with its own verify script, before anything in Canonize can be tested end-to-end.
3. `plugins/canonize` — `propose_canon_fact`, `approve_canon_fact`, `reject_canon_fact` first
   (no ranking logic, easy to verify in isolation), then `recall_canon_facts` (§5, §7.4's
   pure/IO-wrapper split precedent suggests a small pure `scoreCanonFactRecall(candidates, query
   embedding)` ranking function factored out of the IO wrapper that fetches candidates, for the
   same testability reason `assemblePromptStack` was factored out — confirm this split is worth it
   once the query complexity in §5 step 2–3 is actually written, don't force it prematurely).
4. `canon_recall_top_k` / `canon_extraction_prompt` settings (§6) — needed before step 3's
   verify script exists in final form, since the recall tool reads the top-k setting.
5. The approval-queue frontend view (§9) — last, since it has nothing to display until step 3
   exists.

## 12. Open questions for the user

- **Settings admin route shape** (§6): confirm whether `adminServer.ts`'s existing settings
  read/write path is already generic-by-key or needs a small addition for the two new keys.
- **`character_id`/`location_id` type**: this plan assumes `uuid` (§4's note), matching the rest
  of the schema, over spec.md diagram's placeholder `int`/serial style. Confirm before migration
  `0044` is written, since changing a primary key type later is real migration churn.
- **Whether the pure-ranking-function split in `recall_canon_facts` (§11 step 3) is worth doing
  up front** or only once the query is written and its complexity is visible.

## 13. Follow-up doc updates (once this plan is approved, not part of this document)

- spec.md §3: split "single-user conversion" out from "what was pruned" into its own,
  explicitly-not-yet-decided line — it is not equivalent to the household-plugin removals it's
  currently listed alongside, and this plan's schema (§4) actively assumes it does not happen.
- spec.md §4: add `category`/`arc_tag` to the `canon_facts` diagram (§3.2), and correct
  `linked_character_ids`'s type from `int[]` to `uuid[]` (§4's note) to match the rest of the
  schema's actual key type.
- spec.md §8 ("Not yet designed"): remove the Canonize-adjacent gap once built; the
  `docs/chat-memory.md` BigImagine-pass item stays, unrelated to this plan.
