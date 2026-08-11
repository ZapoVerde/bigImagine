# Integrated Specification: The Location Tracker (v2)

**Status**: Built, verified 2026-08-11 (v2 — restructured around the cleanup-coupled pipeline) —
cited by section throughout `renderLocationBlock.ts`, `httpServer.ts`, `adminServer.ts`, and
`LocationsView.tsx` (migration 0083).
**Scope**: Four coupled additions to BigImagine's location handling, modeled on Triggeryze's
Location Tracker ruleset (`stacks/sillytavern/st-extensions/SillyTavern-Triggeryze/docs/examples/location-tracker.json`):

1. **Cleanup-coupled scrape** — the story header is scraped when it is *good* (immediately, as
   today); when it is *bad*, the scrape waits for the cleanup repair and then runs against the
   repaired header (this closes the race documented in `ensureFirstTurnHeader.ts:10-20`).
2. **Describe-on-mint** — when the scrape mints a *new* location, the standard describer prompt
   (`location_describer_prompt` / `location_describer_history_pairs`) runs immediately, then the
   hash-cached render — the existing §5 decoupled chain, now fed from both scrape paths.
3. **Places ↔ locations** — `locations.parent_location_id` (the proposed parent/sub model,
   kept): a "place" (area, e.g. `The Tavern`) is a parent row; a "location" (specific room,
   e.g. `The Tavern - Kitchen`) is a sub row pointing at it. Parent rows carry the same lifecycle
   status as every location row, so they are **disabled on swipe** (demoted when their anchor
   swipe is replaced) and **deleted on delete** (cascade through `anchor_swipe_id`).
4. **The reinsertion prompt** — a TRG-style `<locations>` block (known locations to pick from +
   rules text) injected **back into the main prompt via the `'location'` marker slot** (a real,
   editable stack slot — always on by default, untickable/deletable per preset), plus the same
   block as a `{{known_locations}}` token in the header-repair prompt so the header-writer
   matches canonical names exactly.

**Governing Principles**: `bi_principles.md` §1 (Relational Record), §2 (LLM Reasons), §3 (Explicit
User Signal Outranks Inferred Signal), §4 (Scene Scoping), §8 (Four Kinds of Code), §11
(Observability), §18 (Surfaced Prompts/Presets).

---

## 1. Overview & System Intent

### 1.1 The Triggeryze reference

Triggeryze's Location Tracker runs as rules on SillyTavern events:

- The LLM ends each turn with a header `[ TimeOfDay | 🗓️ … | 📍 Location - Specific Area ]` +
  `Present: …`; regex rules extract `LT-current_loc` (the full `Parent - Sub` string) and
  `LT-parent_loc` (the portion before the first `" - "`).
- Locations persist as lorebook entries keyed `[chat_id, location, parent]` (parent locations) and
  `[chat_id, location, <parent name>]` (sub-locations). Parent vs sub is a *name-split
  convention*: everything before the first `" - "` is the parent. Change detection + re-anchor on
  swipe is handled by its `LT-changed` rule and the `{{if false}}…{{/if}}` async-dependency trick.
