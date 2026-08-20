# Per-turn character visual state — extraction, minting, and autofire portraits

## Goal

Turn the existing hidden inner-thoughts footer into the canonical current status snapshot for
every character in the trusted scene roster. Each record carries inner thoughts, a one-word
expression, and a fixed current outfit. After Cleaner output is final, parse it, compare it with
the prior state for that chat and character, persist changes, and — when the visible expression or
outfit actually changed — automatically render (or reuse) a portrait, the same way location
background images already autofire.

This is current, scene-scoped state. It is not a change to permanent `characters.appearance` or
`persona`.

## Canonical footer format

The footer is a single hidden `<details> … </details>` inner-thoughts block per reply. Its location
is **owned by the Cleaner**: `cleanup_footer_regex` (Settings-editable, `DEFAULT_CLEANUP_CONFIG`
fallback) is the one and only authority on where the footer is. `inspectFooter` (the repair
trigger), `extractRegion` (the visual-state location — `cleanupHeuristics.ts`), and the repair
prompt all derive from the same resolved config (`resolveCleanupConfig` in `cleanupLoop.ts`), so
the live path, the poll loop, and the visual-state pipeline can never disagree over where the
footer is. Nothing in the visual-state path hardcodes a second outer-footer regex or the
`<details>`/`<summary>▸</summary>` layout.

The `<summary>▸</summary>` header is optional. One `<Name>…</Name>` block per `Present:` roster
character; the parser is wrapper-tolerant and only treats leaf blocks carrying the field markers as
character blocks, so it does not re-encode the wrapper itself.

```html
<details>
<Ava>
Inner thoughts: She is trying not to let Brian see her worry.
Expression: wary
Outfit:
- Top: cream ribbed turtleneck
- Bottom: dark straight-leg trousers
- Accessory: silver watch
</Ava>
</details>
```

Fields are exact and ordered: `Inner thoughts:`, `Expression:`, then `Outfit:`. Outfit slots are a
**partial update** (see Partial outfit state below): zero or more `- Slot: value` lines, each known
slot at most once, in canonical relative order (present slots follow the same Outerwear/Top/Bottom/
Underwear top/Underwear bottom/Accessory sequence, gaps allowed) — an omitted slot carries no
information (it is merged against the prior state), and `- Slot: none` is the explicit "wearing
nothing there" value. Empty slot values are a format failure (ambiguous between "unknown" and
"none"). Expression is exactly one normalized word. Inner thoughts remain free text exactly as
authored.

`<Ava>…</Ava>` is deliberately the record boundary. The parser validates tag names against the
trusted header's `Present:` roster and resolves identity only through that roster's
`character_id`; a footer tag never creates or selects a character by itself. A name incompatible
with this compact syntax is a Cleaner format failure, not a reason to guess a different identity.

## Partial outfit state

An outfit slot has three distinct states that are never collapsed into each other:

- `''` (unknown) — no footer has ever declared a value for the slot; it carries no information and
  is never rendered as "not worn".
- `none` — the footer explicitly declares the character is wearing nothing there (e.g. a topless
  transition from a prior concrete value).
- a concrete worn item.

The stored `character_visual_states` row is always a complete six-slot snapshot; the merge on each
parsed footer is `next[slot] = parsed[slot]` when the footer declared it, else `before[slot]`, else
`''`. Only a *declared* slot can change state, so omission alone never autofires. `''` and `none`
produce distinct normalized cache keys, so a topless `none` and a never-declared `''` are never
the same image key.

## Current behavior and gap

