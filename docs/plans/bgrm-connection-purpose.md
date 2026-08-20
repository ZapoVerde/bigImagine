# Exposing Playground's Background Removal (BGRM) as an Image Connection Purpose

*Created 2026-08-18, reviewed for drift 2026-08-20. Governed by `bi_principles.md`. Plan only —
**not yet implemented** at time of writing (confirmed: no `bgrm`/`removeBackground` reference
anywhere in `orchestrator/src`). Written as the design write-up of an investigation into
`/config/workspace/playground`'s background-removal implementation
(`playground/sandbox/providers/runware.js`, `sandbox/runner.js`, `orchestrator.js` step 6a,
`docs/spec.md` §18.4) and how to port it to BigImagine as a `purpose = 'bgrm'` image connection.
The two "related existing plans" originally cited here — `docs/plans/completed/portrait-studio-plan.md`
and `docs/plans/vistalyze_integration/endpoint.md` — were deliberately deleted in commit `40a1ff4`
(2026-08-20, "clears out docs/plans/completed/ — the stale plan docs were poisoning context for
coding agents"); `docs/plans/completed/` no longer exists at all. Their content is gone, not moved —
don't go looking for a new path. The design points they established (purpose split, connection
resolution) are re-derived directly from current source below instead.*

---

## Goal

