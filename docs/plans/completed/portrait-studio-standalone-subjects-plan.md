# Portrait Studio — standalone subjects, no Card/Character linkage

*For Reasonix to implement per `docs/roles.md`.*

## Goal

Close Portrait Studio's training loop the way it was actually asked for: an operator can define a
training subject two ways — pull a live in-chat character in from the current RP chat's Cast list
as a one-time text copy, or type a brand-new subject straight into Studio and have it described on
the spot — and neither path leaves behind a persistent link back to the `characters` table. Studio
becomes a genuinely standalone training sandbox: no `character_id` requirement, no refresh-in-place,
no avatar promotion. Getting a trained result back onto a live character's avatar is deliberately
deferred to a separate, later feature that will live entirely on the chat side.

This supersedes Parts A and C of the old `studio-character-bridge-plan.md` (deleted — it described a
persona-seeded, refresh-in-place, chat-linked Subject entity and a winner-image-promotes-to-avatar
write-back, neither of which exist anymore; Studio never reads from or writes back to a chat or a
`characters` row today) and reverses the "a Subject entity is created from an existing `characters`
row" design decision `portrait-studio-plan.md` originally made. That old plan's Parts B (per-entity
winner `slots` write-back, still exactly as shipped — see `portraitFeedback.ts`) and D (the `format`
layer, `layerStack.ts`) needed no change here and live on as ordinary shipped code with no plan
document behind them; Part E (presence order + the `ActivePortrait` box) is unaffected by this plan
and is documented in its own files' doc comments.

## Background

Three conversations converged on this:

1. Portrait Studio's own inline "create a Subject" form only ever offers characters from
   `get_characters` called with no `chatId` — which, given how that query works, can *only* return
   Cards (`status is null`, the reusable template library), never a live in-chat character. So
   "training a Subject" was structurally reachable only through the Card library, even though the
   Card/Character split (`rp-cast-library-repair.md`) explicitly separated those two concerns for
   every other surface in the app.
2. A card is a reusable scenario/template; a character is a chat-scoped instance born from playing
   one. Neither is quite "a person I made up purely to tune Portrait Studio's Style/Outfit/Format
   knowledge on" — Studio needs its own third category, decoupled from both.
3. The operator's own framing, settled across this session: Studio is for training, not for holding
   linked state. A live character can be pulled in as training material, but the pull is one-way and
   one-time (a text copy, not a subscription). Promotion — putting a trained result back onto a
   character's avatar — is a separate future action triggered from the chat drawer's Cast list, not
   from Studio, and never automatic.

## Files