- The **`lt-update-preset` rule** (lines 289–316) composes a `<locations>` block every turn —
  all parent locations via `AND(chat_id, location, parent)`, sub-locations of the current parent
  via `AND(chat_id, location, {{LT-parent_loc}}, !parent)` — plus the rules text ("match against
  known locations exactly. Use Parent - Sub format. If the location is not listed, create a new
  one…"), and injects it into the **main prompt** via `inject-preset`.

### 1.2 The BigImagine adaptation — four points, one pipeline

BigImagine already owns the machinery Triggeryze re-implements ad hoc. The four requested pieces
fit together as one flow per turn:

```
turn
 └─ main narrator prompt carries the <locations> block via the 'location' marker slot
    (point 4 — §5.4)                                                        → the model
    narrates with canonical location names
reply persisted raw
 ├─ header GOOD  → scrape immediately, as today (point 1 — §4.2)
 └─ header BAD   → skip scrape; async cleanup subloop repairs the header
                   (5s tick), then scrape the REPAIRED message (point 1 — §4.3)
scrape resolves-or-creates location row(s)
 ├─ row is NEW  → standard describer prompt → visual_description → hash-cached
 │                render (point 2 — §4.4)
 └─ row exists  → re-anchor / same-place carry, no describe
parent/sub grouping via locations.parent_location_id; both rows transient, anchored to the
swipe → demoted on swipe replace, cascade-deleted on chat delete (point 3 — §2.2)
```

The one genuine architectural deviation from Triggeryze: ST's main LLM writes the header, so TRG
injects the block into the main turn and the header comes out matching. In BigImagine the main
turn **deliberately** excludes the header (`ensureFirstTurnHeader.ts:10-15`) and the header is
written by the cleanup/header-repair LLM (`cleanup_prompt.md` §2.4). So the block goes **both**
places: into the main prompt (point 4 — where the model "picks from" and narrates with canonical
names) *and* into the header-repair prompt as `{{known_locations}}` (§5.5 — where the header name
is actually chosen, so it matches exactly). Same block, one shared template, two seams.

### 1.3 Fail-open contract

Everything this spec adds is context or metadata, never a turn gate:

- The split, the block rendering, the scene read, both injection points, and the deferred scrape
  are **fail-open** (same contract as `segway.md` §1 / `locationAndPresenceScraper.ts`): any
  error, missing header, or empty list logs and degrades to today's behavior — the repair prompt
  runs without the block, the main prompt gains nothing, a failed cleanup repair simply means the
  turn's location is not scraped (exactly today's degraded case).
- The block is a bounded list of **names only** (no descriptions, no images) — small, cheap,
  zero-token to assemble (SQL lists; `bi_principles.md` §2: the LLM reasons, nothing else does).

---

## 2. Data Model & Schema Extensions

### 2.1 `locations.parent_location_id` — places ↔ locations

`db/migrations/0083_location_tracking.sql` adds:

```sql
alter table locations add column parent_location_id uuid references locations(location_id) on delete set null;
create index locations_by_parent on locations (parent_location_id);
```

Semantics — the load-bearing decisions (point 3, "keep the proposed"):

- **A "place" is a parent row, a "location" is a sub row.** Parent = the area (`The Tavern`),
  sub = the specific room (`The Tavern - Kitchen`), linked by `parent_location_id`.
- **`locations.name` stays the full header string, verbatim.** A sub row's name is
  `"The Tavern - Kitchen"`, not `"Kitchen"`. This is what keeps every existing exact-name seam
  working unchanged: the scraper's `where name = $1` match (`locationAndPresenceScraper.ts:213`),
  the §4.2.5 same-place image carry (`:248-253`), the character-side name match, legacy rows, and
  the header contract itself. The parent name is *derived* by split (§3.1) and the parent row's
  `name` is that derived portion.
- **A parent row is a real `locations` row** with its own lifecycle, image, and describer state —
  created by the scraper alongside its first sub (or by the backfill, §2.3). Parent rows have
  `parent_location_id = null`.
- **A sub row points at its parent via `parent_location_id`.** `on delete set null`, not cascade:
  deleting a parent row leaves the sub a standalone location (its full name still carries the
  parent prefix, so the name-derived fallback in §5.2 still groups it). A sub's provenance is its
  own row.

### 2.2 Parent lifecycle — disabled on swipe, deleted on delete

Parent rows are **plain transient rows anchored to the same swipe as their first sub** — no new
lifecycle machinery. The existing rules therefore apply identically:

- **Disabled on swipe**: when a swipe is regenerated and the new content names a different
  location, the new scrape mints fresh rows anchored to the new active swipe; the old swipe goes
  inactive, and `chatMemorySync.ts`'s sync tick demotes every transient row anchored to it
  (`status → 'inactive'`), parent and sub alike (migration 0067's promote/demote, §2.5 of the
  sync design). The parent/sub link is unaffected — inactive rows stay grouped.
- **Deleted on delete**: transient rows cascade-delete with their anchor
  (`anchor_swipe_id on delete cascade`, migration 0067) — deleting the chat deletes its swipes and
  with them the transient locations of that timeline. Permanent rows survive (by design,
  `location_status.md` §2).
- **Lifecycle is not inherited.** Each row keeps its own `status`/`anchor_chat_id`/
  `anchor_swipe_id` and its own §2.6 eligibility. When a parent and its first sub are minted
  together, both are transient on the same swipe, so the sync tick promotes/demotes them
  together — but each row's eligibility is still evaluated independently (§5.2).

