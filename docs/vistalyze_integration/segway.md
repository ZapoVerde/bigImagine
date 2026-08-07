# Integrated Specification: Cleanup Pass & Post-Cleanup Heuristic Extraction

**Status**: Designed
**Scope**: Secondary LLM Cleanup Pass (built last round, already shipped), Post-Cleanup Heuristic Extraction for both Locations and People/Presence, and the full transient → permanent/inactive lifecycle those records go through — `docs/vistalyze_integration/location_status.md`'s design, generalized to characters per the explicit direction that it applies to people too.
**Governing Principles**: `bi_principles.md` §1 (Relational Record), §2 (LLM Reasons), §3 (Explicit User Signal Outranks Inferred Signal), §4 (Scene Scoping), §8 (Four Kinds of Code), §11 (Observability), §18 (Surfaced Prompts).

---

## 1. Overview & System Intent

This specification defines a two-stage post-processing pipeline that runs immediately after the main LLM completes its conversational turn and before the final assistant message is persisted to database storage, plus the ongoing lifecycle the records it creates go through as the story continues.

1. **Stage 1: The Cleanup Pass (LLM Call)** — already implemented (`docs/vistalyze_integration/cleanup_prompt.md`). An optional secondary LLM call that enforces anti-slop rules, formats thought suffixes, and guarantees the two-line header block defined in `cleanup_prompt.md` §2.4.

2. **Stage 2: The Post-Cleanup Heuristic Scraper (Zero-Token Processing)** — new in this spec. A deterministic pattern matcher that reads the guaranteed header block Stage 1 produces and extracts the location and the present-character roster, creating or updating transient records and the active scene's state accordingly.

3. **The Lifecycle (Sync-Tick + Fork)** — new in this spec. What happens to those transient records afterward: promotion to permanent canon when their originating swipe stays on the active timeline, demotion to inactive (never deletion) when it doesn't, exclusion from context while inactive, and resurrection on fork back onto that swipe. This is `location_status.md`'s already-agreed design, applied identically to locations and characters.

### Fail-Open Contract
If Stage 1 fails, times out, or returns empty output, it falls back to the raw reply (existing behavior, unchanged). Stage 2 then attempts to scrape whatever text actually got persisted — cleaned or raw. If no two-line header block is found, Stage 2 skips extraction entirely, logs it, and never throws. A turn is never blocked or degraded by either stage.

---

## 2. Data Model & Schema Extensions

### 2.1 Chat Sessions — Cleanup Preset (already shipped)
`db/migrations/0057_cleanup_preset.sql` / `0066_cleanup_preset_seed.sql`: `cleanup_preset_id`, nullable, `on delete set null`. No change here.

### 2.2 Scenes — Tied to (Chat, Location), Not One Mutable Row Per Chat
**This is the one missing piece that everything below depends on, and it needs to be more than a single pointer.** `chat_sessions` currently has no link to a scene at all — confirmed directly in `orchestrator/src/server/httpServer.ts` (the `buildNarratorStackItems` comment: *"chat_sessions has no scene_id column linking a chat to a scene — there is no trusted scope to auto-fetch against yet"*).

The naive fix is one `scenes` row per chat, with `active_location_id` swapped in place every time the party moves. That's wrong: `canon_facts.scene_id` and `scene_presence` both scope *to a scene*, and if a single scene row's location keeps getting overwritten, anything tied to it stops meaning "true at that specific place" — the party leaves the tavern for the inn, the same scene row's `active_location_id` now points at the inn, and a fact recalled by `scene_id` recalls everywhere afterward, tavern included. Principle 4 (Scene-Scoped Context) only holds if a scene actually pins to one place.

So a scene is identified by **the pair `(chat_id, location_id)`**, not by chat alone:

* **`scenes.chat_id`**: nullable reference to `chat_sessions(chat_id)`, **`on delete cascade`** — unlike `anchor_chat_id` on locations/characters (§2.3–2.4), a scene has no independent existence once its owning chat is gone; it's a per-chat visit record, not itself a piece of world canon. (Deleting a whole chat is an already-acknowledged full-teardown action elsewhere in this codebase; this is not the single-turn-delete case §2.3's `set null` reasoning is protecting against.)
* **`scenes.active_location_id`** (existing column, repurposed as the identity key, not a mutable "current" pointer): combined with `chat_id`, unique — `(chat_id, active_location_id)`. Revisiting a location this chat has been to before **reuses** that scene row (and its accumulated `scene_presence`/linked `canon_facts`) instead of creating a duplicate.
* **`chat_sessions.scene_id`**: nullable reference to `scenes(scene_id)`, `on delete set null` — a **cache**, not the source of truth. Stage 2 (§4.2) keeps it pointed at whichever scene it most recently resolved, purely so other readers (`buildNarratorStackItems`, `recall_canon_facts`) can do a cheap "this chat's current scene" read without re-deriving it from the location on every access. The real identity is the `(chat_id, active_location_id)` pair on `scenes` itself.
* A scene's own eligibility (§2.6) is derived from its `active_location_id`'s location status, not tracked separately — no extra lifecycle column needed on `scenes`.
* No special-case fork handling is needed for scenes (contrast §2.7's explicit resurrection step for locations/characters): once a resurrected location exists on the forked-into chat, that chat's next turn resolves-or-creates its own `(new_chat_id, location_id)` scene through the normal §4.2 path — it falls out for free.

### 2.3 Locations — Transient Lifecycle
Extends `locations` (`db/migrations/0045_locations.sql`):

* **`status`**: `'transient' | 'permanent' | 'inactive'`, default `'transient'`. (A fourth conceptual state, "deleted," is never stored — it's just the row being gone, per `location_status.md` §1.)
* **`anchor_chat_id`**: nullable reference to `chat_sessions(chat_id)`, **`on delete set null`** — not cascade. This is the field that keeps a *promoted, permanent* location traceable back to the story it came from, since promotion nulls out `anchor_swipe_id` (§2.5 below). Cascading here would mean deleting a chat destroys every location that chat ever promoted to permanent canon, which is exactly the data loss this whole design exists to prevent (same reasoning `canon_facts.chat_id`, `db/migrations/0054`, already applied — `set null`, never cascade, for anything that can hold permanent/approved state).
* **`anchor_swipe_id`**: nullable reference to `chat_message_swipes(swipe_id)`, `on delete cascade` — deleting the turn that originated a still-transient-or-inactive location takes it with it, same as `location_status.md` §3 Step 4 already specifies. Nulled out on promotion to `permanent` (§2.5).

### 2.4 Characters — Transient Lifecycle (mirrors locations exactly)
Extends `characters` (`db/migrations/0044_characters.sql`) with the identical three columns, for the identical reasons — an NPC the heuristic scraper auto-registers goes through the same promote/demote/exclude/resurrect lifecycle a location does, not a simpler one:

* **`status`**: `'transient' | 'permanent' | 'inactive'`, default `null` (existing, user-authored characters are neither — this column only means something once set, so it stays `null` for every character created through the normal Characters UI, and is only ever set by the auto-registration path in §4.4).
* **`anchor_chat_id`**: nullable reference to `chat_sessions(chat_id)`, `on delete set null` — same reasoning as §2.3.
* **`anchor_swipe_id`**: nullable reference to `chat_message_swipes(swipe_id)`, `on delete cascade` — same reasoning as §2.3.

`scene_presence` (`db/migrations/0046_scenes.sql`) needs no schema change — it already links `scene_id` to `character_id`; eligibility for *being in* that junction table is governed by §2.6 below, not by a new column on the junction itself.

### 2.5 Sync-Tick Lifecycle (`orchestrator/src/orchestrator/chatMemorySync.ts`)
This is `location_status.md` §3 Steps 1–2, generalized to run over both `locations` and `characters` in the same tick, and it is the part of the design Stage 2 (§4) does **not** do — Stage 2 only ever creates/attaches at generation time; promotion and demotion happen later, when a turn exits the live context window, exactly like canon-fact promotion already does in this same file.

When `chatMemorySync.ts` processes a message leaving the live window:
1. **Promote the active swipe's transient records**: every `locations`/`characters` row with `status = 'transient'` and `anchor_swipe_id` = that message's active swipe gets `status = 'permanent'`, `anchor_swipe_id = null` (keeping `anchor_chat_id`).
2. **Demote every other swipe's transient records**: every `locations`/`characters` row with `status = 'transient'` and `anchor_swipe_id` in one of that message's *other* (non-active) swipes gets `status = 'inactive'`. Never deleted.

Per Principle 3 (Explicit User Signal Outranks Inferred Signal): continuing play on a swipe *is* the user's explicit signal that its timeline is the one that happened — the same signal canon-fact auto-approval already treats as sufficient, so no separate human review step is introduced here.

### 2.6 Context Exclusion (Preventing Timeline Pollution)
A `locations` or `characters` row is **eligible** for lookup, recall, or injection into a prompt if and only if:
1. `status = 'permanent'` (or `status is null`, for ordinary user-authored characters), **or**
2. `status = 'transient'` and `anchor_swipe_id` is on the chat's current active swipe path.

`status = 'inactive'` rows are never eligible. This filter has to be applied everywhere a name gets looked up or recalled, not just at the point of creation:
* Stage 2's own name-lookup (§4.2, §4.4) — matching against an ineligible row would silently resurrect a different timeline's same-named location/NPC.
* `recall_canon_facts` / `buildNarratorStackItems`, wherever they resolve `linked_location_id` / `linked_character_ids` — an inactive link should recall as absent, not throw or leak.

### 2.7 Fork Resurrection
`forkChat()` (`orchestrator/src/io/chatSessions.ts`) forks up to a chosen swipe. At that point, per `location_status.md` §3 Step 3: any `locations`/`characters` rows (`inactive` or still-`transient`) anchored to the swipe being forked from are cloned into the new chat with `status = 'transient'`, `anchor_chat_id` = the new chat, `anchor_swipe_id` = the new chat's corresponding swipe. The clone is independent from that point on — its own promotion/demotion at the new chat's own sync ticks.

---

## 3. Prompt Construction & Input Assembly (Stage 1 — already shipped, unchanged)

See `docs/vistalyze_integration/cleanup_prompt.md` §3. No changes from this spec. The header format it enforces is now the canonical reference for Stage 2's parser — `cleanup_prompt.md` §2.4:

```
[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]
Present: Character A, Character B, Character C
```

---

## 4. Post-Cleanup Heuristic Extraction Pipeline (Stage 2)

Once Stage 1's output (cleaned, or the raw fallback) is in hand, Stage 2 runs these steps before persistence.

### 4.1 Header Pattern Scraping
Match the first two lines of the text against `cleanup_prompt.md` §2.4's exact format:
1. **Line 1** — the bracketed header: `TimeOfDay`, the date/era string, and `Location`.
2. **Line 2** — `Present: ` followed by a comma-separated character-name list.

No weather/atmosphere field exists in this format (an earlier draft of this spec assumed one; it was never part of what Stage 1 actually produces). If line 1 doesn't match the pattern at all, skip extraction entirely (§1's fail-open contract) — don't attempt a partial parse.

### 4.2 Location Population & State Resolution
1. **Lookup the location**: query `locations` for a name match, `user_id`-scoped, filtered to §2.6-eligible rows only (not "any location this user has ever had," which would risk matching a different, inactive timeline's same-named location).
2. **Match found**: update its `environment`/`visual_description` from the scraped values.
3. **No match**: create a new `locations` row — `status = 'transient'`, `anchor_chat_id` = this chat, `anchor_swipe_id` = the current active swipe, `visual_description` seeded from the extracted name, `environment` from the extracted time/date.
4. **Resolve the scene**: look up `scenes` by `(chat_id = this chat, active_location_id = the resolved location)` (§2.2). If found, reuse it — its accumulated `scene_presence` and any linked `canon_facts` carry over. If not, create it. Either way, stamp `chat_sessions.scene_id` with it (the cache pointer).

### 4.3 Image Generation — Deferred, Not In Scope This Pass
`locations.image_path`/`image_generated_at` exist as cache columns already (`db/migrations/0045_locations.sql`), but **no image-generation client exists anywhere in this codebase yet** (confirmed: no such module under `orchestrator/src`, and `0045`'s own comment says this pipeline "isn't built yet"). This spec does not wire anything up here — Stage 2 leaves `image_path`/`image_generated_at` untouched. When an image-generation plugin lands, the cache contract this step should use is: compare the location's `visual_description`/`environment` against `image_generated_at`, and (re)generate only on a change or a null. Not built now; noted so the future plugin has a documented contract to slot into rather than needing its own design pass.

### 4.4 People Detection & Scene Presence Population
Using the `Present:` line extracted in §4.1:
1. Split on commas into individual names.
2. For each name:
   * **Lookup**: query `characters` for a name match, `user_id`-scoped, filtered to §2.6-eligible rows (`status is null` — ordinary roster characters — or eligible transient/permanent).
   * **Match found**: use that `character_id`.
   * **No match (NPC auto-registration)**: create a `characters` row — `name` = the extracted name, `status = 'transient'`, `anchor_chat_id` = this chat, `anchor_swipe_id` = the current active swipe. Every other field stays at its default (empty persona/scenario/etc.) — this is a placeholder identity, not a full character card; a user can later flesh it out from the Characters view like any other row.
3. Replace the resolved scene's `scene_presence` rows with exactly the resolved set of `character_id`s — `Present:` is authoritative for "who's here now," so a character absent from it this turn is removed from presence (not deleted, just no longer marked present).

---

## 5. End-to-End Execution Sequence

**Per turn** (Stages 1–2, `handleChatCompletions`/`regenerateSwipe`):
1. Main generation pass produces the raw reply.
2. If `cleanup_preset_id` is set, run Stage 1 (already shipped) — cleaned text or raw fallback.
3. Run Stage 2 against whichever text resulted: scrape the header, resolve/create the location, resolve/reuse-or-create the `(chat, location)` scene, resolve/create-or-register present characters, update `scene_presence`.
4. Persist the message (and its active swipe) as today. No change to persistence itself.

**Per sync tick**, separately, whenever a message exits the live context window (`chatMemorySync.ts`, existing per-chat tick that already handles canon-fact promotion):
5. Promote that message's active-swipe transient locations/characters to permanent (§2.5.1).
6. Demote its other swipes' transient locations/characters to inactive (§2.5.2).

**On fork** (`forkChat()`, existing):
7. Resurrect any `inactive`/`transient` locations/characters anchored to the swipe being forked from, as new `transient` rows on the new chat (§2.7).

Steps 5–7 are not part of the per-turn path — they're the reason this spec cites `location_status.md` rather than reinventing it, and skipping them (as an earlier draft of this spec did) would leave Stage 2 creating records that never promote, never get excluded when stale, and never come back on fork.

---

## 6. Required File Changes & Module Responsibilities

### 6.1 Database Migrations
* **`db/migrations/0067_transient_location_and_people.sql`** (renumbered — `0058` is already taken by `0058_canon_facts_chat_scoped.sql`, and `0066` was the last one applied): adds `scenes.chat_id` (`on delete cascade`) and a unique index on `(chat_id, active_location_id)`; adds `chat_sessions.scene_id` (`on delete set null`, cache pointer); adds `status`/`anchor_chat_id`/`anchor_swipe_id` to both `locations` and `characters`, per §2.2–2.4 (check constraints on `status`, `on delete set null` on the chat anchors, `on delete cascade` on the swipe anchors).

### 6.2 Orchestrator Core
* **`orchestrator/src/orchestrator/locationAndPresenceScraper.ts`** *(new, Pure/IO split per `bi_principles.md` §8)*: header-block regex parsing (pure) plus the location/character resolve-or-create and scene-presence update logic (IO).
* **`orchestrator/src/server/httpServer.ts`**: after Stage 1 (existing `runCleanupPass` call sites in `handleChatCompletions`/`regenerateSwipe`), invoke the new scraper before persistence.
* **`orchestrator/src/orchestrator/chatMemorySync.ts`**: extend the existing per-chat sync tick with §2.5's promote/demote pass over `locations`/`characters`, alongside its existing canon-fact promotion logic.
* **`orchestrator/src/io/chatSessions.ts`**: `forkChat()` gets §2.7's resurrection step. Scene resolve-or-reuse-by-`(chat, location)` (§2.2) lives in the new scraper module alongside the location resolution it depends on, not here.
* Every existing reader of `locations`/`characters`/`canon_facts` that can resolve a `linked_location_id`/`linked_character_ids`/scene-presence row (`recall_canon_facts` in `plugins/canonize`, `buildNarratorStackItems` in `httpServer.ts`) needs the §2.6 eligibility filter added to its query.

### 6.3 Plugins & Frontend
* **`plugins/scenes/`**: reuse `setActiveLocationTool`/`addCharacterToSceneTool`'s underlying IO (or the queries directly) for Stage 2's scene updates — not necessarily the tool-call surface itself, since this path is heuristic/system-driven, not a model tool call.
* **`plugins/locations/`**, **`plugins/characters/`**: their create/update tools' underlying IO is reused by the scraper for resolve-or-create; no new tool-call surface needed for the heuristic path itself.
* No frontend changes required for this spec — the location/character records this creates are visible through the existing Locations/Characters views once created, same as any other row.