`cleanupHeuristics.ts` currently accepts any hidden inner-thought `<details>` footer and only
invokes its repair model if the footer is absent or malformed (`inspectFooter`: a pure regex
`test()` against the configured shape — `ok` on any match, no inspection of what's inside). It
leaves a valid-shaped footer unchanged, even if the content is garbage.
`locationAndPresenceScraper.ts` then deterministically reads only the two-line scene header and
updates location/presence. It does not parse the footer. `describeCharacter.ts` is a one-time
background fill of `persona`/`appearance` and must not be used for changing clothing or
expression.

The plan adds an always-run post-Cleaner state extraction stage, plus an autofire portrait
pipeline modeled directly on the existing location-background autofire
(`orchestrator/generateLocationImage.ts` + `server/locationImages.ts`). Changing only the footer
prompt would not refresh state every turn, diff it, or produce a picture.

## Design principle: vocabulary is global, identity is not

Two different questions get asked about the same footer data, and they have different scopes:

- **"What does this word/phrase *mean*, structurally?"** — translating "grumpy" or
  "charcoal wool coat" into Portrait-Studio slot values. This is a **minting** question. It does
  not depend on which character or which chat is asking — the answer is character/chat-agnostic
  vocabulary, and the LLM call that produces it (`describeStudioSlots`) is worth memoizing
  globally (per household user, not per chat).
- **"Has *this* character, in *this* chat, ever looked like this before?"** — this is an
  **identity + combination** question, and the answer (a specific rendered image) is scoped to
  `(chat_id, character_id)`. The same outfit+expression on the same character in a *different*
  chat is not assumed to be the same picture.

Concretely:
- **Subject** needs exactly one mint per character, ever (`characters.appearance` rarely changes,
  and when it does the mint is simply redone) — this isn't really a cache, it's a one-shot
  per-character fact.
- **Expression** needs minting (an LLM call to turn a bare word like "grumpy" into Expression-layer
  slots), and that mint is worth caching **globally per user** — once "grumpy" is minted for any
  character in any chat, every future "grumpy" reuses it.
- **Outfit** needs **no minting at all** — the six footer fields already are the Outfit layer's
  slot values verbatim, per the user's explicit direction ("no need to mint outfits, they're just
  slots"). There is no LLM call to memoize, so there is no global outfit-definitions table.
- The **rendered image** for a given `(character, outfit, expression)` combination is cached
  **per chat** (`chat_id` in the key) — confirmed explicitly: a character's same outfit+expression
  in a different chat is not assumed to be the same look, so it renders fresh there.

## Data model

### `character_visual_states` (new)

Current snapshot, one row per `(chat_id, character_id)`, user-scoped:

- identity/scope: `visual_state_id`, `user_id`, `chat_id`, `character_id`
- provenance: `message_id`, `swipe_id`, `source_turn_at`, `updated_at`
- snapshot: `inner_thoughts`, `expression`, `outerwear`, `top`, `bottom`, `underwear_top`,
  `underwear_bottom`, `accessory`
- `unique (user_id, chat_id, character_id)` — this is what makes the upsert in Pipeline Stage 3
  well-defined.

These records follow the active chat timeline. A stale Cleaner pass or non-winning swipe must not
overwrite the snapshot sourced from the active swipe (guard identical to the `active_swipe_id` +
`for update` row-lock pattern `cleanupLoop.ts` already uses for its own writeback race).

### `character_visual_state_events` (new)

Append-only, user-scoped: message/swipe provenance, affected character/state, changed visible
fields as JSONB, before/after data for audit. One row per character per turn where Expression or
Outfit actually changed — never for an inner-thoughts-only change.

### `character_subject_visuals` (new)

The one-shot Subject mint, keyed by character:

- `character_id` (PK, references `characters`), `user_id`
- `slots` jsonb — the Subject-layer slot map from `describeStudioSlots`
- `source_appearance_hash` text — sha256 of the `appearance` text the mint was generated from
- `created_at`, `updated_at`

Minted lazily, the first time a character needs any autofire render and has no row here yet (not
at character-registration time — a character who's introduced but never actually rendered
shouldn't cost an LLM call). If `characters.appearance` changes later and
`source_appearance_hash` no longer matches, the next autofire re-mints rather than serving a stale
Subject.

### `visual_expression_definitions` (new)

The global (per-user) Expression mint cache:

- `definition_id`, `user_id`, `word` text (normalized — trim + casefold, matching the Stage-3
  diff normalization), `slots` jsonb
- `created_at`
- `unique (user_id, word)`

### `character_visual_combinations` (new)

The chat-scoped rendered-image cache:

- `combination_id`, `user_id`, `chat_id`, `character_id`
- `outfit_key` text — canonical join of the six normalized outfit fields (same normalization as
  the Stage-3 diff: whitespace/case-normalized, `none` canonicalized)
- `expression_key` text — the same normalized word used for `visual_expression_definitions`
- `image_url`, `composed_prompt` (audit/debug, matching the provenance style of
  `visual_candidates`)
- `created_at`, `updated_at`
- `unique (user_id, chat_id, character_id, outfit_key, expression_key)`
- index on `(user_id, chat_id, character_id)` for the lookup path

All five tables: normal forced RLS (`enable row level security` + `force row level security`),
`user_scoped` policy, `grant ... to bigimagine_app` — the exact shape every `visual_*` table in
`0105_visual_studio.sql`/`0118_portrait_reflection_learning.sql` already uses.

## Pipeline

### 1. Cleaner produces the concrete status block

Revise the default, Settings-overridable footer repair prompt (`cleanupHeuristics.ts`'s
`DEFAULT_CLEANUP_CONFIG.footerPrompt`) to output the canonical block above. It rebuilds the
current snapshot from the reply and recent history, preserves existing inner thoughts where
available, and lists only characters in `Present:` order. The fallback must not be able to
recreate the obsolete format: no `<summary>▸</summary>`, no requirement to fill all six slots,
no filling unspecified slots with `none`, and one history pair.

The repair prompt needs the roster to know which characters to emit — add a new `{{roster}}`
macro to `buildRepairPrompt`'s `interpolateMacros` resolveArg hook (parallel to the existing
`{{known_locations}}` handling: loaded by the async caller, passed in as a plain string, `''` when
unavailable).

**Footer inspection (`inspectFooter`) becomes structure-aware, not roster-aware.** It gains the
ability to tell "conforms to the `<Name>...</Name>` / three-field shape" from "doesn't" — but it
does *not* validate the roster match, because `inspectFooter` runs independently of header
parsing today and has no roster available to it. Roster cross-validation is Stage 2's job only
(`parseCharacterVisualStateFooter`, which explicitly takes the parsed header). Keep
`inspectHeader`/`inspectFooter`'s existing independence — don't thread header state into
`inspectFooter` to chase full validation there. `inspectFooter` and the visual-state location
share `compileRegionRegex`, so they can never disagree over config semantics.

**The footer's location is Cleaner-owned.** Add a pure `extractRegion(text, cfg)` export to
`cleanupHeuristics.ts` — the first span the same region regex matches (`null` when the pattern is
unparseable or nothing matches). Stage 3 locates the footer through the resolved
`cleanup_footer_regex` before parsing; there is no second, hardcoded footer regex anywhere in the
visual-state path.

Legacy footers are opportunistically repaired on their next processed turn (existing behavior,
unchanged — a non-conforming footer is simply `malformed` under the new structural check).

### 2. Parse final response text deterministically

Add pure `parseCharacterVisualStateFooter(footerText, header)` in a new
`orchestrator/src/orchestrator/characterVisualStateParser.ts`. Runs after final turn text is
available — the normal final-turn flow and the deferred Cleaner writeback path — on the footer
*region* located by Stage 1's config (never the whole turn text). Validates required
labels/ordering, the partial outfit grammar (zero or more known slots, each at most once, any
order, non-empty value, `none` an ordinary value), one-word expression, and a one-to-one match
with the header roster. Returns complete records (with a partial outfit) or a structured failure.
The parser is wrapper-tolerant: it scans open tags and treats only leaf blocks carrying the field
markers as character blocks, so it does not hardcode `<details>`/`<summary>` and a bare block
parses just as well as a wrapped one.

Also exports the normalization helpers used by both the diff (Stage 3) and the cache keys
(`visual_expression_definitions.word`, `character_visual_combinations.outfit_key`/
`expression_key`) — one normalization implementation, not three copies:

```ts
export function normalizeExpression(word: string): string; // trim + casefold
export function normalizeOutfitKey(outfit: OutfitFields): string; // per-field trim/casefold,
  // 'none' canonicalized, joined in a fixed field order
```

Parsing makes no narrative decision. A malformed block logs and fails open: the chat turn and
location/presence scraping continue, existing visual state remains unchanged, and no autofire
fires.

### 3. Upsert and compare state atomically

New `orchestrator/src/orchestrator/characterVisualState.ts`. Resolve parsed records to roster
character ids and compare structured fields to the existing `character_visual_states` row in a
user-scoped transaction, guarded against a stale swipe the same way `cleanupLoop.ts` guards its
own writeback (`for update` row lock, compare against `chat_messages.active_swipe_id`, drop the
write if the swipe has moved on). The footer region is located through the same
`extractRegion(text, config.footer)` the Cleaner's resolved config provides (no region matched →
fail open before any DB work).