### 2.3 Backfill (one-shot, idempotent)

Existing rows predate the split (the scraper stored full `"The Tavern - Kitchen"` names with no
parent). The migration backfills them so legacy data groups correctly from day one:

1. For every row whose `name` contains `" - "` and whose `parent_location_id` is null, compute
   `parent_name = split_part(name, ' - ', 1)` (trimmed; a row whose name *starts* with `" - "` is
   treated as standalone and skipped).
2. Resolve-or-create the parent row: reuse an existing `locations` row with
   `name = parent_name` (any status — the parent already exists because the LLM once emitted the
   area alone), else insert one with `visual_description = parent_name` (the never-described
   sentinel, `describer.md` §2, so the describer can enrich it if it ever becomes a scene's active
   location), `status`/`anchor_chat_id`/`anchor_swipe_id`/`environment` copied from the first sub
   processed, and a deterministic order (`order by location_id`) so repeated runs are idempotent
   (the `where … and parent_location_id is null` guard makes the second run a no-op).
3. Set `sub.parent_location_id = parent.location_id`.

### 2.4 `orchestrator_settings` keys

`0083` also widens `orchestrator_settings.key`'s CHECK constraint (same widen-only pattern as
`0078_location_describer.sql`) with three keys:

| key | default | meaning |
| :--- | :--- | :--- |
| `location_split_enabled` | `'true'` | Master switch for the split. On: the scraper splits, resolves-or-creates the parent row, and sets `parent_location_id` (§3.2). Off: today's flat behavior (single row, full name, no parent) — a reversible downgrade; already-created parent rows are harmless. |
| `location_injection_enabled` | `'true'` | Global kill switch for the known-locations block in *both* seams (§5.4 marker-slot value, §5.5 header-repair token). |
| `location_injection_prompt` | `''` (built-in) | The full `<locations>` block template; empty = the built-in default (§5.1). Same "empty override means built-in default" shape as `location_describer_prompt` (`describer.md` §5). |

All three are plain `orchestrator_settings` values read live, no restart (the house pattern;
`orchestrator/src/io/orchestratorSettings.ts`). The `SettingName` union and the CHECK list both grow.

---

## 3. The Split

### 3.1 `splitLocationName` — pure, one function

`orchestrator/src/orchestrator/locationAndPresenceScraper.ts` (or a sibling pure module) gains:

```ts
/** "The Tavern - Kitchen" → { parent: "The Tavern", sub: "The Tavern - Kitchen" };
 *  "The Smoking Pipe" → { parent: "The Smoking Pipe", sub: null }. Splits on the FIRST
 *  " - " only (Triggeryze's parent rule); a name starting with " - " is standalone. */
export function splitLocationName(name: string): { parent: string; sub: string | null }
```

Rules, mirroring Triggeryze's `Extract parent location` (location-tracker.json:53):

- Parent = the trimmed portion before the first `" - "`; sub = the full trimmed name.
- No separator → `sub: null`, the whole name is its own parent.
- First-separator-only: `"The Tavern - Kitchen - Cellar"` → parent `"The Tavern"`,
  sub `"The Tavern - Kitchen - Cellar"` (same as Triggeryze).
- Degenerate inputs (name starting or ending with `" - "`, empty parent after trim) → standalone.

### 3.2 `resolveLocation` rework — parent first, then sub

`resolveLocation` (`locationAndPresenceScraper.ts:204-278`) changes as follows, still fail-open:

1. `const { parent, sub } = splitLocationName(header.location)` when `location_split_enabled`,
   else treat as standalone.
