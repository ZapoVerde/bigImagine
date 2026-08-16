# Portrait Studio — generative character portraits with a self-improving wiki

## Goal

Give BigImagine a native, trainable system for generating character portraits with expressions: an
operator generates multiple AI candidates for a character (identity × outfit × style × expression),
picks a winner, rates the rest, and a Reflection pass distills what worked into a growing, tagged
knowledge base that makes every future generation — for that character or any other — start smarter.
This is the foundation phase only: the entity/composition/training engine and its own "Portrait
Studio" surface. It does not touch live chat rendering, VN mode, or the existing location/background
generator.

## Background

BigImagine currently renders one thing generatively — location backgrounds
(`orchestrator/src/orchestrator/generateLocationImage.ts`) — via a single fixed template + a style
prefix baked onto whichever `image_connections` row is active. Characters have only a static,
imported avatar (`plugins/characters/src/avatarStorage.ts`); nothing generates or varies.

A separate proof-of-concept project, `playground/` (its own docker stack, flat-file JSON storage, not
touched by this plan), validated an approach worth adopting: split a generated image into independent,
named layers (Subject, Outfit, Style, Expression), compose them through a shared `{{slot}}` template,
generate multiple candidates per round via an LLM acting as a mutation operator, have a human pick a
winner and rate the rest, then run a second LLM pass ("Reflection") that distills *why* the winner
won into durable, reusable knowledge. That knowledge is the actual asset: it's what lets training on
outfit #15 make outfit #16 better on its first try instead of starting cold.

Playground itself went through two rounds of hard-won generalization worth carrying over wholesale
rather than reinventing later:

1. **Layers became fully data-driven** (playground `docs/spec.md` §22) — not four hardcoded
   tables, but one manifest (`{layers: [{id, label, promptable, boundary}], template}`) and one
   generic entity store keyed by `layerId`. Adding a fifth layer is a manifest edit, not a migration.
2. **The knowledge store became a tagged, subscription-based wiki** (§23), replacing an earlier
   fixed-topic rule system entirely. A lesson is a standalone entry (`title`, `body`, open-vocabulary
   `tags`, and `subscriptions` naming which layer-type/entity it applies to). Subscribing an entry at
   the whole-layer-type level (no specific entity) *is* how it reaches every sibling entity
   automatically — cross-entity transfer isn't a separate search, it's a property of the entry itself.
   Reflection also became a real multi-turn tool-calling investigation (the model sees a title+tag
   index across the whole layer stack, can pull full entry bodies, then amends or creates), not a
   single-shot proposal.

