## Goal

`studio-character-bridge-plan.md` (Parts A–E) is code-complete but unshipped: nothing in the
codebase exercises any of the six behaviors its own Tests section calls for, and the DB migration
its Part E depends on (`db/migrations/0107_scene_presence_order.sql`) has not been applied to the
live database — confirmed directly via `psql`, `scene_presence` has no `presence_order` column
today, so the already-written `replaceScenePresence` insert would error the moment it ran. Two
things close the gap before this can be called done: real automated test coverage for the plan's
own six scenarios, and a household-wide kill switch for the whole Portrait Studio chain — routes,
UI tab, and the `ActivePortrait` box — so a bad interaction found after shipping can be turned off
from Settings with no code change or redeploy, the same shape this codebase already uses for other
newly-risky subsystems (`agent_routines_enabled`, `notifications_enabled`).

## Files

- `orchestrator/src/io/orchestratorSettings.ts` — modified — add `visual_portraits_enabled` to
  `SETTING_NAMES`; document it in the file's settings-catalog header comment alongside the other
  five `visual_*` keys: text `'true'`/`'false'`, default `'true'` when unset (the feature predates
  this plan and is already in use — this is an opt-out safety valve, not an opt-in gate, unlike
  `notifications_enabled`'s default-off), read live, no restart.
- `orchestrator/src/server/portraitRoutes.ts` — modified — add a small
  `requirePortraitsEnabled(deps, res)` guard (reads the setting, sends `403 { error }` and returns
  `false` when off) called as the first line of `handlePortraitEntities`,
  `handlePortraitEntityFromCharacter`, `handlePortraitEntitySetAsAvatar`, `handlePortraitWiki`,
  `handlePortraitGenerate`, and `handlePortraitFeedback`. Add `handlePortraitsEnabledGet` /
  `handlePortraitsEnabledSet`, mirroring `handleChatBackgroundSettingsGet`/`Set`'s shape exactly
  (one handler pair, registered at both a user-gated public path and an admin-gated path).
  `handlePortraitLayersGet`/`handlePortraitLayersSet` are deliberately **not** gated — see Edge
  Cases.
- `orchestrator/src/server/httpServer.ts` — modified — register `GET /v1/portraits-enabled`
  (`withUser`) and `GET`/`POST /v1/admin/portraits-enabled` (`withAdmin`), same three-route shape
  as the existing `chat-background-settings` trio, placed in the "Portrait Studio" route block.
- `frontend/src/api/types.ts` — modified — add the settings shape (Contracts).
- `frontend/src/api/client.ts` — modified — add `getPortraitsEnabled`, `adminGetPortraitsEnabled`,
  `adminSetPortraitsEnabled`, mirroring `getChatBackgroundSettings`/`adminGetChatBackgroundSettings`/
  `adminSetChatBackgroundSettings`.
- `frontend/src/App.tsx` — modified — fetch `getPortraitsEnabled` once auth resolves into a new
  `portraitsEnabled` state; use it to omit the `'portraits'` tab type from whatever it currently
  passes into `TypePicker`/`AppNavDrawer`, to gate mounting `PortraitStudioView` and
  `ActivePortrait`, and to render a small "Portrait Studio is disabled" placeholder instead of a
  blank pane if a `'portraits'` tab is already open (from a persisted tab list) when the flag is
  off.
- `frontend/src/components/TypePicker.tsx` — modified — omit the `'portraits'` entry when disabled
  (exact mechanism — filtering the list in App.tsx before it reaches this component, vs. a new
  prop here — is Reasonix's call; whichever keeps the existing prop shape simplest).
- `frontend/src/components/appNav/AppNavDrawer.tsx` — modified — same omission for its own
  `'portraits'` nav entry.
- `frontend/src/views/SettingsView.tsx` (+ `.css` if the existing fieldset styles don't cover it)
  — modified — new "Portrait Studio" fieldset, admin-gated like the Character-describer fieldset
  added earlier, with the enable/disable toggle wired to `adminGetPortraitsEnabled`/
  `adminSetPortraitsEnabled`.
- `orchestrator/scripts/verify-visual-portrait-bridge.mjs` — created — fake-pool verify script
  (same convention as `verify-location-presence-scraper.mjs`) covering Parts A–C's route/service
  logic: `from-character` create/refresh/404/409, `set-as-avatar` 400s and overwrite behavior,
  `submitPortraitFeedback`'s per-entity `slots` write and avatar fill-when-empty rule.
- `orchestrator/scripts/verify-visual-layer-stack.mjs` — created — covers the `format` layer's
  presence in `DEFAULT_LAYER_MANIFEST` and the `{{format_overflow}}` template token (Part D),
  unless Reasonix finds an existing layer-stack verify script this belongs in instead — check
  before creating a new file.
- `orchestrator/scripts/verify-location-presence-scraper.mjs` — modified — extend with a
  `presence_order` assertion: `replaceScenePresence` writes each character's array index as
  `presence_order`, in insertion order.
- `plugins/scenes/scripts/verify-scenes.mjs` — modified — extend with a `get_scenes` assertion:
  `characterIds` comes back ordered by `presence_order`, not insertion/PK order.

## Logic

**The toggle.** `visual_portraits_enabled` is a single household-wide switch. When it reads
`'false'`, every portrait-related HTTP surface except the layer-manifest pair returns `403 { error:
'portrait studio is disabled — enable it in Settings' }` before doing any other work (no partial
DB reads, no fetches to external image URLs). The frontend never lets a user reach a portrait
surface in the first place when the flag is off: no Portraits entry in the type picker or nav
drawer, no `PortraitStudioView` mount, no `ActivePortrait` mount. `App.tsx` fetches the flag once,
right after `apiKey` becomes available (same point auth-gated startup fetches already happen),
and holds it in state — no polling, a manual page reload picks up an admin's change, matching how
other admin-gated household toggles in this codebase already behave (no live-push mechanism
exists here).

Scope note: the toggle covers Portrait Studio's own subsystem only — routes under `/v1/portraits/*`
(except layers), `PortraitStudioView`, `ActivePortrait`. It does **not** cover `presence_order`
itself: scene-presence ordering (`locationAndPresenceScraper.ts`, `get_scenes`) is a general scene
feature the cleanup header prompt already depends on independent of Portrait Studio, and stays
live regardless of this flag. Applying migration `0107_scene_presence_order.sql` to the live
database is a separate, still-outstanding prerequisite this plan does not implement — it's an
ops/deploy step, not code, but it blocks Part E in production regardless of this plan's toggle and
should happen before or alongside this work ships.

**The tests.** Each new/extended verify script proves one thing from `studio-character-bridge-plan.md`'s
own Tests section against a fake Postgres pool (or, for the pure `layerStack.ts` manifest checks,
no pool at all) — no live server, no network, no LLM, matching every existing script's convention
in this codebase.

## Contracts

- `orchestrator_settings.visual_portraits_enabled`: text `'true'` | `'false'`, default (unset)
  behaves as `'true'`.
- `GET /v1/portraits-enabled` (`withUser`) and `GET /v1/admin/portraits-enabled` (`withAdmin`) →
  `200 { enabled: boolean }`.
- `POST /v1/admin/portraits-enabled` (`withAdmin`), body `{ enabled: boolean }` → `200 { enabled:
  boolean }` echoing the new value; `400 { error }` on a missing/non-boolean `enabled`.
- Every gated portrait route, when disabled → `403 { error: 'portrait studio is disabled — enable
  it in Settings' }`.

## Edge Cases

- **Lockout risk**: `GET`/`POST /v1/portraits/layers` must stay reachable regardless of the flag —
  they're not part of "the chain" being toggled, and `POST /v1/portraits/layers` is unrelated to
  turning the feature back on (that's the new admin toggle route, not the layers route) — but
  don't gate either of them, since the layers pair has no dependency on the flag being on and
  gating it buys nothing while adding a needless failure mode to the Studio's Manage Layers editor.
- A `'portraits'` tab already open in a persisted tab list when the flag flips off must not render
  a silent blank pane — show the disabled placeholder instead (see Files/App.tsx).
- `visual_portraits_enabled` unset (fresh install, pre-migration household) must behave as `'true'`
  — same fail-open-to-current-behavior shape every other settings key in `orchestratorSettings.ts`
  uses, not fail-closed.
- `set-as-avatar`'s image fetch (`portraitRoutes.ts` and `portraitFeedback.ts`'s fill-when-empty
  path) both already fail open (catch, log, continue/500 without corrupting state) — the new tests
  must prove that failure path stays intact, not just the happy path.
- `submitPortraitFeedback`'s avatar promotion only fires when `characters.avatar_path` is currently
  `null` — a test that seeds a non-null `avatar_path` and asserts it is left untouched is the one
  most likely to be skipped; it's the crux of Part C's "fill-when-empty, not overwrite" contract.

## Tests

- `from-character`: creates a new subject entity from a character with a persona; refreshing an
  already-seeded entity overwrites `standing_instructions` unconditionally (no "already seeded,
  skip"); unknown `characterId` → 404; blank/whitespace-only persona → 409, no entity created or
  touched.
- `set-as-avatar`: non-subject-layer entity → 400; entity with no `character_id` → 400; entity with
  no `last_image_url` → 400; success path writes the character's avatar and always overwrites,
  regardless of the character's current `avatar_path`.
- `submitPortraitFeedback`: the round winner's `slots` (from the winning chromosome) are written
  onto the winning entity, non-winning entities in the same round are left untouched; when the
  winning entity's linked character has `avatar_path = null`, the winning image is written as the
  avatar and `avatar_path` becomes `'local'`; when `avatar_path` is already non-null, it is left
  exactly as it was.
- `DEFAULT_LAYER_MANIFEST` includes a `format` layer (`id: 'format', label: 'Format'`) and the
  compiled template includes the `{{format_overflow}}` token.
- `replaceScenePresence` writes `presence_order` as each character's index in the array it's given,
  in order, on both a fresh scene and one being replaced.
- `get_scenes` returns `characterIds` ordered by `presence_order`, not row-insertion order — the
  round-trip the whole point of the migration exists for.
- `visual_portraits_enabled = 'false'`: every gated route (`entities`, `from-character`,
  `set-as-avatar`, `wiki`, `generate`, `feedback`) returns 403 without touching the DB or issuing
  any fetch; `layers` GET/POST are unaffected either way.
- `ActivePortrait.tsx` and the App.tsx tab-gating logic have no automated coverage — this repo has
  no frontend test harness for any component. Verify by hand once the toggle lands: flip it off in
  Settings, confirm the Portraits nav entry disappears and an already-open Portraits tab shows the
  placeholder instead of a blank pane; flip it back on and confirm both return.

## Out of Scope

- Applying `db/migrations/0107_scene_presence_order.sql` to the live database — a deploy-time
  action, not a code change; flagged above as a blocking prerequisite, not implemented here.
- Any live-push mechanism for the toggle (e.g. other open tabs picking up an admin's change
  without a reload) — matches every other admin-gated toggle in this codebase today.
- Re-reviewing Parts A–E's implementation itself — already assessed as correct; this plan only
  adds coverage and a kill switch around it.

## Principles / Conventions in Play

- `bi_principles.md` §17's "default + bespoke, empty means built-in" fallback shape doesn't apply
  here (this is a boolean, not a prompt override), but the same fail-open-to-existing-behavior
  instinct does: unset must mean `'true'`, not `'false'`.
- Matches `docs/roles.md`'s contracts carve-out: the settings key, the three route shapes, and the
  403 body are pinned down exactly above; everything else (component prop plumbing, exact fake-pool
  fixture shape) is left to Reasonix.
