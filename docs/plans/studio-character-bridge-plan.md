# Studio ↔ Character bridge — persona-seeded subjects, winner write-back, avatar promotion, a Format layer

*For Reasonix to implement per `docs/roles.md`.*

## Goal

Close the "meta layer" between a character's narrative description and Portrait Studio's tuning
loop, in both directions. Today: (1) nothing carries a character's `persona` text into Studio — a
subject entity's `standing_instructions` has to be hand-typed from scratch; (2) Studio doesn't even
close its own loop — picking a round's winner never writes that winning chromosome back onto the
entity, so the next round still mutates from whatever `slots` held at entity creation, not from
what was just chosen; (3) a winning portrait never reaches the character it was tuned for — no
avatar gets set; and (4) the layer manifest has an aesthetic axis (Style) but no composition/shot-
type axis, so "make this a VN sprite" vs "make this a bust portrait" has nowhere natural to live
without duplicating every Style entity per shot type. A fifth piece closes the loop visibly: once a
character has a promoted avatar (Part C), show it — a small box above the chat displaying whoever
the current scene's `Present:` line named first, which requires actually preserving that line's
order through storage (today it's parsed in order and then discarded). Parts A-D need no schema
change; Part E needs one small migration for that ordering.

## Files

- `orchestrator/src/server/portraitRoutes.ts` — modified — new handler for
  `POST /v1/portraits/entities/from-character` (seed-or-refresh a subject entity from a character's
  persona) and `POST /v1/portraits/entities/:id/set-as-avatar` (explicit avatar promotion)
- `orchestrator/src/server/httpServer.ts` — modified — register both new routes, ahead of the
  existing `'*'`-family `/v1/portraits/entities` route (line 638) so a literal path segment like
  `from-character` is never mistaken for an entity id by that route's own segment parsing
- `orchestrator/src/orchestrator/portraitFeedback.ts` — modified — winner promotion (currently the
  single bulk update around line 489) becomes per-entity, per-layer: each promoted entity's own
  layer slots from the winning chromosome are written onto its `slots` column, and a subject-layer
  winner whose entity has a linked, avatar-less character gets that character's avatar filled in
- `frontend/src/api/client.ts` — modified — `seedSubjectFromCharacter(characterId, apiKey)` and
  `setPortraitEntityAsAvatar(entityId, apiKey)`, same `jsonRequest` shape as the existing
  `createPortraitEntity`/`updatePortraitEntity` (lines 1585-1599)
- `frontend/src/api/types.ts` — modified — response types for the two new routes
- `frontend/src/views/CharactersView.tsx` — modified — a "Send to Portrait Studio" action near the
  persona field (around line 544), for user-authored characters
- `frontend/src/components/sidebar/CastSection.tsx` (+ `.css`) — modified — the same action on each
  cast row (around line 127), for RP-born characters — which the Roster's own `get_characters` call
  never lists (no change to that exclusion; see Out of Scope)
- `frontend/src/views/PortraitStudioView.tsx` — modified — a "Set as character avatar" action on a
  subject-layer entity's card, shown only when its `character_id` is non-null
- `orchestrator/src/portraits/layerStack.ts` — modified — `DEFAULT_LAYER_MANIFEST` gains a fifth
  `format` layer and the default `template` gains a `{{format_overflow}}` token
- `db/migrations/` — new migration adding `presence_order` to `scene_presence` (applied by hand,
  same convention as every other migration in this codebase)
- `orchestrator/src/orchestrator/locationAndPresenceScraper.ts` — modified —
  `replaceScenePresence`'s insert loop (lines 512-521) writes each character's index in the
  already-ordered `characterIds` array as `presence_order`
- `plugins/scenes/src/getScenesTool.ts` — modified — the `character_ids` aggregate (lines 68-70)
  orders by `presence_order` instead of relying on `array_agg`'s undefined default order
- `orchestrator/src/orchestrator/cleanupHeuristics.ts` — modified — `DEFAULT_CLEANUP_CONFIG
  .headerPrompt`'s `- Present: ...` bullet (line 520) gains an instruction to list whoever is
  currently most narratively active/central first
- `frontend/src/components/chat/ActivePortrait.tsx` (+ `.css`) — new — the small box above the chat
  showing the current scene's first-listed present character's avatar
- `frontend/src/App.tsx` — modified — mounts `ActivePortrait` alongside `ChatView` for the `'rp'`
  tab, passing the same `{ apiKey, chatId, sceneId }` shape `CastSection` already takes (`App.tsx`
  already owns `activeSceneId`, lines 81-86, for exactly this kind of consumer)

## Logic

### Part A — persona-seeded subject entities

A new route takes a bare `characterId`, resolves that character (user-scoped; 404 if not found or
not the caller's), and reads its `name` and `persona`. If `persona` is blank, decline outright
(§Contracts) rather than seed an entity with empty instructions. Otherwise: call the existing
`subjectExistsForCharacter` check. No existing subject entity → create one exactly like today's
`POST /v1/portraits/entities` path does for `layerId: 'subject'` (name = the character's name,
`standingInstructions` = the character's persona, trimmed). An existing subject entity → overwrite
just its `standing_instructions` with the character's current persona; nothing else about the entity
(slots, template, name) is touched.

The overwrite is unconditional on every call — this is a button the operator clicks on purpose each
time, not a background pass, so there is no "already seeded, skip" rule here the way there is for
the persona *describer* (`describeCharacter.ts`). Clicking it again is how an operator deliberately
refreshes Studio's instructions after the persona itself has changed.

Two frontend surfaces call the same route: `CharactersView.tsx`'s editor pane (for user-authored
characters, which already show `persona` in a textarea) and `CastSection.tsx`'s per-row action (for
RP-born characters, whose `characterId` the Cast list already has — Part B of
`rp-cast-infrastructure-plan.md` built exactly this chat-scoped listing). The button is disabled (or
hidden, with a tooltip) when the character's persona is empty — for an RP-born character this is
normal until the A2 describer pass has fired at least once.

Once seeded, the entity lives in Studio's own entity list (`GET /v1/portraits/entities` has no
character-status filter) and is fully tunable there, even though the underlying character stays
invisible to the Roster/picker's own `get_characters` call. Worth being explicit about, since it
means "reachable in Studio" and "reachable in the Roster" are genuinely different things after this
plan — see Out of Scope.