2. When a parent exists: resolve-or-create the **parent row** (name = `parent`, same eligibility
   filter §2.6, same §4.2.5 same-place image carry, same environment merge — factored into a shared
   helper `resolveOrCreateLocationRow(...)` so the existing path and the parent path are one code
   path, §8 Four Kinds of Code). The eligibility filter applies to the parent lookup too: a parent
   row that exists but is `inactive` (alternate timeline) is **not** reused — a fresh eligible
   parent is minted for this timeline, exactly the rule the sub itself already follows
   (`segway.md` §2.6: a name match can never resurrect a different timeline's row).
3. Resolve-or-create the **sub row** as today (name = full header string), but with
   `parent_location_id = parent.location_id`. Both rows get the same `environment` merge and both
   are `transient` anchored to this turn's swipe when freshly minted.
4. **Fail-open downgrade**: if the parent resolve-or-create errors, log and mint the sub without
   `parent_location_id` (standalone) — never throw, never drop the turn's location.

### 3.3 What does not change

- `parseStoryHeader` and both header regexes (`locationAndPresenceScraper.ts:76-99`) — the header
  still carries one location string; the split happens after parsing.
- `scenes` / `chat_sessions.scene_id` / `previous_scene_id` — the scene still pins to the exact
  location row (the sub row when a room is named). Parent grouping is a property of `locations`,
  not of scenes.
- Images and the describer — per-row, unchanged (see §4.4 for when they run).
- Character/presence handling — untouched.

---

## 4. The Pipeline — cleanup-coupled scrape + describe-on-mint (points 1 & 2)

### 4.1 Today's flow and its race

- **'extend'** (new turn): `scrapeTurnPresence(…, reply, 'extend')` runs on the *raw* reply right
  after `appendMessages` (`httpServer.ts:1665-1672`).
- **'replace'** (swipe regen): `scrapeTurnPresence(…, reply, 'replace')` runs on the regenerated
  text right after `recordSwipe` (`httpServer.ts:1384-1391`).
- The async cleanup subloop (`cleanupLoop.ts`) then repairs a missing/malformed header on its 5s
  tick — and **nothing re-scrapes after the repair**. That is the documented race
  (`ensureFirstTurnHeader.ts:10-20`): on a turn whose raw reply lacked a conforming header, the
  location is never resolved, no scene is pinned, and the bg never fires. Turn 1 is the only case
  already handled — `ensureFirstTurnHeader` (`httpServer.ts:1645-1655`) repairs *before* the
  scrape, so turn 1 always scrapes a good header.

**Point 1 generalizes the turn-1 guarantee to every turn**: good header → scrape immediately
(no latency regression); bad header → wait for the cleanup repair, then scrape the repaired text.

### 4.2 Header GOOD → scrape immediately (unchanged path)

At both existing call sites, test the reply with the scraper's own pure `parseStoryHeader`
(`locationAndPresenceScraper.ts:86-99`):

- Parses (all fields present, incl. a non-empty location) → `scrapeTurnPresence` exactly as today.
- Fails → **skip the scrape entirely** (no rows, no scene, no fire) and let the cleanup tick own
  the deferred scrape (§4.3). This also removes today's wasted effort of scraping a headerless
  reply.

The same test drives the swipe-regen path ('replace').

### 4.3 Header BAD → deferred post-cleanup scrape

Hook: `cleanupLoop.ts`'s per-message executor (`:379-408`), after a **`repair-header` step's
writeback succeeded** — i.e. `applyRepairSteps` produced a text that differs from the message
content, `recordSwipeIfContent` accepted it, and `inspectHeader(cleaned, config.header)` is now
`'ok'`:

1. Fire `scrapeTurnPresence(…, userId, chatId, messageId, cleaned, mode)` on the **repaired**
   text — fire-and-forget, fail-open inside the scraper, never blocking the tick or the turn.
2. **Mode from the swipe ordinal**: `chat_message_swipes` rows carry `{index, count}`
   (`chatSessions.ts:63`). Index 0 = the turn's original content → `'extend'` (a location change
   advances `previous_scene_id`, the 0076 revert target). Index > 0 = a regeneration → `'replace'`
   (never advances it — the 0076 invariant). No new state to persist.
3. **Dedup is inherent**: re-scraping an already-scraped message is a no-op re-anchor
   (`resolveLocation` matches the existing eligible row and re-anchors it — the same-place carry
   path), and the job ledger's per-(message, swipe) dedup means each repaired message triggers
   this at most once per swipe.
4. The returned `locationId` (when non-null) feeds `fireLocationImageGeneration` (§4.4) — the
   describe→render chain fires for the location the cleanup just established.
5. Fail-open: cleanup repair failed (empty output, LLM error, still fails inspection) → no
   deferred scrape → the turn's location is not resolved, byte-identical to today's degraded
   case. The `in-flight` repair guard and job-ledger semantics are untouched.

`ensureFirstTurnHeader` needs no change — it already repairs-then-scrapes inline; §4.3 simply
extends the same guarantee to every later turn and to regenerated swipes.

### 4.4 Describe-on-mint (point 2)

