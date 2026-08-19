# Per-layer `details` field for Portrait Studio entities

## Context

Right now every layer entity (Subject/Outfit/Style/Expression/Format) has only `name` and `slots`
(structured, LLM-invented attribute values). There is no persisted free-text description at all —
one existed (`visual_entities.standing_instructions`) but migration 0114 dropped it because it
never fed the compiled image prompt (`composer.ts` only ever reads `slots`) and duplicated the
wiki's role. The closest thing today is `seed`: optional free text typed at entity-create time,
used only to bootstrap `slots` via an LLM call, then explicitly thrown away
(`portraitRoutes.ts`: "Neither `seed` nor the intermediate blurb is ever persisted").

The user wants to reintroduce authored, persisted, per-layer prose — but this time it actually
composes into the prompt, and each layer's meaning is distinct so a value never bleeds across
layers ("'Displeased' belongs in Expression details; 'Asian woman' belongs in Subject details").
Target editable model per entity: **Name** (library label), **Details** (layer-specific authored
prose, human-owned), **Slots** (layer-specific structured attributes, LLM-owned), **Tags**
(deferred — see below). Target template:

```
A portrait of {{subject_details}}, {{subject_overflow}},
wearing {{outfit_details}}, {{outfit_overflow}},
rendered in {{style_details}}, {{style_overflow}},
with {{expression_details}}, {{expression_overflow}}.
Format: {{format_details}}, {{format_overflow}}.
```

UI field labels must be layer-specific ("Subject details", "Expression details", ...), never
generic "Description".

**Confirmed by direct inspection, not assumed:**
- Live DB `visual_entities` has no `details` column today (11 rows, lossless to backfill `''`).
- The live `orchestrator_settings.visual_layer_stack` template has **already drifted** from
  `DEFAULT_LAYER_MANIFEST.template` in code — stored value is `"A portrait of: {{subject_overflow}}..."`
  (note the colon) vs. code's `"A portrait of {{subject_overflow}}..."` (no colon). This is real,
  already-hand-edited operator state, not hypothetical — decisive for the migration decision below.
- `compileTemplate` has exactly two call sites in the whole orchestrator (`portraitGeneration.ts:608`
  and `:821`).
- `retryPortraitCandidateRender` (the `:821` path) currently has **zero test coverage** — a
  pre-existing gap this plan closes rather than just preserves.
- `portraitRoutes.ts` (1246 lines), `PortraitStudioView.tsx` (767), `portraitGeneration.ts` (875),
  and `frontend/src/api/types.ts` (1638) are all already well over the 300-line budget
  (bi_principles.md §10). Pre-existing debt — this plan adds inline, does not attempt a split.

## 1. Migration `db/migrations/0122_visual_entities_details.sql`

```sql
alter table visual_entities add column details text not null default '';
```

With a comment block (matching 0105/0114 house style) explaining this is the reintroduction of
authored prose 0114 removed, but landing *together* with the `compileTemplate` change that makes
it actually read into the prompt — applying 0122 without the composer.ts change would repeat
exactly the defect 0114 fixed.

**The migration does NOT touch `orchestrator_settings.visual_layer_stack`.** That value is
Principle-13 runtime config, seeded once on first read and hand-editable afterward via Manage
Layers — the live value has already diverged from the code default, proving it's genuinely
operator-owned. A schema migration writing into a settings row is a category error (schema
migrations own columns, not runtime config), and "only touch it if it still matches the old
default" is a brittle detection (a whitespace-preserving re-save already changes the string).
Instead: ship the new `DEFAULT_LAYER_MANIFEST.template` purely as the code default for fresh
installs; for this already-provisioned household, the migration's comment header documents the
one-line operator step — add the five `_details` tokens to the stored template via Manage Layers
— and the feature degrades gracefully either way: `details` is persisted/editable from day one,
it just doesn't reach the compiled prompt until the template references it.

## 2. `orchestrator/src/portraits/composer.ts` — `compileTemplate`

Add a 4th, defaulted parameter rather than changing the required signature (keeps every existing
caller and test fixture compiling unchanged):

```ts
export type DetailsMap = Record<string, string>; // { [layerId]: authored prose }

export function compileTemplate(
  template: string,
  slots: SlotMap,
  layers: LayerDefinition[],
  details: DetailsMap = {},
): string
```

Parallel treatment to the existing `_overflow` reserved-token family:
- `collectPlacedSlots`: `_details` tokens place nothing into a layer's slot map (same as
  `_overflow`) — extend the reserved-suffix check to cover both suffixes.
- `compileTemplate`'s replace body: add a `token.endsWith('_details')` branch resolving
  `details[layerId]?.trim() ?? ''` for a known promptable layer, left verbatim for an unknown one
  (same diagnosable-not-dropped convention as unknown slot tokens). Empty/absent → `''`, then the
  existing `collapse()` removes the resulting ragged comma exactly as it already does for an empty
  overflow bucket.
- Update the file's preamble (`@description`, rule list, `@api-declaration`) and bump `@stamp`.
  Stays pure — `details` is just another plain input.