Add an optional **background-removal post-process** (BGRM) to BigImagine — the same capability
Playground's `removeBackground` provides — modeled as a new image **connection `purpose`** so the
administrator manages it in the Connections tab exactly like the `background` and `portrait`
connections. When enabled, a finished image (a location background render *and/or* a Portrait
Studio candidate) is re-submitted to a background-removal API (Runware for v1) and its URL is
replaced with the background-stripped result. This matches Playground's behavior
("Ported from SillyTavern-Personalyze's 'bgrm' feature ... separate API call on the finished image
URL, not tied to how that image was made"), with the key difference that Playground keeps it a
global Settings toggle while BigImagine surfaces it as a per-purpose connection with a default in
the Studio sidebar and a per-chat toggle in the RP right-hand rail (per operator's direction).

Concretely, three surfaces:

1. **Connections tab** — a new `purpose = 'bgrm'` connection type (operator confirmed: "purpose
   feels right here", 2026-08-18).
2. **Studio side panel** — a **default-on** toggle in the Portrait Studio sidebar that applies BGRM
   to every Portrait Studio candidate render.
3. **RP right-hand panel** — a per-chat toggle in the RP chat settings rail that applies BGRM to
   that chat's location background renders.

### Out of scope (declared)

- **Not a new `kind`.** BGRM is a *post-process on an already-rendered URL*, not a generator. It
  must never be added to the `ImageConnectionKind` vocabulary or the `createImageGenProvider`
  dispatch, which returns a fresh image URL from a prompt. It is a `purpose` on a Runware-kind
  connection.
- **Anthropic is always out of scope** as a provider for anything BigImagine serves (standing
  rule). This is moot here — BGRM v1 is Runware-only — but the plan does not introduce any other
  provider.
- No support for Playground's PiAPI async/polled variant (Playground's own §18.4 notes it was not
  ported; same here). Runware only for v1.

---

## Background

### How Playground does it (the reference implementation)

`playground/sandbox/providers/runware.js` `removeBackground(imageUrl, model, taskId)`:

```ts
const task = {
  taskType: 'removeBackground',          // NOT the retired 'imageBackgroundRemoval'
  taskUUID: crypto.randomUUID(),
  model: model || 'runware:109@1',       // RemBG v1.4; also runware:112@9, bria:2@1
  inputs: { image: imageUrl },           // NOT the retired `inputImage: url`
  outputFormat: 'PNG',
};
// POST [task] to https://api.runware.ai/v1, Authorization: Bearer <key>
```

- Same array/Bearer/fetchWithRetry transport as its own `generateOne`.
- **Mock mode**: no `RUNWARE_API_KEY` → returns the original URL unchanged (`{ skipped: true }`),
  never fails.
- The request shape is load-bearing: Playground commit `1250a7c` fixed a silently-misbehaving
  `taskType: 'imageBackgroundRemoval'` / `inputImage` shape that 400'd every real call with a
  misleading `Invalid value for 'model' parameter`. The correct REST shape is `removeBackground` +
  `inputs: { image }`.

`playground/sandbox/runner.js` `removeBackgroundBatch(executionResults, { taskId, model })`:
- Maps over generation results, only touching `status === 'success'` rows with an `imageUrl`.
- On success replaces `imageUrl`; on any failure/skip **keeps the original** — a failed or skipped
  BGRM never turns a successful generation into a failed one.

`playground/orchestrator.js` step **6a**: runs after `runZitBatch` (step 6), before `last_image_url`
persistence (step 6.5), only when `settings.removeBackground` is true, using `settings.rmbgModel`.
Works for *any* generation provider (it is a separate call on the finished URL) but always needs
`RUNWARE_API_KEY`. Same post-process is duplicated in `spin.js` and `server.js` (regen/test paths).

`playground` settings surface: the toggle lives in **global Settings**, not per-client. Per the
operator, *"the rmbg is meant to be a toggle in settings, not a default thing"* — deploy-wide tier,
same as `imageProvider`/`imageModel`/`imageSeed`. Both the settings save endpoint and the modal
guard against "toggled on with no model selected": the endpoint coerces a blank model back to
`runware:109@1`; the modal refuses to save with a clear message.

### BigImagine's analogue

BigImagine has no global "image Settings" toggle. Image backends are admin-managed **connections**
(`db/migrations/0068_image_connections.sql`, `orchestrator/src/io/imageConnections.ts`), and since
`db/migrations/0105_visual_studio.sql` a connection carries a **`purpose`**:

- `purpose` vocabulary `('background' | 'portrait')`, default `'background'`.
- **One active row per purpose** — partial unique index
  `image_connections_one_active_per_purpose (purpose) where is_active`.
- `resolveActive(purpose = 'background')` reads the active row live on every render (no restart),
  per `bi_principles.md` §13.
- `activate(id)` deactivates only same-purpose rivals (two sub-updates in one transaction).

The two render pipelines that consume connections:
- **Location background** — `orchestrator/src/orchestrator/generateLocationImage.ts`: cache-first,
  resolves the active `background` connection via `resolveActive()` (default), synthesizes the
  prompt, dispatches through `createImageGenProvider().generate()`, stores the returned CDN URL.
- **Portrait Studio** — `orchestrator/src/orchestrator/portraitGeneration.ts`: resolves the active
  `purpose = 'portrait'` connection, dispatches each candidate in parallel, writes one
  `visual_candidates` row per candidate.

Both already resolve "one connection by purpose" — the exact seam a `'bgrm'` purpose rides on.

---

## Files

New:

- `db/migrations/0116_image_connections_bgrm_purpose.sql` — widen `image_connections.purpose`'s
  `CHECK` (append-only; 0105 stays untouched) and add the `orchestrator_settings` keys for the
  Studio default.
- `orchestrator/src/io/imageGen/removeBackground.ts` — the Runware `removeBackground` adapter
  (IO Wrapper), failing open.
- `orchestrator/src/util/removeBackgroundBatch.ts` (or a shared helper) — the "post-process a batch,
  replace `imageUrl`, never fail" pass, mirroring Playground's `removeBackgroundBatch`. Its exact
  placement (own file vs folded into each orchestrator) is a judgment call for implementation; a
  shared Pure/IO helper avoids duplicating the loop across `generateLocationImage.ts` and
  `portraitGeneration.ts`.

Edited:

- `orchestrator/src/io/imageConnections.ts` — `ImageConnectionPurpose` type gains `'bgrm'` (line
  64, confirmed current: `export type ImageConnectionPurpose = 'background' | 'portrait';`); no
  store logic change (list/create/update/activate/remove/resolveById/resolveActive all already
  treat `purpose` opaquely).
- `orchestrator/src/server/admin/imageConnections.ts` — `isImagePurpose` (line 76) accepts `'bgrm'`.
  **Path correction**: this used to live in `adminServer.ts` at the time this plan was written, but
  a same-day split (commit stamped 2026-08-20, done as this review was happening) broke
  `adminServer.ts` into `server/admin/*.ts` domain modules; `adminServer.ts` is now a 157-line
  re-export façade only. `isImagePurpose`, `parseCreateImageConnectionBody`, and
  `parseUpdateImageConnectionBody` all live in `server/admin/imageConnections.ts` now — edit there,
  not in `adminServer.ts`.
- `orchestrator/src/orchestrator/generateLocationImage.ts` — optional BGRM post-process on the
  rendered URL when the purpose `'bgrm'` connection's toggle is on for that chat.
- `orchestrator/src/orchestrator/portraitGeneration.ts` — optional BGRM post-process on each
  candidate's URL under the Studio default.
- `orchestrator/src/server/portraitRoutes.ts` — the Studio BGRM default setting (GET/POST), modeled
  on the existing `portrait_llm_connection` route.
- `frontend/src/components/connections/ImageConnectionEditor.tsx` — Purpose `<select>` gains a
  `bgrm` option; provider fields gated for a `bgrm`-purpose row.
- `frontend/src/views/ConnectionsView.tsx` — active-row badge gains a `bgrm` case. **Correction**:
  the existing convention (confirmed current, line ~246) is a terse 3-letter parenthesized code —
  `(prt)` for portrait, `(bg)` for background — not the full purpose name; follow that pattern
  (e.g. `(brm)`), not literal `(bgrm)`.
- `frontend/src/components/sidebar/` — new (or extended `PortraitConnectionPanel`) Studio BGRM
  default toggle (Portrait Studio is a *left* sidebar; "Studio side panel" = the
  `Sidebar.tsx` `case 'portraits'` drawer `PortraitConnectionPanel`/`PortraitPromptsPanel`).
- `frontend/src/views/ChatView.tsx` — `ChatSettings` (the RP *right-hand* `chat-settings-rail`)
  gains a "Background removal" toggle + model set, per-chat.

Docs:

- `docs/plans/bgrm-connection-purpose.md` (this plan).
- Optionally fold the BGRM note into the relevant migration README entry later.

---

## Logic

### 1. Connection type as a purpose — `purpose = 'bgrm'`

- `ImageConnectionPurpose` becomes `'background' | 'portrait' | 'bgrm'`.
- A `'bgrm'` connection is a normal `image_connections` row with `kind = 'runware'`, its `model`
  one of Runware's RMBG ids (`runware:109@1` RemBG v1.4 default, `runware:112@9` BiRefNet Matting,
  `bria:2@1` Bria RMBG 2.0), `api_key_ciphertext` = the Runware key, and none of the width/height /
  prompt / sampler fields meaning anything (BGRM has no dimensions or prompt).
- `resolveActive('bgrm')` (new purpose arg) resolves the single active BGRM row — the exact same
  per-purpose index/query shape as `background`/`portrait`.
- Migration **0116** (new, append-only):
  ```sql
  alter table image_connections drop constraint if exists image_connections_purpose_check;
  alter table image_connections add constraint image_connections_purpose_check
    check (purpose in ('background', 'portrait', 'bgrm'));
  ```
  (edit `0105`'s inline `check` is forbidden — append-only). The `0105` partial unique index
  `image_connections_one_active_per_purpose` already keys on `(purpose)`, so it needs no change and
  automatically permits one active `bgrm` row.

### 2. Adapter — `orchestrator/src/io/imageGen/removeBackground.ts`

Model on the existing `io/imageGen/runware.ts` transport (array POST to
`https://api.runware.ai/v1`, `Authorization: Bearer`, `fetchWithRetry`). Do **not** route through
`createImageGenProvider` (that factory is for generators). Signature:

```ts
interface BgrmRequest { imageUrl: string; model: string; apiKey: string; }
removeBackground(req: BgrmRequest): Promise<{ imageUrl: string }>   // throws on failure
```

- Task shape (Playground's verified fix): `taskType: 'removeBackground'`, `taskUUID`,
  `model` (default `runware:109@1`), `inputs: { image }`, `outputFormat: 'PNG'`.
- **Fail-open contract** (`bi_principles.md` §11): the caller decides; a failed call must not throw
  into the render pipeline — the batch helper catches and keeps the original.

### 3. Batch post-process — shared helper

```ts
async function applyBackgroundRemoval(
  renderedUrls: { imageUrl: string }[],
  opts: { model: string; apiKey: string; taskId: string },
): Promise<{ imageUrl: string }[]>   // same length; failed rows keep original imageUrl
```
- Parallel `Promise.all` over rows; on success replace `imageUrl`; on any rejection or skipped call
  keep the original and log at the seam (bi_principles.md §11) — **never** mark the render failed.

### 4. RP right-hand panel — location backgrounds

`generateLocationImage.ts`: after the provider returns the CDN `imageUrl` and before persisting it,
if the effective per-chat BGRM toggle is on, resolve the `'bgrm'` connection and post-process the
URL. Where the per-chat toggle lives is the one open data-model decision (see §Design Decisions):
a `chat.params` boolean vs a new chat column vs an `orchestrator_settings`-backed household default
with a per-chat override via the RP rail.

**Render-cache caveat.** The location cache keys on the render hash
(`image_render_hash` from `renderInputHash`, `generateLocationImage.ts`) — a sha256 over prompt +
provider params. BGRM changes the *final stored URL* without changing any generation-side input, so
**enabling BGRM must be treated as a variant input to the hash**, otherwise a cache hit would reuse
the pre-strip image. Fold a `bgrm: boolean` (and the active BGRM model) into `renderInputHash`'s
input object so toggling BGRM invalidates the cache and renders fresh. (Playground has no image
cache, so it never faces this.)

### 5. Studio side panel — Portrait Studio candidates

`portraitGeneration.ts`: when the Studio BGRM default is on, resolve `resolveActive('bgrm')` and
post-process each successful candidate's `imageUrl` after the parallel dispatch. A BGRM failure for
one candidate keeps that candidate's original image (never aborts the round, never drops a
candidate) — mirroring the plan's existing "a single candidate's provider failure is logged and that
candidate comes back with imageUrl null, never an aborted round" posture.

Studio default switch: a new `orchestrator_settings` key (e.g. `portrait_bgrm_enabled`, default
off — the *option* is surfaced and can be default-on, the stored value starts `false`/unset) read
live per round, plus perhaps the default BGRM model. Admin GET/POST route in `portraitRoutes.ts`
(modeled on `portrait_llm_connection`), surfaced in the Studio sidebar alongside
`PortraitConnectionPanel`.

### 6. Default-on vs per-surface toggles

Per the operator's direction ("default on option in the studio side panel", "default on option ...
in the rp right hand side panel"), the design should distinguish:

- A **household/RP default** BGRM connection (the single active `bgrm` row) — the Connections tab
  "Set as default" controls it, exactly like `background`/`portrait`.
- A **Studio-side default-on toggle** that opts Portrait Studio candidate renders into BGRM by
  default (a settings key, not a per-entity flag).
- A **per-chat override in the RP rail** that turns BGRM on/off for a specific chat's location
  background (and can fall back to the household default when unset).

Full layering (global default → surface default → per-chat override) is the implementation to build;
the exact precedence is the first-open item in §Design Decisions.

---

## Contracts

**`orchestrator/src/io/imageConnections.ts`**
- `ImageConnectionPurpose = 'background' | 'portrait' | 'bgrm'`.
- Store API unchanged: `create`, `update`, `remove` (still refuses to delete an active row), `activate`
  (per-purpose — a `bgrm` activation must not demote the active background or portrait row, and vice
  versa; the existing per-purpose `activate` already guarantees this), `resolveActive('bgrm')`.

**`orchestrator/src/server/admin/imageConnections.ts`** (not `adminServer.ts` — see §Files)
- `isImagePurpose` returns true for `'bgrm'`; create/update bodies accept it.
- Connections list/badges: a `bgrm` row is listed with every other connection and carries a
  `(bgrm)` active badge, per the Connections tab's combined-list convention.

**`orchestrator/src/io/imageGen/removeBackground.ts`**
- Pure IO; no prompt composition, no domain decisions. Throws on provider failure; mock/off path is
  decided by the caller (via a missing apiKey → keep original).

**Adapter / batch**
- MUST NOT turn a successful render into a failed one.
- MUST log a failed/skipped removal at the seam (bi_principles.md §11).

---

## Edge Cases

- **No active `bgrm` connection but toggle on** → gracefully skip (keep original), log. Never fail
  the render. Same Tier design as Playground's "no `RUNWARE_API_KEY` → skip".
- **Toggle on with no model** (a blank `bgrm` model on the connection) → coerce to the default
  (`runware:109@1`) at save; modal refuses to save a blank model when the toggle is on (Playground's
  two-layer guard).
- **BGRM + non-Runware generation provider** → fine: BGRM is a separate post-process call, so it
  works regardless of which provider generated the image (Playground §18.4 makes exactly this point).
- **Cache invalidation** → BGRM-on must be part of `renderInputHash`, per §Logic.4, so toggling it
  cannot reuse a pre-stripped cached location image.
- **Output format PNG vs JPG** → BGRM returns PNG (transparency). Backgrounds/portrait candidates
  currently render JPG. Storing/serving a PNG URL is fine; flag whether the parallax / dim veil /
  bubble-fill weighting assumptions change. Decide in implementation (accept PNG; do not re-encode).
- **Portrait candidate BGRM failure** → keep that candidate's original image; never abort/drop the
  round.
- **In-flight guard / swipe race** → BGRM runs after the provider returns, so the existing
  `renderInFlight` and swipe bookkeeping still govern *generation*; a BGRM failure returns the
  original URL and records it as normal.

---

## Tests

- **Adapter** (`orchestrator/src/io/imageGen/removeBackground.ts`): unit test asserting the task
  shape is `taskType: 'removeBackground'` + `inputs: { image }` (guard against regressing to
  Playground's retired `imageBackgroundRemoval`/`inputImage` shape); mock/off behavior.
- **Batch helper**: a failed/skipped row keeps its original `imageUrl`; a success replaces it;
  length is preserved.
- **GenerateLocationImage**: with `bgrm` on, the stored `image_url` is the stripped URL and the
  render hash changed (cache invalidated); with `bgrm` off or no `bgrm` connection, unchanged.
  Fail-open: a BGRM throw still returns `{ ok: true }` with the original URL.
- **PortraitGeneration**: `bgrm` default on → candidates' `imageUrl` stripped, round still succeeds
  and writes `visual_candidates` rows; a BGRM failure keeps the candidate's original image, never
  aborts.
- **Connections**: create/activate a `bgrm` connection; activating it does not demote the active
  background or portrait row (per-purpose); delete of an active `bgrm` row refused; list returns it
  with the `(bgrm)` badge.
- **Frontend (manual/cypress-style if present)**: Purpose `<select>` shows `bgrm`; Studio default
  toggle persists; RP rail toggle persists per chat.

---

## Design Decisions

Open items to lock before coding (call using the existing `ask`/decision convention where a real
fork exists):

1. **Toggle layering & storage.** One global household default (`bgrm` connection = on/off) plus a
   Surface default + per-chat override → what storage backs each. **Correction**: `chat_sessions`
   has no jsonb `params` blob to hang a boolean off — checked current migrations (0009's base table
   through 0128, which just dropped `archived_at`), and every chat-scoped setting added over time
   (`scene_id`, `previous_scene_id`, the 0072 cleanup-heuristic columns, etc.) is its own typed
   column, never a generic bag. Drop the "`chat.params` boolean" option; the per-chat override
   needs a dedicated `chat_sessions` column (e.g. `bgrm_enabled boolean`, nullable, unset = defer to
   household/surface default) to match the table's established shape. Recommended: household active
   `bgrm` connection governs availability; `portrait_bgrm_enabled` settings key for the Studio
   default; a new nullable `chat_sessions` column for the per-chat RP override.
2. **Where the shared batch helper lives.** Own file (`util/removeBackgroundBatch.ts`) vs folded
   into each orchestrator, to honor the 300-line file budget and four-kinds split. **Worth noting**:
   `portraitGeneration.ts` (993 lines) and `portraitRoutes.ts` (1326 lines) are already several
   times over that budget before this plan touches them — `adminServer.ts` just went through
   exactly this split (into `server/admin/*.ts`, same-day as this review) for the same reason.
   Adding BGRM logic as a new file that these two import from, rather than growing either further
   inline, avoids repeating that cleanup later; it does not, on its own, obligate splitting either
   file as part of this plan.
3. **Output format.** Accept PNG from BGRM and store/serve it, or re-encode to JPG for consistency
   with current background/portrait expectations.
4. **`renderInputHash` inputs.** Confirm `bgrm`-on (and its model) joins the hash input set. (This
   plan recommends yes.)

---

## Out of Scope

- Retired Playground request shapes and `PiAPI` async/polled variant.
- New LLM calls — BGRM is pure IO, no reasoning, no gate/attribution addition
  (`bi_principles.md` §14 is about LLM calls; BGRM makes no LLM call).
- Changing the Connections tab's combined-list or per-purpose activation model.
- Any non-Runware BGRM provider for v1; Anthropic excluded as always.

---

## Principles / Conventions in Play

- `bi_principles.md` §8 (four kinds of code — BGRM adapter is an IO Wrapper; batch helper is IO; no
  reasoning added), §9 (self-describing modules), §10 (file budgets), §11 (observability /
  fail-open), §13 (DB-backed, no `.env`), §18 (mobile — the RP rail and Studio sidebar are
  already mobile-flown layouts; the new toggle is a plain `<details>` set like its neighbors).
- Migrations are **append-only**: the `purpose` `CHECK` widen is migration **0116**, never an edit
  to `0105`.
- The Connections tab's `purpose` vocabulary is a closed set widened only by a new migration + the
  TS type + the frontend `<select>` — all three enumerated in §Files.