The existing decoupled chain — `fireLocationImageGeneration` (`httpServer.ts:791-810`):
`describeLocationIfNeeded` → `generateLocationImage` — is the **standard describe prompt**
(`location_describer_prompt` + `location_describer_history_pairs`, `describeLocation.ts`), and it
already implements "new → describe, existing → skip":

- **New row** (minted this scrape): the never-described rule applies — described iff
  `visual_description` is empty or equals `name` (`describer.md` §2); a user-authored description
  is never overwritten.
- **Existing row**: re-anchored / carried (§4.2.5), the describer's skip rule leaves it alone.
- The render respects the §5.1.2 prompt-hash cache (migration 0076), so a re-render is never
  wasted.

What point 2 adds is **feeding**: the chain now fires from *both* scrape paths — the immediate
scrape (§4.2, as today) and the deferred post-cleanup scrape (§4.3, new — the case that today
silently produces no location and no image). No new prompt is authored; the "standard describe
prompt" is the existing one.

**Parent rows are not described on mint** (confirmed: if a location has never been *landed in* —
never a scene's active location — no description tokens are spent). A parent row is inert until it
becomes a scene's active location (the LLM emits the area alone); describing it while it is only a
grouping node wastes an LLM call. It gets described when it earns a scene, via the same chain.

---

## 5. The Reinsertion Prompt (point 4)

### 5.1 `renderLocationBlock` + the built-in default

New pure module `orchestrator/src/util/renderLocationBlock.ts`:

```ts
/** Expands the editable template with the two machine-generated lists and the current parent.
 *  {{parent_locations}}, {{sub_locations}}, {{current_parent}} are the ONLY tokens; anything
 *  else in an override template passes through verbatim (author's responsibility). */
export function renderLocationBlock(
  template: string | undefined,
  lists: { parents: string[]; subs: string[]; currentParent: string | null },
): string
```

Built-in default (`location_injection_prompt` unset) — Triggeryze's block, adapted (its
`{{lbTitles:…}}` lists become the two tokens; `{{user}}` becomes "the user" because the block is
emitted verbatim into the main prompt and never macro-interpolated):

```
<locations>
Known locations:
{{parent_locations}}

{{current_parent}} sub-locations:
{{sub_locations}}

When writing the location header, match against known locations exactly. Use Parent - Sub format. If the location is not listed, create a new one. The location must reflect where the scene ends at the conclusion of the current turn, not where it began. Present should list named characters only, excluding the user and any unnamed or background characters.
</locations>
```

Assembly rules (all zero-token):

- Parents list = the eligible parent rows' names (sorted). Sub list = the eligible sub rows of the
  current parent (sorted). Names are deduplicated.
- **Omission, not noise**: the `{{current_parent}} sub-locations:` section is rendered only when
  `currentParent` is set *and* the sub list is non-empty; the whole block is omitted when the
  parents list is empty (a fresh chat with no location yet — see §5.2).
- `{{parent_locations}}`/`{{sub_locations}}` expand to newline-joined names (empty → `""`).

### 5.2 List queries + eligibility — one shared loader

New `loadLocationBlock(deps, userId, chatId)` (in `locationAndPresenceScraper.ts` or a sibling
module; both seams in §5.4/§5.5 use it) returns `{ block: string | null, currentParent: string | null }`,
fail-open (`null` on any error):