- New snapshot: insert it, record an initialization event.
- Identical normalized values (via `normalizeExpression`/`normalizeOutfitKey`): update provenance
  only; no event, no autofire.
- Inner-thought-only change: persist, no event, no autofire.
- Expression or outfit-slot change (normalized): persist, append one visible-change event per
  affected character/turn, **and fire `fireCharacterVisualAutofire`** (fire-and-forget, after the
  transaction commits — never inline, never awaited by the request path).

Each parsed record's outfit is a partial update merged against the prior row before the diff:
`next[slot] = parsed[slot]` (normalized) when declared, else `before[slot]`, else `''`. The stored
row is always a complete six-slot snapshot; `''` and `none` are distinct stored values and are
never converted into each other. Omission alone — a footer that declares no outfit slots — leaves
every slot unchanged and therefore never autofires.

### 4. Autofire the portrait

New `orchestrator/src/orchestrator/characterVisualAutofire.ts`, structurally the direct sibling of
`generateLocationImage.ts`:

```ts
export async function renderCharacterVisualCombination(
  deps: PortraitGenerationDeps,
  userId: string,
  chatId: string,
  characterId: string,
  outfit: OutfitFields,
  expressionWord: string,
): Promise<void>
```

Never throws (fail-open, same contract as every module in this pipeline). Steps:

1. **In-flight guard** — one render per `(userId, chatId, characterId, outfitKey, expressionKey)`
   at a time, mirroring `generateLocationImage.ts`'s per-location guard exactly (same in-memory
   mechanism, not new infra).
2. **Cache lookup** — `character_visual_combinations` on the exact key. Hit: log and return, done,
   zero provider cost.
3. **Drop check** — miss, but before spending anything: re-read the character's current
   `character_visual_states` row and confirm outfit/expression still match what triggered this
   call. If a newer turn already moved state on while this async pass was starting, drop without
   rendering (mirrors `generateLocationImage.ts`'s "drop" waste-prevention rule) — the newer
   state's own autofire call will handle it.
4. **Subject** — read `character_subject_visuals`. Miss, or `source_appearance_hash` doesn't match
   the character's current `appearance`: mint via
   `describeStudioSlots(settings, llm, userId, { layerId: 'subject', layerLabel, layerBoundary,
   name: character.name, context: character.appearance })`, upsert the cache row.
5. **Expression** — read `visual_expression_definitions` by normalized word. Miss: mint via
   `describeStudioSlots(..., { layerId: 'expression', name: expressionWord, context: '' })`,
   insert the cache row.
6. **Outfit** — no minting. The six normalized fields become the Outfit layer's slots directly.
7. **Style/Format** — resolved exactly like every other unspecified-layer lookup already does:
   `ensureEntityForLayer(deps.db, userId, layer, undefined)` for the `style` and `format` layers
   (`portraitGeneration.ts:172`), which already falls back to that layer's most-recently-used
   entity. Reused verbatim — no new resolution logic.
8. **Compose and render** — build a `Map<string, EntityRow>` with two real entries (style, format,
   from step 7) and three synthetic `EntityRow`-shaped entries (subject/outfit/expression, `slots`
   set from steps 4–6, `details: ''`, `template: null` except style). Hand the map to the existing
   `buildParentChromosome`/`buildParentDetails`/`compileTemplate`/`createImageGenProvider(...)
   .generate(...)` chain completely unchanged — this is the same machinery
   `renderPortraitPreview` already uses, just with a different per-layer resolution strategy.
9. **Persist** — on a successful render, upsert `character_visual_combinations` with the URL and
   composed prompt. On a provider failure: log and return (fail-open — no combination row is
   written, so the exact same trigger next time attempts again rather than caching a failure).

This function is the only place that talks to the image provider for this feature. It is fired
from Stage 3 exactly the way `fireCharacterDescription`/`fireLocationImageGeneration` are already
fired — after the response is sent, never blocking the chat turn.

## Chat surfacing (inferred — confirm before building)

Nothing above requires any Studio UI change — Subject/Expression caches and the combination cache
are system-managed, not Studio-editable, and no `visual_entities` row is created or linked for any
of this. But the autofire *image* needs to be shown somewhere, and nothing you've specified yet
says where.

By direct analogy to how location backgrounds surface (`locationImages.ts`'s
`resolveChatLocationImage(db, userId, chatId)` — a read endpoint the chat view calls to display the
current background), the minimal equivalent would be a
`resolveChatCharacterVisual(db, userId, chatId, characterId)` read, surfaced in the chat UI as each
present character's current portrait. This is **not** the same thing as `characters.avatar_url`
(the permanent library avatar shown in `CharacterAvatarThumb.tsx`) — conflating a scene-specific
autofire portrait with the permanent avatar would violate the same canonical-vs-derived split the
rest of this plan is built on. This section is flagged rather than specified because it wasn't
part of the discussion — confirm the intended display surface (a per-message portrait? a
persistent per-character panel? something else?) before this part is built.

## Files and surfaces

- `db/migrations/0125_character_visual_states.sql` — five new tables per Data model above.
- `orchestrator/src/orchestrator/characterVisualStateParser.ts` — new Pure Function module: footer
  grammar, `normalizeExpression`/`normalizeOutfitKey`, field comparison helpers.
- `orchestrator/src/orchestrator/characterVisualState.ts` — new Orchestrator: locate region via
  the resolved footer config, parse, resolve roster ids, guarded upsert, diff/event sequence,
  fires autofire on a visible change.
- `orchestrator/src/orchestrator/characterVisualAutofire.ts` — new Orchestrator: the autofire
  pipeline (Pipeline §4 above), sibling of `generateLocationImage.ts`.
- `orchestrator/src/orchestrator/cleanupHeuristics.ts` — structure-aware footer inspection, new
  `extractRegion` export, revised default repair prompt, new `{{roster}}` macro.
- `orchestrator/src/orchestrator/cleanupLoop.ts` / `liveCleanupHandoff.ts` — state extraction
  after cleaned text is durably written (deferred path).
- `orchestrator/src/server/handleChatCompletions.ts` / `turnExecution.ts` — state extraction for
  the normal final-text path, without double-running the deferred path (same precedent
  `fireCharacterDescription`'s index.ts wiring already established for this exact hazard).
- `orchestrator/src/server/characterVisualState.ts` — thin fire-and-forget wrapper, called from
  both trigger sites above, analogous to `server/characterDescription.ts`; resolves the live
  Cleaner config (`resolveCleanupConfig`) and passes `config.footer` into Stage 3 so the trigger
  and the cleanup loop share the single footer authority.
- Settings API/UI and `orchestratorSettings.ts` — retain the revised Cleaner footer prompt under
  the existing Cleanup prompt configuration; `orchestrator_settings.key` CHECK constraint rebuild
  needs no new key (footer prompt reuses `cleanup_footer_prompt`).
- Chat surfacing files (server read route, frontend display) — intentionally not listed yet; see
  the section above.

No Studio files (`portraitRoutes.ts`, `PortraitStudioView.tsx`, `api/types.ts`,
`portraitGeneration.ts`'s existing round/preview paths) need to change at all. `portraitGeneration.ts`
is only *read from* (its exported `ensureEntityForLayer`/`buildParentChromosome`/
`buildParentDetails`/`compileTemplate` types and functions), not modified — the autofire path is a
new caller, not a new branch inside the existing generation functions.

## Edge cases

- No valid header/roster: skip extraction entirely; footer content never decides scene membership.
- No footer region matched by the Cleaner's regex (or an unparseable regex config): fail open
  before any DB work — existing visual state stays, nothing fires.
- Unknown, duplicate, or missing character record: reject the entire snapshot extraction, retain
  prior state, no autofire.
- Character leaves `Present:`: no deletion, no invented cleared outfit — they simply have no
  current presence; their last `character_visual_states` row is untouched.
- Swipe/regeneration: guarded the same way Cleanup writeback is guarded (Stage 3's `for update` +
  `active_swipe_id` check); the autofire drop-check (Pipeline §4 step 3) is the second layer of the
  same protection, specific to the async render window.
- `characters.appearance` edited after the Subject mint already happened: detected via
  `source_appearance_hash` mismatch, re-minted lazily on the next autofire call for that character
  — no proactive re-mint, no background sweep.
- Existing history: no bulk retro-scrape; state starts with the next valid processed turn.
- A malformed footer never triggers autofire — Stage 2's fail-open means Stage 3 never runs, so
  there's nothing to diff or fire from.
- Provider failure during autofire: fail-open, no combination row written, logs and returns; the
  next real trigger for that exact combination retries from scratch (not cached as a failure).
- Future manual editing: a user-pinned correction outranks Cleaner inference until cleared, per
  Principle 3. Read-only in this initial implementation.

## Tests

- **Parser** (`verify-character-visual-state.mjs`, pure/no DB): multi-character records; partial
  outfits (zero or more slots in canonical relative order, `none` as an ordinary value); every
  structural failure (missing/unknown/duplicate/out-of-order slot, empty slot value, field order, non-one-word expression,
  unknown/duplicate tags, roster mismatch); wrapper tolerance (a bare block and a wrapped turn
  both parse); `normalizeExpression`/`normalizeOutfitKey` behavior — whitespace/case/`none`
  canonicalization and the three-way `''` vs `none` vs concrete cache-key distinction.
- **Cleaner**: canonical minimal block passes structural inspection (with and without
  `<summary>▸</summary>`, with a partial outfit); legacy generic inner-thought block is flagged
  malformed and needs repair; the revised repair prompt contains the roster correctly, no internal
  wrapper tags, and cannot recreate the obsolete six-slot/summary format; `extractRegion` matches
  the same config and fails open on an unparseable regex.
- **Fake-DB orchestrator** (`characterVisualState.ts`): initial state, identical no-op,
  inner-thought-only update (no event, no autofire call), expression change (event + autofire
  called with the right args), outfit change (same), multiple fields at once, stale-swipe
  rejection; partial-outfit merge (declared slot overrides, omitted slot keeps its prior value,
  no prior value → `''`); `Top: shirt` → `Top: none` is a visible change that fires; omission
  alone never autofires; unparseable footer regex fails open.
- **Autofire** (`characterVisualAutofire.ts`, fake-pool + fake image provider, following the
  `verify-portrait-telemetry.mjs` convention of throwing on any unrecognized SQL string):
  - Combination cache hit — no Subject/Expression mint, no provider call, existing `image_url`
    returned/logged.
  - Combination cache miss, Subject cache miss — mints Subject, upserts
    `character_subject_visuals`, then renders.
  - Combination cache miss, Subject cache hit, Expression cache miss — mints Expression only.
  - Combination cache miss, both caches hit — no mint calls at all, straight to render.
  - Drop check — a stale trigger (state has since moved on) never reaches the provider.
  - Provider failure — fail-open, no combination row written.
  - `source_appearance_hash` mismatch — forces a Subject re-mint.
- **Integration**: normal and deferred-cleanup paths each update state once and never
  double-autofire the same turn; live and poll cleanup resolve the footer region from the same
  `resolveCleanupConfig` settings store (`verify-cleanup-loop.mjs`).
- Run targeted verifiers, `npm run check --workspace=@bigbrain/orchestrator`, frontend
  check/build (only relevant if the Chat surfacing section above ends up in scope), and
  `git diff --check`.

## Out of scope

- Chat-UI surfacing of the autofire image (flagged above, needs its own confirmation/plan).
- Studio-visible editing of Subject/Expression mint caches (system-managed only in v1).
- Adding current clothing/mood to permanent character-card fields.
- Allowing Studio models to infer visuals from private inner thoughts —
  `inner_thoughts` is persisted and may be shown to the operator as story-status text, but is
  never included in a mint call, a Studio model payload, an image prompt, or a prompt trace.
- Free-form outfit slots; the six-slot vocabulary remains fixed for stable scraping, diffing, and
  cache keys.
- A global/cross-chat combination-image cache (explicitly rejected — chat-scoped only).
- A global outfit-definitions table (explicitly rejected — outfit needs no minting, so there's
  nothing expensive to memoize).

## Principles in play

- §1: snapshots/events/mint caches are canonical relational records; composed prompts and renders
  are derived.
- §2: Cleaner LLM supplies narrative judgment; parser/diff/cache-key code only handles declared
  fields, no inference.
- §3: future explicit user state edits outrank inferred Cleaner output.
- §4: identity comes from trusted header/presence, never footer tags alone.
- §8/§9: parsing, orchestration, and the autofire pipeline remain distinct, self-described
  modules — mirroring `generateLocationImage.ts`'s existing shape rather than inventing a new one.
- §11: malformed blocks, stale writes, and provider failures all log at their seams and fail open.
- §14/§17: every LLM call here (footer repair, Subject mint, Expression mint) goes through the
  existing gate and remains Settings-visible where a prompt is involved.

## Open questions for the user

1. **Chat surfacing** (see that section) — where does the autofire portrait actually get shown?
   Not decided yet.
2. Should `character_subject_visuals`/`visual_expression_definitions` get any operator-facing
   admin view (even read-only), or stay fully invisible in v1?
