# Character appearance field — split physical description out of `persona`

*For Reasonix to implement per `docs/roles.md`.*

## Goal

Both character-description passes — the mint-time one-shot (`describeCharacter.ts`) and the
periodic RP sync curator (`curatePeople.ts`) — currently write physical appearance and
manner/personality into the same blended text: `describeCharacter.ts`'s `Persona:` blurb, and
`curatePeople.ts`'s `## Appearance` section folded into one flat `content` string alongside five
other sections. Nothing downstream can read "just the physical part," so
`studio-character-bridge-plan.md` Part A (`portraitRoutes.ts`'s seed-from-character route) hands
Portrait Studio's `standing_instructions` the character's *entire* persona — mannerisms, backstory
tone, everything — polluting the image-generation prompt with text that was never meant to describe
what the character looks like.

SillyTavern-Canonize's own people-curator prompt (`stacks/sillytavern/.../defaults-people.js`,
ported into `curatePeople.ts`) already draws this exact line: `## Appearance` is defined as
"physically inherent traits only... exclude clothing, accessories, current hairstyle, and
injuries," set once at creation and reproduced verbatim afterward — a frozen field, same posture
`characters` already applies to its other fixed-at-creation columns. This plan gives that section a
column of its own on `characters` and threads it through both description passes and into the
Portrait Studio bridge, without touching `persona`'s existing role (card-export `description`,
prompt-stack `description` slot) at all.

## Files

- `db/migrations/0110_character_appearance.sql` — new — adds `characters.appearance text not null
  default ''`, same shape as the existing `persona` column. Applied by hand, same convention as
  every other migration (see `db/migrations/README.md`).