1. **Current scene → current location**: the `chat_sessions.scene_id → scenes.active_location_id`
   join, same query pattern as `resolveChatLocationImage` (`httpServer.ts:835-858`). No scene yet
   (first turn, or the deferred scrape hasn't run) → `currentParent = null`, parents-only listing.
2. **Eligibility** — the shared §2.6 predicate (`ELIGIBLE_TRANSIENT_CLAUSE`,
   `locationAndPresenceScraper.ts:155-161`), scoped to this chat's active swipe path:
   `status = 'permanent'`, or `status = 'transient'` anchored to a swipe on this chat's active
   swipe path. `inactive` rows never appear (no timeline pollution, `location_status.md` §2).
3. **Parents** — eligible rows with `parent_location_id is null` (parent rows *and* standalone
   locations, both are their own parent), **plus the current parent by derivation** when its row
   is somehow ineligible or missing (a `splitLocationName` fallback entry, deduped) — the current
   parent must always be listed; it is the block's anchor.
4. **Subs of the current parent** — eligible rows where `parent_location_id = <current parent
   row id>`, with a name-prefix fallback (`name like <parent name> || ' - %'`) so rows minted
   while the split was disabled still group. Non-split, standalone current location → no sub
   section.

### 5.3 Current-parent scope

"Current parent" = `splitLocationName` of the current scene's active location's `name` — the room
`"The Tavern - Kitchen"` scopes its sub list under parent `"The Tavern"`. `previous_scene_id`
(migration 0076) is a *bg-revert* concept, not a prompt one: the block describes where the scene
**is**, so it reads the current scene only.

### 5.4 Injection A — the main narrator prompt, via the `'location'` marker slot (primary, TRG-style, point 4)

The mechanism is the prompt-stack **marker slot** — "really all this is creating is a marker
slot" — not a code-level append:

- **Activate the dormant `'location'` `MarkerKey`** (`assemblePromptStack.ts:58`):
  `buildNarratorStackItems` (`httpServer.ts:650-747`) gains a `chatId` parameter (threaded from
  `assembleSessionTurnContext` `:957-1031`, which already has it) and, when
  `location_injection_enabled`, sets `fields.location = loadLocationBlock(...).block` on
  `PromptStackFields`; unset when the block is empty. The existing emitting loop
  (`assemblePromptStack` `:79-96`) then emits it verbatim for any slot with
  `markerKey = 'location'`, and skips it when unset (`if (!value) continue`) — zero new plumbing.
- **Editable exactly like the rag prompts — already true today**: `'location'` is already in
  `MARKER_LABELS` as `'Active Location'` (`frontend/src/api/markerLabels.ts`, shared by
  `PromptStacksView.tsx` and `PromptInspectorPanel.tsx`), so the Prompt Stacks editor already
  offers it in the marker picker with the same affordances as `canon_facts` / `memory_recall` /
  `bridge` / `auto_recall`: tick/untick (`enabled`), reorder, delete from the stack. A user who
  doesn't want it unticks the marker or deletes the slot — no code path needed.
- **Always on by default**: migration 0083 inserts an enabled `'location'` slot at its canonical
  position (after `persona`, per the `markerLabels.ts` order) into the **builtin narrator
  presets** (Standard, Minimal — the 0042 seeds), one-time and guarded so a customized preset
  (slot inventory diverged from its builtin seed) is never mutated. User presets (e.g. `Comfy 2`)
  are untouched — the marker stays *available* there in the picker. This is TRG's
  always-injected preset, expressed as a stack slot.
- This is where the model "picks from": the list of canonical `Parent - Sub` names lands in the
  main prompt, so narration references locations by their exact names, and the header the cleanup
  pass later derives from that narration matches the list.
- `location_injection_enabled` remains the global kill switch for the marker's *value*: the slot
  may stay in the stack, it just emits nothing when the switch is off.

### 5.5 Injection B — the header-repair prompt (secondary, exactness)

The header-writing LLM calls (async subloop `cleanupLoop.ts` and first-turn `ensureFirstTurnHeader.ts`)
both go through `planCleanup` → `buildRepairPrompt(template, vars)`
(`cleanupHeuristics.ts:344-355`), whose `resolveArg` hook already expands `{{history, N}}`/
`{{prev_turns, N}}`. This spec adds one token:

- `buildRepairPrompt`'s `resolveArg` gains `known_locations` (no argument): returns
  `loadLocationBlock(...).block` when `location_injection_enabled` and non-empty, else `""`.
- The **default** `cleanup_header_prompt` (`DEFAULT_CLEANUP_CONFIG.headerPrompt`,
  `cleanupHeuristics.ts:472-488`) gains a `{{known_locations}}` line after the header-format
  instructions — so the repair LLM sees "match against known locations exactly; use
  `Parent - Sub`; create a new one if not listed" right where it decides the location name
  (Triggeryze's rule text, bound at its actual enforcement point).
- Custom `cleanup_header_prompt` overrides may place `{{known_locations}}` anywhere; an override
  without the token simply gets no block (author's choice, §18). Both callers inherit this
  automatically — one seam, both prompts.
- `RepairVars` (`cleanupHeuristics.ts`) grows the chat/user context the loader needs (it already
  receives history + `userName`; the callers already hold `chatId`).

### 5.6 Why both seams

- Main prompt (§5.4): the model *picks* a location and narrates with canonical names (point 4 —
  the TRG behavior the user asked to mirror).
- Header repair (§5.5): the header-writer *matches* canonical names exactly (point 1's chain
  depends on it — a repaired header that names a non-canonical location would fail the scraper's
  exact match and mint a duplicate). One shared template + one shared loader; the two seams are
  the same block in the two prompts that matter.

---

## 6. The Locations Page (hamburger menu)

### 6.1 Frontend registration

Four touchpoints, exactly the pattern the other specialist views use:

- `frontend/src/hooks/useTabs.ts:3-18` — add `'locations'` to `TabType`; add a label to
  `SUMMON_LABELS` (`:35-48`).
- `frontend/src/App.tsx:246-301` — import + render branch for the new view (views imported at
  `:17-29`).
- `frontend/src/components/appNav/AppNavDrawer.tsx:14-23` — drawer entry
  `{ type: 'locations', label: 'Locations', icon: '📍' }` (hamburger = `TabStrip.tsx:34-43`).
- New `frontend/src/views/LocationsView.tsx` (+ `.css`), modeled on `BackgroundsView`
  (admin-gated via `useAdminUnlock`, `attemptLoad` GET-all on open, patch-only POST on save —
  `BackgroundsView.tsx:97-152`) and `SettingsView`'s fieldset layout.

### 6.2 Sections

1. **Location tracking** (the new settings):
   - `location_split_enabled` toggle ("Split locations into Parent - Sub places").
   - `location_injection_enabled` toggle ("Inject the known-locations list into prompts").
   - `location_injection_prompt` textarea with "restore built-in" (empty = default, shown as
     placeholder), the same affordance the describer prompt already has in `BackgroundsView`.
   - A live preview of the current block for the active chat's scene (parents + current parent's
     subs as rendered today) — observability (§11) without opening the prompt inspector.
2. **Room describer** — the two keys currently living in `BackgroundsView`'s "Image Generation"
   fieldset (`BackgroundsView.tsx:214-281`): `location_describer_prompt` and
   `location_describer_history_pairs`. They **move entirely** to this page (single home — everything location-related leaves
   `BackgroundsView`, which keeps only `image_prompt_template` and the render-status table). The
   existing `/v1/admin/image-settings` endpoint keeps accepting the `describer_*` patch keys for
   back-compat.
3. **Header contract** — not re-hosted (the `cleanup_*` keys keep their single home on the Cleanup
   page); this section shows the two-line format statically with a pointer to the Cleanup page,
   plus the current `cleanup_header_regex` state read-only. Rationale: one key, one editor.
4. **Known locations browser** — a read-only table of the user's locations: name, parent (derived
   or from `parent_location_id`), status (`transient`/`permanent`/`inactive`), image thumbnail
   (`image_url` when present), `updated_at`. Parent rows group their subs. Backed by a new admin
   endpoint (§6.3). This is where the split and the disabled-on-swipe lifecycle become visible.

### 6.3 Admin endpoints (`orchestrator/src/server/adminServer.ts`)

- `GET/POST /v1/admin/location-settings` — modeled on `getImageSettings`/`setImageSettings`
  (`adminServer.ts:707-750`): returns `{ splitEnabled, injectionEnabled, injectionPrompt,
  injectionPromptIsDefault, describerPrompt, describerPromptIsDefault, describerHistoryPairs }`;
  POST accepts patch keys `split_enabled` / `injection_enabled` / `injection_prompt` /
  `describer_prompt` / `describer_history_pairs`, each written via `store.set`.
- `GET /v1/admin/locations` — the browser list: all rows for the current user (RLS-scoped, same
  admin-key pattern as `adminServer.ts:1507-1554`'s render-status table), ordered parent-first
  then by name.
- `frontend/src/api/client.ts` + `api/types.ts` gain `adminGetLocationSettings`,
  `adminSetLocationSettings`, `adminListLocations` (+ types), mirroring the `adminGetImageSettings`
  shape (`client.ts:607-616`, `types.ts:307-313`).

---

## 7. Verification

New `orchestrator/scripts/verify-location-tracker.mjs`, following `verify-location-describer.mjs`
(fake in-memory pool covering `locations`, `scenes`, `chat_sessions`, `chat_messages`,
`chat_message_swipes`, `cleanup_jobs`, `orchestrator_settings`):

1. **Split pure function**: the §3.1 table (two-part, standalone, first-separator-only, degenerate).
2. **Scraper**: a header `📍 The Tavern - Kitchen` mints parent `"The Tavern"` + sub
   `"The Tavern - Kitchen"` with `parent_location_id` set, both `transient` on the same swipe;
   a standalone `📍 The Smoking Pipe` mints one row with null parent; an existing same-name parent
   is reused, never duplicated; an `inactive` parent is not reused (fresh mint).
3. **Backfill**: legacy `"X - Y"` rows gain parent rows + `parent_location_id`; rerun is a no-op.
4. **Cleanup-coupled scrape (point 1)**: good header → immediate scrape resolves the location;
   bad header → call site skips the scrape (no rows, no fire); cleanup executor repairs the header
   and the deferred scrape resolves the repaired text — mode `'extend'` for swipe index 0,
   `'replace'` for index > 0 (previous_scene_id advanced only in the extend case); a repair that
   fails inspection triggers no scrape; re-scraping an already-scraped message is a no-op re-anchor.
5. **Describe-on-mint (point 2)**: a minted row gets the standard describer prompt + render fired;
   an existing row does not; a user-authored description is never overwritten; parent rows minted
   alongside a sub are not described.
6. **`renderLocationBlock`**: built-in output with/without subs, empty-list omission rules,
   token expansion, override template passthrough.
7. **Injection (point 4)**: `fields.location` is set when enabled and the block is non-empty,
   unset otherwise; `assemblePromptStack` emits the `'location'` marker slot verbatim when set
   and skips it when unset; the builtin presets' seeded `'location'` slot is enabled at its
   canonical position and a customized preset is never mutated; `{{known_locations}}` in the
   default header template expands to the block; custom template without the token gets none;
   `location_injection_enabled = false` → block absent in both seams.
8. **Admin endpoints**: GET/POST round-trip, patch validation, RLS scoping of the locations list.

Frontend: manual pass (drawer entry opens the tab, toggles persist, browser groups parents/subs).

---

## 8. Implementation Checklist (files touched)

- `db/migrations/0083_location_tracking.sql` — `parent_location_id` + index, backfill, three
  `orchestrator_settings` keys + CHECK widen, enabled `'location'` marker slot seeded into the
  builtin narrator presets (guarded against customized presets).
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts` — `splitLocationName`, factored
  `resolveOrCreateLocationRow`, parent-first `resolveLocation`, header-good test,
  `loadLocationBlock`.
- `orchestrator/src/util/renderLocationBlock.ts` — new pure block renderer.
- `orchestrator/src/orchestrator/cleanupLoop.ts` — deferred post-repair scrape hook (§4.3) with
  swipe-ordinal mode derivation.
- `orchestrator/src/orchestrator/cleanupHeuristics.ts` — `{{known_locations}}` in
  `buildRepairPrompt`; `DEFAULT_CLEANUP_CONFIG.headerPrompt` gains the token line.
- `orchestrator/src/server/httpServer.ts` — thread `chatId` into `buildNarratorStackItems`,
  header-good test at both scrape call sites (§4.2), scene read, `fields.location` population
  (§5.4).
- `orchestrator/src/server/adminServer.ts` + `orchestrator/src/io/orchestratorSettings.ts` —
  `location-settings` + `locations` endpoints; `SettingName`/CHECK growth.
- `frontend/src/hooks/useTabs.ts`, `frontend/src/App.tsx`,
  `frontend/src/components/appNav/AppNavDrawer.tsx`, new `frontend/src/views/LocationsView.tsx`
  (+css), `frontend/src/views/BackgroundsView.tsx` (describer fieldset removed),
  `frontend/src/api/client.ts`, `frontend/src/api/types.ts`.
- `frontend/src/api/markerLabels.ts` — **no change needed** (already registers `'location'` as
  `'Active Location'`); verified so the marker picker and prompt inspector pick it up unchanged.
- `orchestrator/scripts/verify-location-tracker.mjs` — §7.
- `db/migrations/README.md` — one entry for `0083`.

---

> **Compact point — pause here.** Context is healthy; the next chunk (implementation, or iterating
> the spec against user feedback) should start from a fresh read of this doc.