### Part B — winner write-back (closing Studio's own loop)

`submitPortraitFeedback`'s winner-promotion write today (`portraitFeedback.ts`, the `update
visual_entities set last_image_url = $2, current_best_candidate_id = $3 ... where entity_id =
any($5::uuid[])` around line 489) applies the *same* two values across every entity in the winning
candidate's `entity_ids` map, and never touches `slots` at all. That means round 2 still mutates from
whatever `slots` the entity had at creation or last manual edit — never from what round 1's winner
actually was.

Change this to a per-entity update: for each `[layerId, entityId]` pair in the winning candidate's
`entity_ids`, write that entity's `last_image_url`/`current_best_candidate_id` as before, *and* set
its `slots` column to `winner.chromosome.slots[layerId]` — that layer's own values from the winning
chromosome, never another layer's. If a layer is absent from the winning chromosome (shouldn't
happen in practice — every promptable layer is always populated per `buildParentChromosome`), leave
that entity's `slots` untouched rather than writing an empty object over hand-tuned values.

This is what makes "getting the new shape back" mean something structurally: the winning shape
becomes the entity's own durable state, and the very next generation round's `ensureEntityForLayer`
read — and therefore the next mutation call's `parentSlots` — sees it as the thing to refine further,
not the original placeholder.

### Part C — winner image promotes to the linked character's avatar

Still inside the same winner-promotion step: when the winning candidate's `subject`-layer entity has
a non-null `character_id`, and that character's `avatar_path` is currently null, fetch the winning
image's bytes from its `image_url` and call `writeAvatar(characterId, bytes)`
(`plugins/characters/src/avatarStorage.ts`), then set `characters.avatar_path` to the same `'local'`
sentinel `insertCharacterFromCard.ts` already writes on import — every existing `avatar_path is not
null` consumer (`getCharacterAvatarTool.ts`, `exportCharacterCardTool.ts`,
`CharacterAvatarThumb`) picks it up unmodified.

`image_url` is always a URL our own resolved `image_connections` profile produced — never a value a
user typed in — so a plain `fetch` is the right trust tier here; this does not need routing through
`fetchUntrusted.js`'s SSRF guard, which exists for user-supplied URLs.

This is fill-when-empty only, mirroring the same "explicit signal outranks inferred" posture the
persona carry-forward and describer skip rule already use elsewhere (`bi_principles.md` §3): a
character with an avatar already set — imported, manually uploaded, or from an earlier Studio
promotion — is never silently overwritten by a later round's winner. For the deliberate-override
case, add a small explicit action instead: `POST /v1/portraits/entities/:id/set-as-avatar`, called
from a "Set as character avatar" button on a subject-layer entity's card in
`PortraitStudioView.tsx` (shown only when `character_id` is set). This path always overwrites — it's
an explicit click, same posture as the persona-refresh button in Part A.

### Part D — a Format layer alongside Style

The current four-layer default (subject/outfit/style/expression) has no axis for composition or
shot type — a bust portrait vs. a full-body VN/game sprite vs. a wider shot that still frames the
character (not a location plate) is a different concern from Style's aesthetic-treatment boundary
(medium, palette, lighting, finish). Folding shot type into Style would force a separate Style entity
per format × aesthetic combination instead of letting the two compose freely — exactly the
duplication the layer system already exists to avoid (it's why subject and outfit are split apart
rather than one blob).

Add a fifth entry to `DEFAULT_LAYER_MANIFEST`: `id: 'format'`, `label: 'Format'`, `promptable: true`,
boundary text covering composition/crop/framing/transparency intent — explicitly not the subject's
appearance, not what they wear, not the art style. Extend the default `template` string with a
`{{format_overflow}}` token alongside the existing four.

The layer manifest is already fully operator-editable at runtime through the existing "Manage
Layers" panel (`layerStack.ts`'s own docstring says so), and `loadLayerManifest` only seeds the
built-in default when the setting is genuinely unset — it never re-seeds an already-set value. On
the live deploy (already seeded), this code change alone has no retroactive effect; the operator adds
the Format layer once, by hand, through Manage Layers, the same way any other layer edit already
works. The code-level default exists for a future fresh install and as the documented recommended
shape, not because the running system needs a migration. Once added, by either path, Format entities
flow through every existing mechanism (tuning, wiki lessons, composition) with no further code
change — an operator creates entities like "Portrait" and "VN Sprite" under it exactly the way Style
entities are created today, and picks one per generation round.

### Part E — presence order, and an active-portrait box above the chat

**The ordering problem.** `resolvePresentCharacters` already builds its `characterIds` array in
exactly the order the `Present:` line lists names (`locationAndPresenceScraper.ts`, a plain
`for (const name of names)` loop). But `replaceScenePresence` just deletes and re-inserts rows into
`scene_presence` — a bare junction table with no sequence column — and `getScenesTool.ts`'s
`character_ids` field is built with `array_agg(sp.character_id) filter (...)` and no `order by`
inside it, so Postgres gives no ordering guarantee on the way back out. The order is computed once
and then genuinely lost; `scene_presence`'s existing `joined_at` column can't stand in for it either
— `replaceScenePresence`'s delete-then-insert loop runs inside one transaction, and Postgres's
`now()` is fixed for the lifetime of a transaction, so every row from one turn's presence replace
gets an identical `joined_at` regardless of loop position.

Fix: a new `presence_order` column on `scene_presence` (smallint, not null, default 0),
written by `replaceScenePresence`'s insert loop as that character's index in the already-ordered
`characterIds` array. `getScenesTool.ts`'s aggregate becomes
`array_agg(sp.character_id order by sp.presence_order) filter (...)` — its existing eligibility
filter (inactive/ineligible characters excluded) still applies before ordering; the result is an
ordered array of eligible survivors, first element reliably "whoever this scene's most recent
`Present:` line listed first."

**Making "first" mean something.** The `Present:` line's actual content is authored by exactly one
prompt: the header prompt (`orchestrator_settings` key `header_prompt`, default
`DEFAULT_CLEANUP_CONFIG.headerPrompt` in `cleanupHeuristics.ts`). This is not merely a repair-path
fallback despite living in the cleanup subsystem — `ensureFirstTurnHeader.ts`'s own header notes the
scene header is deliberately *not* part of the main turn-generation prompt at all; the async cleanup
subloop is what actually adds or repairs it, every turn. Add a clause to its `- Present: ...` bullet
instructing the model to list whoever is currently most narratively active or central to the turn
(speaking, acting, the scene's focus) first, with the rest following in no required order. Because
`header_prompt` is a Principle 17 default+override setting, an operator can keep retuning this
wording live from the Cleanup settings page afterward with no further code change.

**The box itself.** A new `ActivePortrait` component, mounted in `App.tsx` alongside `ChatView` for
the `'rp'` tab only, taking the same `{ apiKey, chatId, sceneId }` props `CastSection` already takes
— `App.tsx` already owns `activeSceneId` for exactly this kind of consumer. On mount and whenever
`sceneId` changes, it calls the chat-scoped `get_scenes` the same way `CastSection` does, reads the
matching scene's (now reliably ordered) `characterIds`, and takes the first entry. It looks up that
character's avatar the same way `CharacterAvatarThumb` already does (`fetchCharacterAvatarUrl`) and
renders it in a small box above the chat. This is read-only display — it never triggers Part A's
seeding or any Studio action itself, only shows whatever avatar already exists.

This is deliberately the simplest possible selection rule — first-listed, nothing weighted or
scored — a structure to prove the plumbing and refine later, not a final design.

## Contracts

- `POST /v1/portraits/entities/from-character` — body `{ characterId: string }`. `200 { entity:
  PortraitEntityRow, action: 'created' | 'refreshed' }`. `404 { error: 'character not found' }` when
  `characterId` doesn't resolve to the caller's own character. `409 { error: 'persona is empty' }`
  when the character's `persona` is blank.
- `POST /v1/portraits/entities/:id/set-as-avatar` — no body. `200 { characterId: string, avatarSet:
  true }`. `400 { error: '...' }` when the entity isn't a `subject`-layer entity or has no
  `character_id`. `404` when the entity id doesn't resolve to the caller's own entity.
- Winner-promotion `slots` write: per `[layerId, entityId]` pair in the winning candidate's
  `entity_ids`, the value written to that entity's `slots` column is exactly
  `winner.chromosome.slots[layerId]` — never a value from another layer, never the whole chromosome.
- `characters.avatar_path` — existing semantics unchanged (every consumer still just checks `is not
  null`); Studio only ever writes the same `'local'` sentinel `insertCharacterFromCard.ts` already
  uses, and only when the column was null beforehand (except via the explicit `set-as-avatar` route,
  which always overwrites).
- `get_scenes`' `characterIds` — ordered, first-to-last matching `presence_order`, which in turn
  matches the resolved `Present:` roster's left-to-right order for that scene's most recent
  extraction. Eligibility filtering (existing behavior) still happens before ordering.

## Edge Cases

- Persona is empty when "Send to Studio" is clicked — decline with the 409 above; no entity is
  created or modified.
- "Send to Studio" clicked a second time on an already-seeded subject — refreshes
  `standing_instructions` in place; `subjectExistsForCharacter` already guarantees this can never
  create a duplicate.
- A winning candidate's `entity_ids` names an entity that's been deleted mid-round — the per-entity
  update simply affects zero rows for that id; no error, consistent with this file's own
  never-throws, fail-open contract.
- A subject entity's `character_id` is repointed (via `PATCH`) between round start and winner
  selection — the avatar-promotion check reads `character_id` fresh at promotion time, not a value
  cached from when the round began.
- The character already has an avatar when a round's winner promotes — no-op on
  `avatar_path`/`writeAvatar`; `last_image_url`/`current_best_candidate_id`/`slots` still update as
  in Part B.
- The winning chromosome is missing a layer entirely (malformed data) — that entity's `slots` is left
  untouched rather than overwritten with an empty object.
- The Format layer doesn't exist yet on a given deploy — every existing round, entity, and
  composition continues to work exactly as today; Format is purely additive and nothing depends on
  its presence.
- The model's `Present:` line doesn't actually reorder turn to turn regardless of who's narratively
  focal (e.g. it always lists the same two names in the same order) — a prompt-quality problem, not
  a code bug; the ordering plumbing faithfully reflects whatever the model writes, and the header
  prompt's wording may need iteration after this ships.
- `sceneId` is null (no turn has landed a header yet) or the matching scene's `characterIds` is
  empty (nobody currently present) — `ActivePortrait` renders nothing, not an error or placeholder.
- The first-listed present character has no avatar yet (Part C hasn't fired for them, or their
  subject entity has no winning round) — same "renders nothing" fallback, not a broken-image state.
- A character stays present across many consecutive turns — `presence_order` reflects only the most
  recent `Present:` line's ordering (each `replaceScenePresence` call fully replaces presence and
  its order together), not a stable historical rank across turns.

## Tests

- `POST /v1/portraits/entities/from-character`: creates a new subject entity from a character with a
  non-empty persona; a second call refreshes (not duplicates) that same entity's
  `standing_instructions`; 404s for another user's character or an unknown id; 409s on an empty
  persona.
- `POST /v1/portraits/entities/:id/set-as-avatar`: 400s on a non-subject entity and on a subject
  entity with no `character_id`; on a valid subject entity, overwrites an already-set
  `characters.avatar_path` (unlike the automatic path in Part C).
- `submitPortraitFeedback`: after a round with a chosen winner, each promoted entity's `slots`
  reflects that entity's own layer from the winning chromosome — not another layer's values, and not
  a blind copy shared across every promoted entity.
- `submitPortraitFeedback`: a subject-layer winner whose entity has `character_id` set and whose
  character's `avatar_path` is null results in stored avatar bytes (`readAvatar` returns non-null)
  and `avatar_path is not null`; repeating with an already-set `avatar_path` leaves both the stored
  bytes and the column untouched.
- `layerStack.ts`: `parseLayerManifest` accepts a five-layer (Format-included) manifest exactly as it
  does a four-layer one; `getPromptableLayers`/`formatLayerDefinitions` include the new layer
  correctly — confirms no code path assumes exactly four layers.
- `replaceScenePresence`/`get_scenes`: a scene replaced with `Present: Bob, Alice` (in that order)
  round-trips through `scene_presence` and back out of `get_scenes` as `characterIds: [bobId,
  aliceId]` — not alphabetical, not insertion-arbitrary. A second replace on the same scene with the
  opposite order (`Alice, Bob`) correctly flips the returned order, proving it reads live
  `presence_order`, not a cached or derived rank.
- `ActivePortrait`: renders the first present character's avatar when one exists; renders nothing
  when `sceneId` is null, when the matching scene's `characterIds` is empty, or when the first
  character has no avatar set.

## Out of Scope

- Fixing `get_characters`' exclusion of auto-registered (RP-born) characters from its no-`chatId`
  listing — a separate, already-flagged issue. This plan sidesteps it by sourcing `characterId`
  directly off the chat-scoped Cast row rather than any character picker.
- Any structured extraction of "a list of outfits" from RP narrative text. Outfits stay entirely
  operator-authored in Studio (name + `standing_instructions` typed by hand), exactly as today —
  nothing about outfit seeding is automated by this plan.
- Reconciling `curatePeople`'s richer `canon_facts` profile into `characters.persona` — still its own
  deferred follow-on (`rp-cast-infrastructure-plan.md`'s own Out of Scope), unaffected either way by
  this plan; whatever `persona` holds at click-time is what gets sent to Studio.
- Unifying location/background image generation with Portrait Studio's entity model — a genuinely
  separate future project, already flagged in `portrait-studio-plan.md`'s own Out of Scope. Format's
  widest value is about framing the *character* within Studio's existing pipeline, not a location
  render.
- Any change to the mutation LLM's own prompt/tool shape (`evoprompt.ts`/`reconcile.ts`) — Format is
  just another layer flowing through the same generic machinery already built for it.
- Auto-firing "Send to Studio" from the persona describer or any other background trigger — this
  stays a deliberate, operator-clicked action on both surfaces, consistent with the rest of Portrait
  Studio being operator-driven rather than model- or pipeline-driven (`portrait-studio-plan.md`'s own
  framing).
- Any "smarter than first-listed" selection logic for the active-portrait box — weighting by recent
  dialogue turns, an explicit scene-focus marker, anything beyond "whoever `Present:` names first."
  Deliberately the simplest rule that could work, a structure to iterate on, not a final design.
- Showing more than one portrait at once, or any multi-character layout — one box, one character,
  for now.
- A settable default engine/style/format "shape" per character or globally (discussed but not
  designed) — `image_connections` currently resolves exactly one globally-active connection per
  purpose with no per-round choice at all; introducing that selection axis is a separate, larger
  piece of work than this plan covers.

## Principles / Conventions in Play

- `bi_principles.md` §3 (explicit signal outranks inferred) — governs the standing-instructions
  overwrite-on-click (fine, since it's an explicit act) and the avatar fill-when-empty-only rule (an
  existing avatar is explicit signal, never silently replaced by an automatic round).
- `bi_principles.md` §11 (fail-open, log and continue) — the per-entity `slots`/avatar writes inside
  `submitPortraitFeedback` follow the same never-throws contract that file's own header already
  states for the rest of the feedback flow.
- The layer manifest's existing "fully generic over layer count" design (`layerStack.ts`'s own
  docstring) — Format must not require any code path to special-case a fifth layer; if implementation
  finds one that does, that is the actual bug to fix, not a reason to bend Format around it.