This plan ports that *design* into BigImagine as real, principles-compliant code — not playground's
code, which is deliberately exempt from `bi_principles.md` §8/9/10 (it's a sandbox). Playground is
untouched by this plan.

**Why the layer/entity/wiki system isn't portrait-specific in this design:** the "wrapper" that turns
raw subject content into a provider-ready prompt (`orchestrator/src/util/synthesizeImagePrompt.ts` +
the active connection's style prefix, for locations today) is structurally the same thing a Style
layer entity does — turn subject content into a styled prompt via a template. Locations and
portraits could eventually share Style, and any wiki knowledge subscribed to it, through the exact
same composer. **That unification is deliberately not done in this plan.** The existing location
pipeline works and is live; this plan builds the new system, proves it out entirely through Portrait
Studio, and leaves `generateLocationImage.ts` byte-for-byte untouched. Migrating locations onto the
proven system — and deleting the old style-prefix plumbing once that migration lands — is explicit,
separate future work, not started here. `Subject`/`Outfit`/`Expression` stay portrait-only regardless
of that future migration: a location's visual description is auto-generated per-scene and never
reused, so it has no analog to a curated, iteratively-trained Subject.

## Files

**New:**
- `db/migrations/0105_visual_studio.sql` — all new tables + `image_connections.purpose` +
  `orchestrator_settings` key widening (see Contracts).
- `orchestrator/src/portraits/layerStack.ts` — IO Wrapper: read/seed/parse the layer manifest from
  `orchestrator_settings`; Pure Function helpers over an already-loaded manifest
  (`getPromptableLayers`, `formatLayerDefinitions`).
- `orchestrator/src/portraits/composer.ts` — Pure Function: `{{slot}}` template compilation +
  overflow-bucket logic, generalized over however many promptable layers the active manifest
  declares.
- `orchestrator/src/portraits/reconcile.ts` — Pure Function: enforce slot-key fidelity between a
  mutated candidate and its parent, per layer.
- `orchestrator/src/portraits/evoprompt.ts` — Pure Function: build the mutation prompt/tool schema;
  parse the model's candidate response.
- `orchestrator/src/portraits/wiki.ts` — Pure Function: format Path-1 subscribed-entry injection;
  build the Path-2 title+tag index grouped by layer type.
- `orchestrator/src/orchestrator/portraitGeneration.ts` — Orchestrator: runs one generation round
  (mirrors `generateLocationImage.ts`'s shape/header conventions).
- `orchestrator/src/orchestrator/portraitFeedback.ts` — Orchestrator: records human feedback, runs
  the Reflection Investigation loop.
- `orchestrator/src/server/portraitRoutes.ts` — admin-style HTTP routes (same posture as
  `adminServer.ts`) for entity CRUD, layer-stack management, generate/feedback, wiki browse/edit.
  **Auth note (decided at implementation):** the `visual_*` tables are *user-scoped* RLS
  (`user_id` column + `user_scoped` policy, migration 0105), and the admin key resolves no user
  id — so every surface that reads/writes those tables (entity CRUD, wiki browse/edit,
  generate/feedback, and the layers GET) is user-gated (`withUser`; the caller's `userId` IS the
  row scope). Only the layers **write** is admin-gated (`withAdmin`): `visual_layer_stack` is an
  `orchestrator_settings` write, and every settings write on this server is admin-gated. The
  Manage Layers panel therefore prompts for the admin key exactly like Connections-tab writes do.
- `frontend/src/views/PortraitStudioView.tsx` + `.css` — new top-level specialist view/tab.
- `frontend/src/components/portraitStudio/PortraitCandidateGrid.tsx` + `.css` — new multi-candidate
  picker (no existing component to extend; swipes are sequential, not a grid).
- `orchestrator/scripts/verify-visual-composer.mjs`, `verify-visual-reconcile.mjs`,
  `verify-visual-evoprompt.mjs`, `verify-visual-wiki.mjs` — new verify scripts, same convention as
  the rest of `orchestrator/scripts/`.

**Modified:**
- `orchestrator/src/io/imageConnections.ts` — add `purpose` to every shape/method (see Contracts);
  `resolveActive` takes an optional `purpose` param defaulting to `'background'` so every existing
  call site (`generateLocationImage.ts`) is behaviorally unchanged.
- `frontend/src/views/ConnectionsView.tsx`, `frontend/src/components/connections/
  ImageConnectionEditor.tsx` — add a purpose selector so an operator can create a `portrait`-purpose
  connection.
- `frontend/src/hooks/useTabs.ts` — add a `'portraits'` `TabType`.
- `frontend/src/api/client.ts`, `frontend/src/api/types.ts` — new portrait-prefixed functions/types.
- `orchestrator/src/orchestrator/pluginLoader.ts` and `plugins/*` — **not modified**; this phase has
  no LLM tool call, everything is operator-driven Studio routes (see Out of Scope).
- `package.json` (workspace `verify` script) — wire in the four new verify scripts.

## Logic

### Layer manifest

One global manifest, stored as a single JSON value under `orchestrator_settings.visual_layer_stack`
(Principle 13 — runtime config, not env/const; editable without a redeploy). Shape:
`{ layers: [{ id, label, promptable, boundary }], template }`. `layerStack.ts` seeds a default on
first read if the key is unset — four layers (`subject`, `outfit`, `style`, `expression`, all
`promptable: true`, each `boundary` a short prose description of what belongs there and what
explicitly doesn't) plus a default `template` referencing each layer's overflow token. An operator
can add/remove/relabel layers afterward from Portrait Studio's "Manage Layers" panel — this is what
makes the system genuinely data-driven rather than hardcoded to four names; every consumer below
reads the layer list from the manifest, never a literal `['subject','outfit','style','expression']`
constant.

Two layers are disclosed, deliberate exceptions to full genericity, matching playground's own
precedent:
- **`subject` is the run's anchor.** Task-id attribution (`visual-<subjectEntityId>-<attempt>`) and
  episode logging key off whichever entity fills the `subject` layer. The manifest must always
  contain a `subject` layer; the Manage Layers UI never offers to remove it.
- **`engine_params` is not a layer in this manifest at all** — render settings live on
  `image_connections` (extended below), exactly as they do for locations today. Never prompt-facing,
  never part of a candidate's chromosome.

### Entities

One generic table (`visual_entities`, see Contracts) instead of one table per layer. Every entity —
a character's Subject, a named Outfit, a Style, an Expression — is a row distinguished by `layer_id`.
`character_id` is set for character-scoped entities (Subject always; Outfit optionally, when it's a
character-specific wardrobe item rather than a shared one) and null for global entities (Style,
Expression, and any shared Outfit). A Subject entity is created from an existing `characters` row (one
Subject per character) — Portrait Studio's entry point is "calibrate this character's portrait,"
not a standalone concept decoupled from the character roster.

### Composition

`composer.ts`'s `compileTemplate` takes the active manifest's `template` string and a map of
`{layerId: {slots}}`, substitutes every `{{slot_name}}` token it finds against whichever layer owns
that slot name, and folds anything not explicitly placed into that layer's `{{<layerId>_overflow}}`
bucket (auto-formatted `"label: value, ..."`), stripping unused tokens and collapsing comma runs
afterward. Direct generalization of playground's `composer.js`, parameterized over the active layer
list instead of a fixed three/four.

### Generation round (`portraitGeneration.ts`)

`runPortraitGenerationRound(deps, userId, { entityIds, goal, pendingFeedback? })`:
1. Load the active manifest, resolve every named entity in `entityIds` (one per promptable layer;
   an unspecified layer falls back to that layer's most-recently-used or a fresh placeholder entity,
   mirroring playground's seed-on-first-use behavior).
2. Load Path-1 wiki entries: every `visual_wiki_entries` row whose `subscriptions` includes any of
   the active entity ids, or the active layer types at the whole-layer-type level (no
   `layerEntityId`) — full body, uncapped, same flat-inclusion posture playground's §23.4 settled on.
3. Build the mutation prompt (`evoprompt.ts`) — goal, `pendingFeedback`, every entity's
   `standing_instructions` (all layers, always, not narrowed by focus — matches §8.7/§13.3's
   settled reasoning that a soft "concentrate here" hint beats a hard per-layer wall), the Path-1
   wiki entries, and `formatLayerDefinitions()`'s boundary prose for every layer. Forces a tool call
   returning `visual_mutation_candidate_count` (setting, default 3) candidate chromosomes, one
   `{slots: {layerId: {...}}, negative_prompt?}` each.
4. Call the LLM through the existing gate, wrapped in `runWithCallContext({ taskId:
   'visual-<subjectEntityId>-<attempt>', kind: 'system', userId }, ...)` — no new LLM-calling
   machinery, same seam `generateChatTitle.ts` uses.
5. `reconcile.ts`'s `enforceSlotKeys` drops any hallucinated slot key and backfills any omitted one
   from the parent candidate, per layer, unconditionally.
6. Resolve the active `purpose = 'portrait'` `image_connections` row; dispatch each candidate's
   composed prompt to it in parallel via the existing `createImageGenProvider(...).generate()`
   (`orchestrator/src/io/imageGen/index.ts` — reused as-is). A single candidate's provider failure is
   logged and that candidate is simply missing from the grid; it never aborts the round
   (`bi_principles.md` §11).
7. Write one `visual_candidates` row per candidate, return them.

### Human evaluation and episode logging (`portraitFeedback.ts`)

`submitPortraitFeedback(deps, userId, { entityIds, goal, candidateIds, winnerId, ratings, rationale })`:
writes a `visual_episodes` row, updates the winning candidate's entities' `last_image_url` and
`current_best_candidate_id`, then runs the Reflection Investigation loop.

### Reflection Investigation (the wiki-writing pass)

A genuinely new loop for BigImagine — multi-turn tool-calling, not a single request/response — but
reusing the same underlying tool-call-capable LLM provider the main chat orchestrator already calls
on every turn; only the loop *around* it (build index → let the model pull → let it conclude) is new:
1. Build a title+tags index of every `visual_wiki_entries` row, grouped by the layer type each of
   its subscriptions names — across the *whole* active manifest, not just the layers this round
   touched (mirrors §23.5's reasoning: reflection already sees every entity's full record, so scoping
   its wiki visibility narrower than that is the actual inconsistency).
2. Call the gated LLM (`taskId: 'visual-<subjectEntityId>-reflection'`) with that index, the winning
   and losing candidates' composed prompts/slot values, and the human's rationale + per-candidate
   ratings/notes. It has two tools available: `pull_wiki_entry(id)` (returns full title+body) and
   `submit_conclusion({ action: 'create' | 'amend', id?, title, body, tags[], layerId, entityId? })`.
3. Loop: call → if the model calls `pull_wiki_entry`, feed the result back and call again; if it
   calls `submit_conclusion`, stop. Capped at `visual_wiki_investigation_max_turns` (setting, default
   6) — a resource ceiling, not a judgment threshold. On reaching the cap without a conclusion, one
   final call is made with the tool choice forced to `submit_conclusion` only, so a round never
   silently drops its lesson.
4. On `create`: insert a new `visual_wiki_entries` row, `subscriptions = [{layerType: layerId,
   layerEntityId: entityId ?? null}]` — entity-specific if the model named one, whole-layer-type
   (generalized) if it didn't. On `amend`: look up the entry by `id`; if it doesn't exist, fall back
   to `create` and log the mismatch (fail-open, never silently discarded) — same posture playground's
   §14.2 already established for a non-matching target.

### Image connection purpose split

`image_connections` gains `purpose` (`'background' | 'portrait'`, default `'background'`).
`resolveActive(purpose = 'background')` — every existing caller (`generateLocationImage.ts`) is
unmodified source and unmodified behavior; only the new portrait path calls
`resolveActive('portrait')`. The one-active-row constraint becomes scoped to `(purpose)` instead of
global, so a background connection and a portrait connection can both be active simultaneously. This
lets an operator point portraits at a Z-Image-Turbo-capable provider independent of whatever
background rendering uses.

### Frontend: Portrait Studio

New top-level tab (`useTabs.ts`), same tier as Settings/Connections — not a panel inside `ChatView`.
Layout: entity pickers (subject/outfit/style/expression dropdowns + create-new, following
`ConnectionsView.tsx`'s select pattern) drive a "Generate" action; `PortraitCandidateGrid.tsx` shows
the round's candidates with a winner-pick action and a per-candidate 1-5 star + note field
(collapsible, matching `SettingsView.tsx`'s fieldset convention); a Wiki panel lists/edits/deletes
entries (same fieldset/textarea/Save convention) and surfaces an "Applied" banner after a round's
Reflection pass creates or amends one, distinguishing the two actions. `standing_instructions` editing
per entity reuses the same textarea+Save pattern. Mobile-first (Principle 18): the candidate grid and
entity pickers stack to a single column at the existing `@media (max-width: 768px)` breakpoint.

## Contracts

All new tables follow `characters`' RLS shape (`db/migrations/0044_characters.sql`): `user_id`
references `users`, `enable row level security`, `force row level security`, a `user_scoped` policy,
grants to `bigbrain_app`.

```
visual_entities
  entity_id uuid pk default gen_random_uuid()
  user_id uuid not null references users(user_id)
  layer_id text not null            -- validated against the active manifest at write time, app-level
  character_id uuid null references characters(character_id)
  name text not null
  slots jsonb not null default '{}'::jsonb
  standing_instructions text not null default ''
  template text null                -- only meaningful for style-layer entities
  last_image_url text null
  current_best_candidate_id uuid null   -- soft pointer, no FK (mirrors last_image_url's own looseness)
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()

visual_candidates
  candidate_id uuid pk default gen_random_uuid()
  user_id uuid not null references users(user_id)
  entity_ids jsonb not null         -- { [layerId]: entityId }
  generation int not null default 0
  chromosome jsonb not null         -- { slots: { [layerId]: { [slotName]: value } }, negative_prompt?: string }
  image_url text null
  rating smallint null check (rating between 1 and 5)
  note text null
  created_at timestamptz not null default now()

visual_episodes
  episode_id uuid pk default gen_random_uuid()
  user_id uuid not null references users(user_id)
  entity_ids jsonb not null
  goal text not null
  rationale text null
  selected_candidate_id uuid null references visual_candidates(candidate_id)
  candidate_ids uuid[] not null
  created_at timestamptz not null default now()

visual_wiki_entries
  entry_id uuid pk default gen_random_uuid()
  user_id uuid not null references users(user_id)
  title text not null
  body text not null
  tags text[] not null default '{}'
  subscriptions jsonb not null      -- [{ layerType: text, layerEntityId: uuid | null }]
  origin_episode_id uuid null references visual_episodes(episode_id)
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
```

`image_connections`: add `purpose text not null default 'background' check (purpose in
('background','portrait'))`; rebuild the existing single-row `is_active` partial unique index scoped
to `(purpose) where is_active` instead of global.

`orchestrator_settings_key_check`: widen (same wholesale-rebuild pattern migration `0100` used) to add
`visual_layer_stack`, `visual_mutation_candidate_count`, `visual_wiki_investigation_max_turns`,
`visual_mutation_system_prompt_override`, `visual_reflection_system_prompt_override`.

`imageConnections.ts`: `ImageConnectionRow`/`ImageConnectionProfile` gain `purpose:
'background' | 'portrait'`; `create()`/`update()` accept it; `resolveActive(purpose?: 'background' |
'portrait')` defaults to `'background'`; `activate(id)` flips `is_active` only among rows sharing that
row's `purpose`.

## Edge Cases

- No `visual_layer_stack` set yet → seeded with the default four-layer manifest on first read, not
  an error.
- Mutation response has fewer/more candidates than requested, or a chromosome missing a promptable
  layer entirely → reconcile backfills from the parent; never throws.
- A candidate's image-gen provider call fails → logged, candidate omitted from the grid, round
  continues with whatever succeeded.
- Reflection Investigation hits `visual_wiki_investigation_max_turns` without a conclusion → forced
  final call with `submit_conclusion` as the only available tool.
- `submit_conclusion` names `action: 'amend'` with an `id` that doesn't match any existing entry →
  falls back to `create`, logged.
- Manage Layers UI never offers to remove the `subject` layer, or a layer that still has entities
  attached to it (no cascading-delete story in this phase).
- Concurrent rounds updating the same entity's `last_image_url`/`current_best_candidate_id` → last
  write wins; same posture as `generateLocationImage.ts` already takes for non-critical convenience
  fields.
- `image_connections` migration must leave every existing row's behavior identical: default
  `purpose = 'background'`, and `generateLocationImage.ts`'s unchanged `resolveActive()` call
  continues to resolve the same row it does today.

## Tests

- `verify-visual-composer.mjs` — template substitution + overflow buckets against a layer list of
  varying length (2, 4, 6 layers), confirming no hardcoded assumption about which/how many layers
  exist.
- `verify-visual-reconcile.mjs` — a hallucinated slot key is dropped, an omitted one is backfilled
  from the parent, across an arbitrary layer set.
- `verify-visual-evoprompt.mjs` — mutation prompt construction and response parsing round-trip
  against a fake layer stack and a fake tool-call response.
- `verify-visual-wiki.mjs` — Path 1 (subscribed entries only, full body, uncapped, whole-layer-type
  entries reaching every entity of that type) and Path 2 (index contains title+tags only, grouped by
  layer type, across the whole manifest) formatting; the investigation loop's turn-cap forcing
  behavior with a fake gate that never calls `submit_conclusion` on its own.
- Extend or add an `imageConnections` verify script: purpose-scoped active-row uniqueness (activating
  a `portrait` row doesn't deactivate the active `background` row and vice versa); `resolveActive()`
  with no `purpose` argument resolves the same row it would have pre-migration.
- Apply `0105_visual_studio.sql` by hand against the live DB (this repo's standing process — see
  `0044_characters.sql`'s header for the exact `docker exec ... psql` invocation), confirm RLS with a
  cross-user query returns nothing, confirm `generateLocationImage.ts`'s existing background render
  path is unaffected (same image, same connection resolved).
- Manual end-to-end in Portrait Studio: create a Subject for a real character, a Style, an
  Expression; add a `portrait`-purpose image connection; run a generation round; confirm candidates
  render and land in `visual_candidates`; pick a winner, rate the rest; confirm a `visual_episodes`
  row and at least one `visual_wiki_entries` row (or amendment) result from Reflection.
- Mobile check: Portrait Studio at phone width — candidate grid and entity pickers stack
  single-column, no horizontal scroll.

## Out of Scope

- **Any change to `generateLocationImage.ts`, `synthesizeImagePrompt.ts`, or `image_connections`'
  existing style-prefix columns.** The location pipeline is deliberately untouched — this plan proves
  the new system through Portrait Studio first. Migrating locations onto a shared Style entity (and
  deleting the old style-prefix plumbing at that point) is separate future work, written up as its
  own plan once this one has shipped and been used for real.
- Runtime portrait rendering inside live chat turns, Director-Pass expression selection, and VN mode
  — this plan is the training/authoring surface only; nothing here is consumed by a live story yet.
- Outfit-as-canonical-scene-state (a character's "currently worn" outfit as a canon-writable fact) —
  Outfit entities exist and are trainable here, but nothing wires them into scene state yet.
- Cross-pollination bootstrapping for brand-new entities (playground §23.9) and the Diagnostic Focus
  Feature pre-step (playground §13) — genuine improvements to the loop, not required to prove it
  works; candidates for a follow-up pass once this one is in real use.
- Any multi-domain "Domain Package" generalization beyond image generation, or a servable
  "artifact on demand" API (playground §24/§25) — speculative even in playground itself; not part of
  BigImagine's roadmap yet.
- A `plugins/portraits` package — nothing in this phase is an LLM tool call during a live turn;
  everything is operator-driven Studio routes, same category as Settings/Connections. A thin plugin
  surfaces once runtime rendering (above) is built.

## Principles / Conventions in Play

- `bi_principles.md` §8 (Four Kinds of Code) — `composer.ts`/`reconcile.ts`/`evoprompt.ts`/`wiki.ts`
  are Pure Functions; `portraitGeneration.ts`/`portraitFeedback.ts` are Orchestrators;
  `layerStack.ts`/the DB access/`imageConnections.ts` stay IO Wrappers. Each new file declares its
  category in its preamble per §9.
- §11 (observability) — every fallback path (a dropped candidate, a failed `amend` match, a forced
  investigation-loop conclusion) logs why, not just that something happened.
- §13 (DB-backed runtime config) — the layer manifest, candidate count, and investigation turn cap
  all live in `orchestrator_settings`, none hardcoded.
- §14 (single LLM gate, task id) — every mutation and reflection call goes through the existing gate
  via `runWithCallContext`, `kind: 'system'`, exactly like `generateChatTitle.ts`.
- §17 (prompts surfaced for tuning) — mutation and reflection system prompts get Settings-tab
  overrides, empty meaning "use the built-in default."
- §18 (mobile-first) — Portrait Studio's layout stacks single-column at the existing 768px breakpoint
  convention.