**New:**
- `orchestrator/src/orchestrator/describeStudioSubject.ts` — Orchestrator: one synchronous LLM call
  that turns a bare name (+ optional short seed) into a full appearance blurb, for the "type a name,
  get a described subject" default path. Structurally the small-sibling of `describeCharacter.ts`,
  minus the transcript-context machinery (no chat, nothing to read) and minus the fire-and-forget
  two-phase split (this runs synchronously inside the create-entity request — Studio is an
  operator-driven authoring surface, not a live-chat turn, so there's no reply latency to protect).
- `db/migrations/0111_portrait_subject_describer_prompt.sql` — widen
  `orchestrator_settings_key_check` to add `portrait_subject_describer_prompt` (Principle 17: default
  + operator override, same pattern as `character_describer_prompt`).

**Modified:**
- `orchestrator/src/server/portraitRoutes.ts` — remove the subject/`characterId` requirement and the
  `characterId` field entirely from entity create/update; remove `subjectExistsForCharacter` and
  every call site; replace `handlePortraitEntityFromCharacter` with a new, always-creates,
  never-links handler off a renamed route; delete `handlePortraitEntitySetAsAvatar` outright; wire
  the new describer into the create-entity path.
- `orchestrator/src/server/httpServer.ts` — drop the `/v1/portraits/entities/:id/set-as-avatar`
  route registration; rename the `/from-character` registration (see Contracts).
- `orchestrator/src/orchestrator/portraitFeedback.ts` — delete Part C (the winner-image-promotes-
  to-avatar block) and the `subjectCharacterId` tracking that only existed to feed it; drop the now-
  unused `writeAvatar` import. Part B (per-entity `slots` write-back) is untouched.
- `orchestrator/src/io/orchestratorSettings.ts` — add `portrait_subject_describer_prompt` to the
  settings key allowlist.
- `orchestrator/src/server/adminServer.ts` / `handleAdminDisplaySettings.ts` — extend the existing
  character-settings-shaped trio (or add a sibling) so `portrait_subject_describer_prompt` is
  readable/writable the same admin-gated way `character_describer_prompt` already is.
- `frontend/src/api/client.ts` — remove `seedSubjectFromCharacter` and `setPortraitEntityAsAvatar`;
  add `sendCastCharacterToStudio(characterId, apiKey)` hitting the renamed route; `createPortraitEntity`
  drops its `characterId` param, gains an optional `seed` param (subject-layer only).
- `frontend/src/api/types.ts` — drop `SetPortraitEntityAsAvatarResult` and the old
  `SeedSubjectFromCharacterResult`'s "refreshed" action variant (see Contracts); `PortraitEntityRow`
  keeps `character_id` in the shape (legacy rows may still carry one — see Edge Cases) but nothing
  new ever sets it.
- `frontend/src/views/CharactersView.tsx` (+ `.css`) — remove the entire "Send to Portrait Studio"
  block: the button, `studioSeedStatus` state, `sendToPortraitStudio` handler, and the
  `seedSubjectFromCharacter` import. The Cards page loses this feature outright — it never talks to
  Portrait Studio again.
- `frontend/src/components/sidebar/CastSection.tsx` — its existing "Send to Studio" row action calls
  the renamed client function; message copy simplifies to a single outcome ("Sent to Studio.") since
  there's no more create-vs-refresh distinction.
- `frontend/src/views/PortraitStudioView.tsx` (+ `.css`) — remove the `characters` state, its
  `get_characters` fetch, and the subject-create form's character `<select>`; add a `seed` text input
  to the subject-create form (used only when `layer.id === 'subject'`); remove the
  `entity.character_id && <span>...</span>` display line on entity cards.
- `frontend/src/views/SettingsView.tsx` (+ `.css`) — new fieldset for
  `portrait_subject_describer_prompt`, mirroring the existing Character-describer fieldset's
  shape (textarea, `(default)` marker, Save button) — no history-pairs sibling field, since this
  describer has no transcript to bound.
- `orchestrator/scripts/verify-visual-*.mjs` / `verify-portrait-routes.mjs` (whichever currently
  covers entity CRUD and the bridge routes) — updated per Tests below.

## Logic

### Part A — Subject entities stop requiring a character

`portraitRoutes.ts`'s create-entity handler currently 400s any subject-layer create with no
`characterId`, and validates/dedups against `characters` whenever one is supplied. All of that goes:
`CreateEntityBody` drops `characterId` entirely (not optional-and-ignored — genuinely not part of the
contract anymore), and every entity — subject included — is created with `character_id` left `null`
by the insert. `subjectExistsForCharacter` and its call sites (create, update, and the old
from-character handler) are deleted; there is nothing left to dedup against once entities can't be
linked. `UpdateEntityBody`/`parseUpdateEntityBody` likewise drop `characterId` — a PATCH can no
longer set or clear the column. The column itself stays on `visual_entities` (harmless, unused going
forward — see Edge Cases for what happens to rows that already have one).

### Part B — the new subject-create path: type a name, get it described

The subject-create form gains one new optional field, `seed` (a short free-text prompt — e.g. "an
Italian woman in her 30s"), alongside the existing `name` field. On create, when `layerId ===
'subject'` and the caller didn't supply `standingInstructions` directly (an operator who types full
instructions by hand gets exactly what they typed — Principle 3, explicit outranks inferred, applies
here the same as everywhere else in this codebase): call `describeStudioSubject(llm, { name, seed })`,
a single ungated LLM call using `portrait_subject_describer_prompt` (empty = built-in default),
interpolating `{{name}}` and `{{seed}}` (`seed` may be empty — the prompt instructs the model to
invent a full physical description from the name alone when it is, same "commit to it, don't leave
gaps" posture `APPEARANCE_SECTION_RULE` already uses). The built-in default prompt interpolates
`APPEARANCE_SECTION_RULE` (`orchestrator/src/orchestrator/personCuratorAppearance.ts`) exactly like
`describeCharacter.ts` and `curatePeople.ts` already do, so a Studio-native subject's instructions
read the same shape as any other appearance blurb in the system. The result becomes the new entity's
`standing_instructions`.

This call is synchronous and inline in the request — unlike `describeCharacter.ts`/
`describeLocation.ts`, there's no live-chat reply the operator is waiting on; the operator is already
looking at a "Create" button and can wait the extra second for a real result instead of a blank
placeholder. Fail-open per Principle 11: if the LLM call throws or returns empty, log it and insert
the entity anyway with `standing_instructions = ''` (the operator can type it by hand afterward) —
creation never blocks on the describer failing.

Other layer types (`outfit`, `style`, `expression`, `format`) are unaffected — `seed` and the describer
are subject-only; every other layer keeps today's plain create-with-typed-instructions behavior.

### Part C — Cast-only pull-in, one-time and unlinked

`handlePortraitEntityFromCharacter` is replaced by a handler with the same input shape
(`{ characterId: string }`) but different semantics: resolve the caller's own character (any status —
the route doesn't care whether it's a Card or a live character; in practice only `CastSection` calls
it now, and it only ever offers live in-chat characters via its existing `castOnly: true` listing), read
`appearance || persona` as the seed text exactly as today (409 `{ error: 'character has no appearance
or persona' }` when both are blank), and **always insert a new, unlinked subject entity** —
`character_id` is never set on the row. There is no more "does a subject already exist for this
character" check and no more refresh-in-place; clicking "Send to Studio" on the same cast row twice
creates two independent training subjects, exactly like clicking "+ new" twice would. `CastSection`'s
message copy collapses from "Seeded in Studio." / "Refreshed in Studio." to a single "Sent to Studio."

The Cards page (`CharactersView.tsx`) loses its own copy of this action entirely — see Files. A Card
was never chat-scoped to begin with, so there's no "pull from the current chat" framing that applies
to it, and the operator's explicit call was to keep Cards out of Portrait Studio altogether.

### Part D — promotion is retired, not replaced

`portraitFeedback.ts`'s Part C block (the `subjectCharacterId` lookup inside the per-entity winner
loop, and the fill-when-empty avatar-fetch-and-write block after it) is deleted outright, along with
the now-dead `writeAvatar` import. `submitPortraitFeedback` goes back to doing exactly what
`studio-character-bridge-plan.md` Part B describes and nothing past it: per-entity `slots`/
`last_image_url`/`current_best_candidate_id` writes, then ratings/notes, then Reflection. The
`POST /v1/portraits/entities/:id/set-as-avatar` route and its handler are deleted — there is no
override path either, since there is no automatic path left to override. A future "regenerate this
character's portrait" action, triggered from the chat drawer's Cast list and informed by whatever
Style/Outfit/Format wiki knowledge Studio has accumulated, is explicitly out of scope here (see Out of
Scope) — it is not a resurrection of this link, just a standalone generation action with its own,
separate design.

## Contracts

- `POST /v1/portraits/entities` — body becomes `{ layerId, name, slots?, standingInstructions?,
  template?, seed? }`. `characterId` is no longer part of the request or response contract for new
  writes. `seed` is accepted and used only when `layerId === 'subject'` and `standingInstructions` is
  absent/blank; ignored otherwise (never an error — a stray `seed` on a non-subject layer is silently
  unused, same permissiveness the rest of this route already has for irrelevant fields).
- `PATCH /v1/portraits/entities/:id` — drops `characterId` from `UpdateEntityBody`; a request body
  containing it is not an error (unknown fields are already ignored by this parser), it's simply
  inert.
- `POST /v1/portraits/entities/from-character` is renamed to `POST
  /v1/portraits/entities/from-cast-character` — a deliberate rename, not a silent behavior change
  under the old path, since "refreshes an existing linked entity" and "always creates a new unlinked
  one" are different enough contracts to deserve different URLs. Response: `200 { entity:
  PortraitEntityRow }` — the `action: 'created' | 'refreshed'` field is dropped (every call is now a
  creation). `404 { error: 'character not found' }` / `409 { error: 'character has no appearance or
  persona' }` unchanged.
- `POST /v1/portraits/entities/:id/set-as-avatar` — removed. `404` (route no longer exists) for any
  caller still hitting it.
- `visual_entities.character_id` — stays in the schema, stays in `PortraitEntityRow`'s shape (a
  pre-existing linked row must still round-trip through GET without erroring), but is write-only-
  never again: no code path after this plan ever sets it to a non-null value.

## Edge Cases

- A `visual_entities` row created by the *old* bridge (Parts A/C of `studio-character-bridge-plan.md`,
  before this plan lands) still has `character_id` set. Nothing here retroactively clears it — it's
  inert legacy data, harmless to leave, and `getEntity`/list reads still return it in the response
  shape. The frontend just stops rendering the "character: ..." line for every entity going forward,
  linked-legacy or not, since the feature it described no longer does anything.
- `describeStudioSubject` receives an empty `name` — can't happen; `parseCreateEntityBody` already
  400s on a blank `name` for every layer, subject included, before the describer is ever reached.
- `describeStudioSubject`'s LLM call fails, times out, or returns an empty reply — log a warning,
  insert the entity with `standing_instructions: ''`, return `201` exactly as a successful create
  would. The operator sees a subject with blank instructions and can type them by hand; creation is
  never blocked or errored by a describer failure (Principle 11).
- An operator supplies both `standingInstructions` and `seed` on a subject create — `standingInstructions`
  wins outright (Principle 3); the describer is never called, `seed` is silently unused. This is the
  same "explicit signal outranks inferred" rule the character/location describers already use for a
  non-empty field.
- `POST /v1/portraits/entities/from-cast-character` called with a Card's `characterId` (`status is
  null`) — still works exactly as it does for a live character (seeds from `appearance`/`persona`,
  creates unlinked). The route itself doesn't need to distinguish Cards from characters now that
  neither path leaves a link behind; the *only* enforcement of "Cards don't reach Studio" is that
  `CharactersView.tsx` no longer has a button that calls this route. Worth stating plainly since it
  means the restriction is a UI-surface decision, not a backend guarantee — see Out of Scope.
- Two clicks of "Send to Studio" on the same cast row — two independent subject entities, same name,
  no error, no merge. This is a deliberate consequence of dropping the per-character dedup, not an
  overlooked duplicate-prevention gap.

## Tests

- `parseCreateEntityBody`/`parseUpdateEntityBody`: `characterId` in the request body is accepted
  (ignored) without error; response/DB row never has `character_id` set from a new create.
- Subject create with no `standingInstructions` and a `seed`: `describeStudioSubject` is called, its
  result becomes `standing_instructions`.
- Subject create with `standingInstructions` already set (seed present or not): describer is never
  invoked; the entity's instructions are exactly what was supplied.
- Subject create with the describer's fake LLM provider throwing: entity still inserts (`201`),
  `standing_instructions === ''`, a warning is logged.
- `POST /v1/portraits/entities/from-cast-character`: two consecutive calls with the same `characterId`
  produce two distinct `entity_id`s, both unlinked (`character_id: null`), both seeded from the same
  character's `appearance`/`persona`.
- `submitPortraitFeedback`: after a winning round, no `characters` row is touched at all (no
  `avatar_path` write, no `writeAvatar` call) — confirm via a fake pool that asserts zero queries
  against `characters`.
- `POST /v1/portraits/entities/:id/set-as-avatar` returns `404` (route removed).
- `npx tsc --noEmit` across `orchestrator` and `frontend` after the client/type removals — confirms no
  stray reference to `seedSubjectFromCharacter`, `setPortraitEntityAsAvatar`, or `SeedSubjectFromCharacterResult`'s
  `action` field survives anywhere.
- Manual: Cards page has no Portrait Studio button anywhere in its UI. CastSection's row action still
  works and always reports "Sent to Studio." Portrait Studio's subject-create form has no character
  dropdown, has a `seed` field, and creating with just a name produces a described subject within a
  few seconds.
- Apply `0111_portrait_subject_describer_prompt.sql` by hand against the live DB (standing process,
  per every prior migration's own header), confirm the new Settings-tab fieldset loads/saves against
  it.

## Out of Scope

- **The future chat-side "regenerate this character's portrait" action** — explicitly deferred. It
  will live in the chat drawer's Cast list, fire a fresh generation informed by whatever's been
  trained in Studio (the wiki's whole-layer-type subscriptions already make trained Style/Outfit/
  Format knowledge available to any generation, no lookup-by-name or entity match required), and
  write the result straight to `characters.avatar_path`. None of its design (trigger, which layers it
  picks, whether it always overwrites or fills-when-empty) is decided here — it's a separate plan once
  actually built.
- **Backend enforcement that Cards can never reach Studio.** As noted in Edge Cases, that boundary is
  purely "the Cards page has no button for it" — `POST /v1/portraits/entities/from-cast-character`
  itself doesn't distinguish Card rows from character rows. Adding a server-side `castOnly`-style
  restriction to that route is a reasonable future hardening step but isn't required to satisfy what
  was asked (Cards' *UI* stops linking to Studio), and would need its own contract decision about
  what error a Card `characterId` should produce.
- **Migrating or clearing existing linked `visual_entities.character_id` values.** Left as inert
  legacy data (see Edge Cases) rather than backfilled to null — there's no behavior left that reads
  it, so cleaning it up has no functional benefit and isn't worth a migration.
- **Any change to Reflection, the wiki, `composer.ts`/`reconcile.ts`/`evoprompt.ts`, or the generation
  round itself.** This plan only touches how a Subject entity comes to exist and what happens after a
  winner is picked — the round machinery in between is untouched.
- **A settings surface for `seed` history or reuse.** Each subject-create call is independent; there's
  no saved list of past seeds to pick from.

## Principles / Conventions in Play

- `bi_principles.md` §3 (explicit signal outranks inferred) — a supplied `standingInstructions` always
  wins over the describer, exactly like every other fill-when-empty rule in this codebase.
- §11 (fail-open, log and continue) — `describeStudioSubject` failing never blocks or errors entity
  creation.
- §13 (DB-backed runtime config) — `portrait_subject_describer_prompt` lives in
  `orchestrator_settings`, not a constant.
- §17 (prompts surfaced for tuning) — the new describer gets a Settings-tab override, empty meaning
  "use the built-in default," same as every other prompt in the system.
- The shared `APPEARANCE_SECTION_RULE` constant (`character-appearance-field-plan.md`) is reused
  rather than re-specified, so a Studio-native subject's instructions can never semantically drift
  from what the character describer or people curator mean by "appearance."