- `orchestrator/src/orchestrator/personCuratorAppearance.ts` — new — the single source of the
  Appearance section-rule wording ("physically inherent traits only: body type, height, build, bone
  structure, facial features, natural hair colour and texture, permanent features such as scars or
  birthmarks. Exclude clothing, accessories, current hairstyle, and injuries... reproduce exactly
  once set"), exported as a plain string constant both `describeCharacter.ts` and `curatePeople.ts`
  interpolate into their own prompts. Prevents the two passes' built-in defaults drifting apart
  over time while leaving each pass's own Settings override (Principle 17) untouched and
  independent.
- `orchestrator/src/orchestrator/describeCharacter.ts` — modified — the describer asks for two
  outputs instead of one (`Appearance:` and `Persona:` markers, or a two-field forced tool call —
  Reasonix's call which shape fits this codebase's existing LLM-call conventions better), each
  written to its own column, each independently frozen-once-set.
- `orchestrator/src/io/chatMemory/curatePeople.ts` — modified — the `curate_people` tool's `content`
  parameter is joined by a new sibling `appearance` parameter per entry, pulled out of the six
  blended sections; `content` keeps the other five (Personality, Core Misread, Connections,
  Relationship with `{{user}}`, Goals) exactly as today.
- `orchestrator/src/orchestrator/chatMemorySync.ts` — modified — the `upsert_people` step
  (currently ~line 754-767) gains a per-entry `characters` row lookup and a conditional
  `appearance` write-back.
- `plugins/characters/src/createCharacterTool.ts` — modified — optional `appearance` param,
  same validation/storage shape as `persona`.
- `plugins/characters/src/updateCharacterTool.ts` — modified — optional `appearance` patch field.
- `plugins/characters/src/getCharacterTool.ts` — modified — `appearance` added to the detail
  response.
- `frontend/src/views/CharactersView.tsx` — modified — a second textarea for `appearance` near the
  existing persona field (~line 450), labeled to make clear it's the physical-only field Portrait
  Studio reads; `Draft`/`BLANK_DRAFT` and the save payload (~lines 32, 39, 180, 197) gain the field.
- `frontend/src/api/types.ts`, `frontend/src/api/client.ts` — modified — plumb `appearance` through
  the character create/update/detail request and response shapes.
- `orchestrator/src/server/portraitRoutes.ts` — modified — `handlePortraitEntityFromCharacter`
  (~lines 604-669) reads `appearance`, falling back to `persona` when `appearance` is blank, for
  both the seed and refresh branches; the 409 guard (~line 634-638) fires only when both are blank.

## Logic

### The frozen-per-field rule (both passes)

`characters.appearance` and `characters.persona` are each independently "never described" iff
empty, and each is filled at most once by an automated pass — the same explicit-outranks-inferred
posture (`bi_principles.md` §3) `describeCharacter.ts` already applies to `persona` today, just
applied per-column instead of per-row. A row with `persona` already set but `appearance` still
blank (every character today, immediately after this migration; also every imported or
manually-created character going forward, since import/manual creation never touches `appearance`
unless the operator fills it themselves) is still eligible for the appearance half of the pass —
it is not "already described" just because `persona` is non-empty.

### `describeCharacter.ts`

Skip rule changes from "row's `persona` is non-empty → skip the whole pass" to "check `persona` and
`appearance` independently; skip entirely only when both are already non-empty." The single LLM
call still fires once per character (no change to the `describeInFlight` guard or the fire-and-
forget trigger site), but its prompt now asks for both blurbs in that one call — an appearance
blurb governed by the shared physical-only section rule, and a persona blurb governed by
(essentially) today's existing instruction, now describing manner and non-physical character
rather than needing to also cover "a couple of concrete appearance details." On a successful reply,
write only the field(s) that were actually still empty going in — if `persona` was already set
(e.g. carried forward from a same-named prior row per A1) but `appearance` was not, write only
`appearance` and leave `persona` untouched, even though the model was asked for both.

Failure stays fail-open exactly as today: any failure — LLM error, empty reply, a reply missing
whichever marker(s) were actually needed — logs and returns, writing nothing.

### `curatePeople.ts`

The `curate_people` tool call gains a sibling `appearance` string parameter alongside the existing
`content` parameter, populated per the shared section rule. The prompt's own `## Appearance`
section-rule text is replaced with a reference to (interpolates) the shared constant from
`personCuratorAppearance.ts`, and the `content` field's instructions drop the Appearance section
(it moves to its own parameter) while keeping Personality/Core Misread/Connections/Relationship/
Goals exactly as today. `curatePeople()`'s return shape gains `appearance?: string` per entry.

### `chatMemorySync.ts` — writing appearance back onto `characters`

The existing `upsert_people` step inserts one `canon_facts` row per curator entry, unchanged. Add,
per entry with a non-empty `appearance`: look up a `characters` row scoped to `user_id` with
`name` matching `entry.name` case-insensitively (a simple exact match — see Edge Cases for the
mismatch case). If found and that row's `appearance` is currently empty, update it. This is the
`curatePeople`-side half of the same frozen-once-set rule `describeCharacter.ts` applies — a
character `describeCharacter.ts` already filled is left alone; one it never reached (its one-shot
call failed, or the character predates this plan) gets a second chance on the next sync tick. No
new settings, no new in-flight guard needed — the existing per-tick sync cadence is the natural
rate limit, and the write is a no-op idempotent check every tick either way.

### Portrait Studio bridge (`portraitRoutes.ts`)

`handlePortraitEntityFromCharacter` selects `character.appearance.trim() || character.persona.trim()`
as the text written to `standing_instructions`, on both the create and refresh branches. The 409
"nothing to seed from" response fires only when both are blank. This is the one place in the plan
where `persona` is read as a *fallback*, not a replacement — an imported card or a manually-created
character with a full persona but no separately-authored appearance still seeds Studio with
something useful today, exactly as it does now, rather than silently regressing to "declined" until
an operator or a describer pass fills the new column.

### Manual authoring (`createCharacterTool.ts` / `updateCharacterTool.ts` / `CharactersView.tsx`)

`appearance` becomes an ordinary optional field alongside `persona`/`scenario`/etc — same
validation shape (`v.appearance !== undefined && typeof v.appearance !== 'string'` fails), same
column, no automated pass involved. This is what lets a user-authored character (never scraped,
never synced) still populate the field Portrait Studio prefers.

## Contracts

- `characters` table: `appearance text not null default ''` (new column).
- `create_character` / `update_character` tool schemas: optional `appearance: string` parameter,
  same shape/validation as `persona`.
- `get_character` response: adds `appearance: string`.
- `curatePeople()` return type (`PeopleCuratorEntryDraft`): adds `appearance?: string`.
- `curate_people` tool definition: adds `appearance` (string, optional — required alongside
  `content` for `new`/`update` actions, per the same "governed by section rules above" framing the
  existing `content` field description uses).
- `POST /v1/portraits/entities/from-character`: response/behavior unchanged; only the source text
  selection changes (`appearance` preferred, `persona` fallback).

## Edge Cases

- **A character with `persona` set but `appearance` still blank** (every existing row, immediately
  post-migration) — `describeCharacter.ts` only fires on the next mint of a *new* row, so existing
  characters' `appearance` stays blank until: the periodic `curatePeople` sync reaches them (if
  RP-born and still active in a synced chat), or an operator fills it manually in
  `CharactersView.tsx`. Not a bug — there is deliberately no bulk-backfill pass in this plan (see
  Out of Scope); `portraitRoutes.ts`'s fallback-to-`persona` covers the gap in the meantime.
- **`curatePeople` entry name doesn't exactly match any `characters.name`** — e.g. the curator's
  strict two-word naming convention ("Queen Elara") diverges from whatever the scraper captured off
  the turn's `Present:` line for the `characters` row (e.g. "Elara"). The lookup is a plain exact
  case-insensitive match; on no match, skip the `characters` write-back entirely and proceed with
  the `canon_facts` insert exactly as today — this must never block or fail the sync tick. Fuzzy
  name reconciliation is out of scope (see Out of Scope).