## 3. `orchestrator/src/portraits/layerStack.ts` — `DEFAULT_LAYER_MANIFEST.template`

Replace with the user's exact target string (commas at the wrap points as specified). Update the
preamble paragraph that currently says the template references "each layer's overflow token" to
also mention `_details` tokens. Bump `@stamp`. No other change — `parseLayerManifest` only checks
`template` is a string; layer `boundary` prose is a separate, not-requested concern.

## 4. `orchestrator/src/orchestrator/portraitGeneration.ts` — both call sites

Extend the local `EntityRow` interface with `details: string`, and every `select ... from
visual_entities` projecting that shape (named-entity lookup, most-recently-used lookup,
placeholder-insert `returning`) to include `details`.

**Main path (line ~608):** add a helper next to `buildParentChromosome`:
```ts
function buildParentDetails(entities: Map<string, EntityRow>, layers: LayerDefinition[]): DetailsMap {
  const details: DetailsMap = {};
  for (const layer of layers) {
    const entity = entities.get(layer.id);
    if (entity?.details) details[layer.id] = entity.details;
  }
  return details;
}
```
Compute once per round (details doesn't vary per-candidate, same as `name` — not part of the
evoprompt mutation loop), alongside the existing `buildParentChromosome` call. Thread into the
compile call: `compileTemplate(template, chromosome.slots, manifest.layers, parentDetails)`.

**Retry path (line ~821):** only has `row.entity_ids` (`{layerId: entityId}` from the stored
candidate), not the live `entities` Map. Add one batched query right after the existing
style-template lookup:
```ts
const entityIdList = Object.values(row.entity_ids ?? {}).filter((id): id is string => typeof id === 'string');
let detailsByLayer: DetailsMap = {};
if (entityIdList.length > 0) {
  const detailRows = await deps.db.withUserScope(userId, (session) =>
    session.query<{ layer_id: string; details: string }>(
      `select layer_id, details from visual_entities where entity_id = any($1::uuid[]) and user_id = $2`,
      [entityIdList, userId],
    ),
  );
  for (const r of detailRows) if (r.details) detailsByLayer[r.layer_id] = r.details;
}
```
Thread into that call site's `compileTemplate(...)` too. Import `type { DetailsMap }` alongside the
existing `compileTemplate, type SlotMap` import. Update the retry function's doc comment (it
already promises a retry recompiles "against the current manifest/style template" — extend that
same current-state guarantee to `details`).

## 5. `orchestrator/src/server/portraitRoutes.ts`

**Keep `seed` and `details` as two separate fields — do not rename `seed` → `details`.** `seed` is
ephemeral LLM-bootstrap-trigger context (Principle 3: explicit outranks inferred — only consulted
when `slots` is omitted); `details` is persisted, human-owned prose edited later like `name`.
Collapsing them would mean editing `details` afterward could accidentally re-trigger bootstrap
semantics, and removes the ability to bootstrap from one phrase while keeping different polished
prose. Resolution: `details` also serves as bootstrap `context` when `seed` isn't separately
given and `slots` is empty — change `let context = parsed.seed ?? '';` to
`let context = parsed.seed ?? parsed.details ?? '';`. In practice, since the frontend collapses
the create-time UI to one box that sends `details` (not `seed`), this is what a normal create
flow uses; `seed` stays available for any caller wanting bootstrap context distinct from the
persisted prose.

Changes, all additive (append `details` after `template` in every column list — keeps existing
`startsWith`/prefix-matching test fixtures working unmodified):
- `CreateEntityBody`/`parseCreateEntityBody`: add `details: string` (parsed like `name` but not
  required-non-empty, trimmed), update doc comment for the seed-vs-details relationship above.
- Create-insert SQL + every `returning`/`select` clause projecting the entity shape (`getEntity`,
  the plain-create handler, the from-cast-character handler, the CRUD list): add `details`.
- `UpdateEntityBody`/`parseUpdateEntityBody`: add `details?: string` (present-and-string = update,
  undefined = leave alone — same shape as `name`, no null-clears convention needed for prose).
  Wire into the PATCH handler alongside the existing `name`/`slots`/`template` field pushes.
- `handlePortraitEntityFromCastCharacter`: also persist `details` from the same `seedText`
  (`character.appearance || persona`) already used to bootstrap slots there (confirmed — see
  Resolved decisions below).

No file split attempted (pre-existing ~4x budget overage, additive diff only, ~+30 lines).

## 6. Frontend — `PortraitStudioView.tsx`, `frontend/src/api/types.ts`

**`api/types.ts`:** add `details: string` to `PortraitEntityRow`, `details?: string` to
`CreatePortraitEntityInput` and `UpdatePortraitEntityInput` (alongside the existing `seed?`).
Update `PortraitEntityRow`'s doc comment (currently claims no persisted free-text field exists —
now false).

**`PortraitStudioView.tsx`:**
- Rename `CreateDraft.description` → `details` (internal state only, not a wire-format concern).
- Give the create-time textarea (currently placeholder-only, no real `<label>` — a usability gap
  since placeholder text vanishes once typing starts) an actual `<label>` reading
  `` `${layer.label} details` `` — this is the literal, durable way to satisfy "the field label
  should be specific to the layer... not merely 'Description'"; a placeholder alone doesn't. Wire
  its value/onChange to `createDraft.details`, send `details:` (not `seed:`) in the POST body.
- Add a post-creation Details editor, mirroring the existing rename-in-place pattern
  (`renamingEntityId`/`renameDraft`/`renameSaving` → `editingDetailsEntityId`/`detailsDraft`/
  `detailsSaving`), calling `updatePortraitEntity(entity.entity_id, { details }, apiKey)`. Render
  it always-visible (compact `rows={2}` textarea, labeled per-layer) rather than behind another
  expand/collapse toggle — Details is meant to be primary authored content, not a secondary
  advanced field like the read-only Slots dump next to it.
- Update the component's top doc comment, which currently states slots are shown read-only
  "instead of an editor" (citing 0114) — rewrite to describe the new three-way split: Details
  (editable prose) / Slots (read-only, LLM-owned) / Wiki (durable cross-round guidance).

**Tags:** no schema, route, or UI precedent exists today, and the user's stated complaint was
specifically about Details/Slots conflation, not a filtering/organization need. Treating this as
explicitly out of scope for this change — flagged back for a separate decision, not silently
dropped or silently included.

No file split attempted (pre-existing ~2.5x/5.5x budget overage; additive diff only).

## 7. Tests

- **`verify-visual-composer.mjs`** (pure, no fake DB): add cases mirroring the existing
  overflow-token tests — a placed `_details` token substitutes trimmed; empty/absent → vanishes
  with comma-collapse; unknown layer's `_details` left verbatim; a call omitting the 4th arg
  behaves identically to `details: {}` (proves the back-compat default isn't just asserted);
  purity re-check including `details`; one assertion compiling the *new* `DEFAULT_LAYER_MANIFEST`
  template directly (catches future edits to that literal).
- **`verify-visual-portrait-bridge.mjs`** (entity CRUD via fake pool): the `insert into
  visual_entities` handler disambiguates create-vs-from-cast-character by `params.length` — both
  arms' expected arity must be updated together when `details` is appended (and again if the
  from-cast-character extension in §5 is adopted), with a comment noting the two shapes' exact
  arities so this doesn't silently break on a future field addition. Add `details: ''` to fixture
  row helpers. New assertions: POST persists/round-trips `details` on GET; PATCH `{ details }`
  updates in place without touching `slots`/`name`; POST with only `details` (no `seed`) still
  fires the bootstrap pipeline with `details` as context (reuse the existing gate fixture).
- **`verify-portrait-telemetry.mjs`** (round composition via fake pool): add `details: ''` to
  entity fixture rows (existing `.includes(...)`-based SQL matching is robust to the appended
  column as-is). New end-to-end assertion: seed one entity per layer with a distinct `details`
  value, run `runPortraitGenerationRound` with a template containing `_details` tokens (pass it
  via the fake settings seed rather than relying on any deployment's stored template), assert the
  candidate's `composedPrompt` contains each layer's details text in the right position — this is
  what actually proves `buildParentDetails` + the threaded call work, not just that
  `compileTemplate` is correct in isolation.
- **New retry-path coverage** (currently zero): add a case — either a new small script or a
  section in `verify-portrait-telemetry.mjs` (which already has the needed fake-pool machinery) —
  covering `retryPortraitCandidateRender` re-querying `details` across all of a candidate's
  `entity_ids` (not just style) and reflecting a `details` edit made *after* the original render,
  matching the function's existing "recompiles against current state" doc-comment promise.

Every one of these fake pools already throws on any unrecognized SQL string — a cheap safety net
that surfaces any missed query-shape update immediately when the suite runs.

## Verification

1. `cd orchestrator && npx tsc --noEmit -p .` and `cd frontend && npx tsc --noEmit` — both clean.
2. `cd orchestrator && npm run verify` — full suite, zero FAIL lines, paying particular attention
   to the three files listed in §7.
3. Apply `0122_visual_entities_details.sql` to the live DB the same way as every prior migration
   this session (`docker exec -i bigimagine-postgres psql -U bigimagine_admin -d bigimagine < ...`),
   confirm the column exists via `\d visual_entities`.
4. Manual smoke check against the live container: create an entity with Details text, confirm it
   round-trips on GET and is editable via PATCH; separately, hand-edit this household's stored
   `visual_layer_stack` template via Manage Layers to include the new `_details` tokens and
   generate a round, confirming the composed prompt actually includes the authored text (this step
   is the one place this feature only takes effect after an explicit operator action, per §1).

## Resolved decisions

- `handlePortraitEntityFromCastCharacter` **does** also persist `details` from the character's
  appearance/persona seed text (§5) — the same text already used to bootstrap slots there,
  consistent with the rest of the feature.
- Tags (§6) is confirmed **out of scope** for this change — a separate follow-up decision, not
  bundled into this migration/PR.