- **Both `describeCharacter.ts` and a later `curatePeople` tick target the same never-described
  character's `appearance`** — no race: both check-then-write against the same "currently empty"
  condition, and whichever runs second sees a non-empty column and writes nothing. No new locking
  needed beyond the existing per-field emptiness check.
- **`describeCharacter.ts` reply has one marker but not the other** (e.g. a valid `Appearance:`
  block but no `Persona:` block) — write whichever field(s) parsed successfully; do not discard a
  good appearance blurb because the persona half of the same reply came back malformed, and vice
  versa. Log the missing half same as today's "no marker" warning.
- **Manually-set `appearance` on a character whose `persona` is still blank** — legal; the two
  fields are independent, and `portraitRoutes.ts`'s `appearance || persona` selection means Studio
  seeding works fine from `appearance` alone even with no `persona` at all.

## Tests

- `describeCharacter.ts`: a never-described character gets both `appearance` and `persona` filled
  from one LLM call; a character with `persona` already set but `appearance` blank gets only
  `appearance` filled and `persona` is byte-for-byte unchanged; a reply missing one marker still
  writes the other; a fully empty/failed reply leaves both columns untouched (fail-open, unchanged
  from today's test coverage shape).
- `curatePeople.ts`: the `curate_people` tool call's `appearance` parameter round-trips through
  `curatePeople()`'s return value distinctly from `content`; a 'duplicate' action entry has no
  `appearance` value (same as `content` today).
- `chatMemorySync.ts`: an `upsert_people` entry whose name exactly matches an existing, appearance-
  blank `characters` row writes `appearance` onto it; a name with no matching row leaves
  `characters` untouched and still inserts the `canon_facts` row; a matching row whose `appearance`
  is already non-empty is not overwritten.
- `createCharacterTool.ts` / `updateCharacterTool.ts` / `getCharacterTool.ts`: `appearance` accepted
  on create, patchable on update, returned on get — same shape as the existing `persona` coverage
  for each.
- `portraitRoutes.ts`: `handlePortraitEntityFromCharacter` seeds/refreshes from `appearance` when
  present; falls back to `persona` when `appearance` is blank; 409s only when both are blank.

## Out of Scope

- A bulk backfill pass that generates `appearance` for every existing character in one sweep — the
  fallback-to-`persona` read in `portraitRoutes.ts` and the natural reach of the next `curatePeople`
  sync tick are enough; a dedicated backfill job is a separate, purely operational follow-on if it
  turns out to be needed.
- Splitting `curatePeople`'s remaining five sections (Personality, Core Misread, Connections,
  Relationship with `{{user}}`, Goals) into their own structured tool-call fields — `content` stays
  one flat markdown blob for those, unchanged. Nothing downstream needs Personality or Goals in
  isolation the way Portrait Studio needs Appearance; splitting further is speculative scope this
  plan doesn't need.
- A `characters.personality` column, or any change to what `persona` means or how `cardCodec.ts`
  collapses V2/V3 card `description`/`personality` into it on import — `persona` keeps doing exactly
  what it does today for export and prompt assembly.
- Seeding `appearance` from an imported card's `description` field at import time
  (`insertCharacterFromCard.ts`) — a V2/V3 card's `description` is commonly more than physical
  traits (backstory, manner, voice), so treating it as an authoritative physical-only source would
  misuse the new column's contract. Imported characters get `appearance` the same way manually-
  created ones do: an operator fills it in `CharactersView.tsx`, or it stays blank and
  `portraitRoutes.ts` falls back to `persona`.
- Fuzzy/alias-aware name matching between `curatePeople` entries and `characters` rows — the exact
  case-insensitive match is deliberately simple; a mismatch just means that tick's appearance
  write-back is skipped, not that anything breaks.
- Any change to `visual_entities`, the layer manifest, or Studio's own tuning loop
  (`portraitFeedback.ts`) — this plan only changes what text `standing_instructions` gets seeded
  with, not anything about how Studio uses it afterward.

## Principles / Conventions in Play

- **`bi_principles.md` §3 (Explicit user signal outranks inferred)** — the frozen-once-set rule,
  now applied per-field on `characters` instead of per-row: a manually-authored or previously-
  described field is never silently overwritten by a later automated pass.
- **`bi_principles.md` §17 (Every prompt is surfaced for manual tuning)** — `character_describer_
  prompt` and `chat_memory_people_curator_prompt` remain the two independent, full-text Settings
  overrides they are today; the shared `personCuratorAppearance.ts` constant only keeps the two
  *built-in defaults* textually consistent, it does not introduce a third override surface or a
  sub-prompt composition an operator would need to reason about.
- **`bi_principles.md` §1 (The relational store is the canonical record)** — `appearance` joins
  `persona`/`scenario`/etc as another fixed-at-creation column on the canonical `characters` row,
  not a derived cache; Portrait Studio's `standing_instructions` copy of it remains explicitly
  derived working state, refreshed on demand exactly as `persona`'s copy already is.
