# Implementation Plan — Character Image Background Removal

> Purpose: turn the finalized BGRM Blueprint into an ordered set of independently implementable and independently reviewable coding tasks.
>
> Governing artifacts:
> - `docs/plans/bgrm/1_ARCHITECTURAL_REPORT.md`
> - `docs/plans/bgrm/2_BLUEPRINT.md`
>
> The already-landed BGRM connection/profile capability and Runware `removeBackground()` adapter are treated as existing prerequisites, not as work to repeat.

## 1. Mission Summary

Complete the character-image BGRM pipeline on top of the existing Runware BGRM engine profile. The implementation must support Pollinations-generated character images by URL and Runware-generated character images by provider-native UUID when available, without routing image bytes through BigImagine. BGRM applies only to Portrait Studio and RP character imagery, is independently opt-in for each surface, fails open to the raw generated URL, and must preserve correct RP character-image cache identity.

Location/chat backgrounds are explicitly out of scope.

## 2. Validation Classification

Use the repository planning protocol rubric.

A task is **Critical** if it materially touches one or more of:

1. shared state ownership
2. core business/domain logic
3. high fan-out interfaces or modules
4. canonical domain models/schemas
5. I/O, persistence, concurrency, or cross-process/thread behaviour
6. authentication, authorization, secrets, or security boundaries

Validation tiers:

- **Tier 1 — Basic:** low-risk/config/presentation/test-only work.
- **Tier 2 — Standard:** normal feature logic with bounded impact.
- **Tier 3 — Critical:** any task matching the criticality rubric or otherwise carrying meaningful architectural risk.

Validation tier describes review rigor, not coding difficulty.

## 3. Implementation Phases

---

# Phase 1 — Establish a Reference-Aware Character Image Post-Process Seam

**Phase objective:**  
Allow character-image orchestration to receive a normal image URL plus an optional provider-native image reference, and provide one shared fail-open BGRM post-processing function without changing legacy image-generation consumers.

**Phase completion condition:**  
Portrait and RP character-image orchestration can call a provider-neutral detailed generation API and then pass its result through a shared BGRM helper. Existing URL-only generation callers remain behaviourally unchanged.

## Task 1.1 — Add Reference-Aware Image Generation Without Breaking URL-Only Callers

### Objective

Expose a provider-neutral generated-image result containing the URL and optional provider-native reference, preserving Runware image UUIDs while keeping the existing `generate() -> string` contract intact for all current consumers.

### Architectural Intent

Implements the architecture's two source paths:

- external generator → public URL → BGRM;
- Runware generator → Runware image UUID → BGRM.

The change must remain additive so location backgrounds and admin connection diagnostics are not dragged into the BGRM feature.

### Scope

**Create:**
- None

**Modify:**
- `orchestrator/src/io/imageGen/types.ts`
- `orchestrator/src/io/imageGen/runware.ts`
- `orchestrator/src/io/imageGen/index.ts`
- `orchestrator/scripts/verify-image-connections.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/io/imageGen/removeBackground.ts`
- `orchestrator/src/io/imageGen/pollinations.ts`
- `orchestrator/src/io/imageGen/fal.ts`
- `orchestrator/src/orchestrator/generateLocationImage.ts`

### Required Logical Changes

#### `orchestrator/src/io/imageGen/types.ts`

- Add a common `GeneratedImage` result shape.
- It must contain a mandatory `imageUrl: string`.
- It may contain an optional provider-native reference suitable for immediate post-processing.
- Do not make provider-native references mandatory for all providers.
- Do not replace the existing URL-only provider interface.

#### `orchestrator/src/io/imageGen/runware.ts`

- Preserve the current URL-only generation function/API for existing callers.
- Add a detailed generation path that captures the Runware response's image UUID when present.
- Keep Runware response parsing inside the Runware IO adapter.
- The detailed result must still always include the usable image URL.
- Do not persist the Runware UUID.

#### `orchestrator/src/io/imageGen/index.ts`

- Add one provider-neutral reference-aware generation entry point.
- For Runware, use the detailed Runware generation path and preserve the UUID.
- For non-Runware providers, use the existing generation path and wrap the returned URL with no native reference.
- Leave `createImageGenProvider(...).generate() -> Promise<string>` unchanged.

#### `orchestrator/scripts/verify-image-connections.mjs`

- Add deterministic coverage for Runware detailed generation returning both URL and UUID.
- Add coverage proving a non-Runware detailed result still returns a URL and no provider-native reference.
- Preserve all existing BGRM adapter and image connection tests.

### Acceptance Criteria

- **T1.1-AC01:** Existing `ImageGenProvider.generate()` callers continue receiving URL strings with no required call-site changes.
- **T1.1-AC02:** The new detailed generation API always returns `imageUrl`.
- **T1.1-AC03:** Runware detailed generation exposes the exact image UUID returned by Runware when available.
- **T1.1-AC04:** A non-Runware provider result contains no fabricated provider-native reference.
- **T1.1-AC05:** No location-background code is modified or behaviourally changed.
- **T1.1-AC06:** No provider-native identifier is persisted merely to support BGRM.

### Verification

**Automated:**
- Extend `node orchestrator/scripts/verify-image-connections.mjs`.
- Run project typecheck/check command used by the repo.
- Run project build.

**Runtime/manual:**
- None required beyond deterministic mocked provider verification.

### Constraints & Anti-Patterns

- Do not change the legacy generator return type.
- Do not modify location-image generation.
- Do not leak Runware response parsing into orchestration.
- Do not invent native references for URL-only providers.
- Do not persist Runware UUIDs.
- No unrelated image-provider refactor.

### API Delta

New common result:

```ts
interface GeneratedImage {
  imageUrl: string;
  providerImageRef?: string;
}
```

Existing:

```ts
ImageGenProvider.generate(...) -> Promise<string>
```

remains unchanged.

Add a new reference-aware generation entry point returning `GeneratedImage`.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Touches a high fan-out image-generation IO boundary and provider-specific external IO while preserving compatibility (rubric 3 and 5).

### Task Completion Boundary

The task is complete when character-image callers can request `GeneratedImage`, Runware UUIDs survive the IO boundary, non-Runware callers receive URL-only detailed results, and every existing URL-only generation consumer remains unchanged and green.

---

## Task 1.2 — Add the Shared Fail-Open Character Image BGRM Helper

### Objective

Create one orchestration-level helper that applies the active BGRM profile to an already-generated character image and returns the effective downstream URL plus whether background removal actually succeeded.

### Architectural Intent

Creates the single application-level BGRM capability shared by Portrait Studio and RP character imagery. It keeps Runware request construction at the IO seam and keeps BGRM failure separate from image-generation failure.

### Scope

**Create:**
- `orchestrator/src/orchestrator/characterImagePostProcess.ts`

**Modify:**
- `orchestrator/scripts/verify-image-connections.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/io/imageGen/removeBackground.ts`
- `orchestrator/src/io/imageConnections.ts`
- `orchestrator/src/io/logger.ts`

### Required Logical Changes

#### `orchestrator/src/orchestrator/characterImagePostProcess.ts`

- Accept an already-generated `GeneratedImage` and the resolved active BGRM profile, or absence of one.
- Return an effective result containing:
  - `imageUrl`;
  - `bgrmApplied`.
- If no usable BGRM profile is available, return the original generated URL with `bgrmApplied = false` and log the fallback reason.
- Prefer `providerImageRef` when it is present and valid for the current Runware BGRM path.
- Otherwise pass `imageUrl` to `removeBackground()`.
- On BGRM success, return the transparent Runware URL with `bgrmApplied = true`.
- On any BGRM provider/transport/response failure, log at the orchestration/IO seam and return the original URL with `bgrmApplied = false`.
- Do not generate images, persist images, inspect bytes, download images, or own user settings.

#### `orchestrator/scripts/verify-image-connections.mjs`

Add deterministic helper coverage for:

- URL source → BGRM receives URL;
- Runware native ref → BGRM receives native ref;
- success → BGRM URL + `bgrmApplied = true`;
- no profile → raw URL + `false`;
- BGRM failure → raw URL + `false`;
- BGRM failure does not invoke image generation or trigger any image transfer.

### Acceptance Criteria

- **T1.2-AC01:** The helper is independent of Portrait Studio and RP chat semantics.
- **T1.2-AC02:** A Runware provider-native image ref is preferred when available.
- **T1.2-AC03:** A URL-only generated image is sent to Runware by URL without BigImagine downloading it.
- **T1.2-AC04:** BGRM success returns the transparent URL and `bgrmApplied = true`.
- **T1.2-AC05:** Missing profile or BGRM failure returns the original URL and `bgrmApplied = false`.
- **T1.2-AC06:** BGRM failure never throws through the successful character-image generation path.
- **T1.2-AC07:** The helper does not construct a generator or perform generation.

### Verification

**Automated:**
- Extend targeted BGRM/image connection verifier with mocked calls.
- Run typecheck/check.
- Run build.

**Runtime/manual:**
- None required.

### Constraints & Anti-Patterns

- Do not duplicate Runware request construction.
- Do not hide failures silently; log fallback/failure.
- Do not download or proxy images.
- Do not retry generation.
- Do not persist URLs or provider refs here.
- Do not read surface settings here.

### API Delta

New post-processing result:

```ts
interface CharacterImagePostProcessResult {
  imageUrl: string;
  bgrmApplied: boolean;
}
```

New shared character-image post-processing function consuming `GeneratedImage` and a resolved BGRM profile.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Core domain orchestration and external IO failure semantics (rubric 2 and 5).

### Task Completion Boundary

The task is complete when both future character-image consumers can use one deterministic fail-open BGRM function without containing Runware-specific request logic themselves.

---

# Phase 2 — Add Persistent Character-Image BGRM Configuration and Asset Identity

**Phase objective:**  
Persist two independent BGRM enablement settings and extend the RP character-image cache so raw and background-removed variants are distinguishable without changing the URL-only asset model.

**Phase completion condition:**  
The database and runtime settings layer can represent Portrait Studio enablement, RP character-image enablement, and actual BGRM state on cached RP character-image URLs.

## Task 2.1 — Add BGRM Settings and RP Character Cache State to Persistence

### Objective

Add the two runtime setting keys and a `bgrm_applied` cache dimension to `character_visual_combinations`, preserving all existing rows as raw assets.

### Architectural Intent

Makes per-surface opt-in explicit and prevents a raw cached character image from satisfying a request for a transparent character image.

### Scope

**Create:**
- `db/migrations/0132_character_image_bgrm.sql`

**Modify:**
- `orchestrator/src/io/orchestratorSettings.ts`
- `orchestrator/scripts/verify-character-visual-state.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `db/migrations/0125_character_visual_states.sql`
- `db/migrations/0131_image_connections_bgrm_purpose.sql`

### Required Logical Changes

#### `db/migrations/0132_character_image_bgrm.sql`

- Widen the legal `orchestrator_settings.key` vocabulary to include:
  - `portrait_bgrm_enabled`;
  - `character_visual_bgrm_enabled`.
- Do not seed either setting; unset means disabled.
- Add `bgrm_applied boolean not null default false` to `character_visual_combinations`.
- Existing rows must naturally become `false` because they predate BGRM.
- Replace the current uniqueness identity with one that also includes `bgrm_applied`.
- Preserve all existing raw URLs; do not recook or delete them.

#### `orchestrator/src/io/orchestratorSettings.ts`

- Add both BGRM setting names to the typed legal setting vocabulary.
- Document that both are live-read and default false when absent.
- Do not add hidden defaults that automatically enable BGRM.

#### `orchestrator/scripts/verify-character-visual-state.mjs`

At this task boundary, add migration/schema-level verification that:

- existing-style raw rows are represented as `bgrm_applied = false`;
- one raw and one BGRM row may coexist for the same character/outfit/expression;
- duplicate rows with the same BGRM state are rejected/merged according to the eventual upsert key;
- the two new settings are legal.

Do not implement autofire BGRM behaviour in this task.

### Acceptance Criteria

- **T2.1-AC01:** Both BGRM setting keys are valid persisted settings and remain disabled when absent.
- **T2.1-AC02:** Every pre-existing character visual combination is semantically raw after migration.
- **T2.1-AC03:** Raw and transparent variants of one character/outfit/expression can coexist.
- **T2.1-AC04:** Two rows with the same character/outfit/expression/BGRM-state identity cannot coexist unintentionally.
- **T2.1-AC05:** No existing character image URL is deleted, modified, or regenerated by migration.
- **T2.1-AC06:** No location image schema changes occur.

### Verification

**Automated:**
- Apply migrations in the repository's verification database path.
- Extend `verify-character-visual-state.mjs` with schema/state assertions.
- Run typecheck/check.

**Runtime/manual:**
- None required.

### Constraints & Anti-Patterns

- Do not seed settings as true.
- Do not add image byte/blob columns.
- Do not modify location image combination tables.
- Do not change existing character/outfit/expression normalization.
- Do not bulk regenerate existing assets.

### API Delta

Database:

```text
character_visual_combinations.bgrm_applied boolean not null default false
```

Cache identity becomes:

```text
user_id + chat_id + character_id + outfit_key + expression_key + bgrm_applied
```

Settings vocabulary adds:

```text
portrait_bgrm_enabled
character_visual_bgrm_enabled
```

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Canonical schema, persistence identity, and settings model changes (rubric 4 and 5).

### Task Completion Boundary

The task is complete when the database can faithfully represent BGRM enablement and both raw/transparent RP character-image assets without any orchestration yet depending on those fields.

---

## Task 2.2 — Add the Admin BGRM Settings HTTP Contract

### Objective

Provide a small typed admin settings domain and authenticated HTTP resource for reading/updating the two character-image BGRM enablement toggles.

### Architectural Intent

Keeps runtime configuration database-backed and separate from engine-profile configuration. Connections determine how BGRM runs; Settings determines where BGRM is enabled.

### Scope

**Create:**
- `orchestrator/src/server/admin/bgrmSettings.ts`

**Modify:**
- `orchestrator/src/server/adminServer.ts`
- `orchestrator/src/server/handleAdminDisplaySettings.ts`
- `orchestrator/src/server/httpServer.ts`
- `orchestrator/scripts/verify-server.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/io/orchestratorSettings.ts`
- existing admin settings modules and auth wrapper

### Required Logical Changes

#### `orchestrator/src/server/admin/bgrmSettings.ts`

- Own read/parse/write logic for the two BGRM settings.
- Public read shape:
  - `portraitStudioEnabled: boolean`;
  - `characterAutofireEnabled: boolean`.
- Missing persisted values resolve to false.
- Accept a strict partial update for either or both booleans.
- Reject malformed/non-boolean values using existing admin settings error conventions.
- Do not perform provider calls or resolve image connections here.

#### `orchestrator/src/server/adminServer.ts`

- Re-export the BGRM settings domain through the existing façade.
- Do not add logic.

#### `orchestrator/src/server/handleAdminDisplaySettings.ts`

- Add GET/POST handlers delegating to the BGRM settings domain.
- Follow existing admin settings response/error conventions.

#### `orchestrator/src/server/httpServer.ts`

Register authenticated routes:

```text
GET  /v1/admin/bgrm-settings
POST /v1/admin/bgrm-settings
```

#### `orchestrator/scripts/verify-server.mjs`

Verify:

- defaults are false when unset;
- GET returns both booleans;
- POST may update one or both;
- malformed values are rejected;
- authentication behaviour matches sibling admin settings routes.

### Acceptance Criteria

- **T2.2-AC01:** GET returns two explicit booleans and defaults both to false.
- **T2.2-AC02:** POST supports strict partial updates without overwriting omitted setting values.
- **T2.2-AC03:** Invalid non-boolean values are rejected deterministically.
- **T2.2-AC04:** The routes use the existing admin authentication boundary.
- **T2.2-AC05:** The settings API does not resolve or call BGRM providers.

### Verification

**Automated:**
- Extend `node orchestrator/scripts/verify-server.mjs`.
- Run typecheck/check.
- Run build.

**Runtime/manual:**
- None required.

### Constraints & Anti-Patterns

- No provider logic in settings modules.
- No connection picker or connection ID persistence.
- Do not duplicate generic setting storage machinery.
- Preserve existing admin auth/error conventions.

### API Delta

New HTTP resource:

```text
GET  /v1/admin/bgrm-settings
POST /v1/admin/bgrm-settings
```

Read shape:

```ts
{
  portraitStudioEnabled: boolean;
  characterAutofireEnabled: boolean;
}
```

Patch shape is strict partial of those booleans.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Persistent settings and authenticated server API boundary (rubric 5 and 6).

### Task Completion Boundary

The task is complete when the two settings can be safely read and updated over the existing authenticated admin HTTP surface, independently of any frontend or image-generation integration.

---

## Task 2.3 — Add the Settings UI Toggles

### Objective

Expose independent Portrait Studio and RP character-image BGRM toggles in the existing Settings view, while leaving engine profile/model/key management in Connections.

### Architectural Intent

Makes BGRM explicitly opt-in per character-image surface and preserves the architectural split between engine configuration and feature enablement.

### Scope

**Create:**
- `frontend/src/components/settings/BgrmSettingsPanel.tsx`

**Modify:**
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/views/SettingsView.tsx`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `frontend/src/views/ConnectionsView.tsx`
- `frontend/src/components/connections/ImageConnectionEditor.tsx`

### Required Logical Changes

#### `frontend/src/api/types.ts`

- Add frontend types matching the BGRM settings GET/POST contract.

#### `frontend/src/api/client.ts`

- Add typed GET/POST client helpers following existing admin-header conventions.

#### `frontend/src/components/settings/BgrmSettingsPanel.tsx`

- Own loading, display, mutation, and error state for the two BGRM toggles.
- Render independent controls for:
  - Portrait Studio;
  - RP character portraits/autofire.
- State clearly that the active Background Removal engine is configured in Connections.
- Do not expose model, API key, provider kind, dimensions, CFG, sampler, or other engine fields here.
- Keep the panel practical on narrow/mobile widths.

#### `frontend/src/views/SettingsView.tsx`

- Mount the new panel in the unlocked household runtime settings area.
- Do not inline the panel's state machine into the already-large view.

### Acceptance Criteria

- **T2.3-AC01:** Each character-image BGRM surface can be enabled/disabled independently.
- **T2.3-AC02:** Both toggles initially render the server's false defaults when unset.
- **T2.3-AC03:** Updating one toggle does not alter the other.
- **T2.3-AC04:** The UI does not expose engine configuration duplicated from Connections.
- **T2.3-AC05:** The controls remain usable at phone width.

### Verification

**Automated:**
- Frontend typecheck/check.
- Frontend/project build.

**Runtime/manual:**
- Open Settings at desktop width and phone-width responsive layout.
- Toggle each setting independently and reload to confirm persistence.
- Confirm Connections remains the only place to edit the BGRM profile/model/key.

### Constraints & Anti-Patterns

- No connection selector.
- No BGRM model or secret fields in Settings.
- No unrelated SettingsView refactor.
- Do not move existing engine profile controls out of Connections.

### API Delta

Frontend mirrors the new BGRM settings read/patch HTTP contract.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** Bounded presentation/client integration over an already-defined server contract.

### Task Completion Boundary

The task is complete when users can persistently and independently opt Portrait Studio and RP character imagery into BGRM from Settings without configuring provider details there.

---

# Phase 3 — Apply BGRM to Every Portrait Studio Character Render

**Phase objective:**  
Make Portrait Studio Generate, Preview, and Retry use the shared BGRM capability when enabled, while preserving candidate success semantics and existing generation behaviour when disabled.

**Phase completion condition:**  
Every Portrait Studio character-image render obeys `portrait_bgrm_enabled`; BGRM success stores/returns the transparent URL, while BGRM failure preserves the raw successful render.

## Task 3.1 — Integrate BGRM Into Portrait Studio Generate, Preview, and Retry

### Objective

Route all Portrait Studio image-render paths through reference-aware generation and optional shared BGRM post-processing.

### Architectural Intent

Delivers the first user-facing BGRM consumer without embedding provider-specific post-processing inside Portrait Studio.

### Scope

**Create:**
- None

**Modify:**
- `orchestrator/src/orchestrator/portraitGeneration.ts`
- `orchestrator/scripts/verify-portrait-telemetry.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/orchestrator/characterImagePostProcess.ts`
- `orchestrator/src/io/orchestratorSettings.ts`
- `orchestrator/src/io/imageConnections.ts`
- `orchestrator/src/io/imageGen/index.ts`

### Required Logical Changes

#### `orchestrator/src/orchestrator/portraitGeneration.ts`

Apply the setting to all three render paths:

1. candidate generation rounds;
2. mutation-free Preview;
3. failed-candidate Retry.

For each path:

- read `portrait_bgrm_enabled` using existing runtime-setting semantics;
- when disabled, perform reference-aware generation but use the generated URL directly with zero BGRM call;
- when enabled, resolve the active `bgrm` profile and pass the generated result through `characterImagePostProcess`;
- use the returned effective URL downstream.

Candidate rounds:

- resolve BGRM enablement and active BGRM profile once per round, not per candidate;
- preserve existing candidate parallelism;
- one candidate's BGRM failure must fall back independently to that candidate's raw URL;
- do not mark a candidate failed because BGRM failed;
- candidate failure remains generation failure.

Preview:

- generation success + BGRM failure still returns successful raw preview.

Retry:

- the BGRM setting at retry time governs the newly rendered asset;
- preserve existing retry/mutation semantics;
- do not create an extra mutation round merely because BGRM is enabled.

#### `orchestrator/scripts/verify-portrait-telemetry.mjs`

Add deterministic scenarios covering:

- BGRM disabled → zero BGRM calls and raw URL;
- BGRM enabled + Runware generation → UUID reaches BGRM;
- BGRM enabled + URL-only generation → URL reaches BGRM;
- BGRM success → candidate/preview/retry uses transparent URL;
- BGRM failure → candidate/preview/retry remains successful with raw URL;
- generation call occurs exactly once per render attempt even when BGRM fails;
- candidate round parallelism/count semantics do not change.

### Acceptance Criteria

- **T3.1-AC01:** Portrait Studio Generate performs no BGRM call when the setting is off.
- **T3.1-AC02:** Portrait Studio Generate uses the BGRM URL when enabled and BGRM succeeds.
- **T3.1-AC03:** BGRM failure never marks an otherwise successful candidate failed.
- **T3.1-AC04:** Preview obeys the same enablement and fail-open rules.
- **T3.1-AC05:** Retry obeys the current setting and same fail-open rules.
- **T3.1-AC06:** Runware generation passes its native ref to BGRM; URL-only providers pass URL.
- **T3.1-AC07:** BGRM failure never causes image regeneration.
- **T3.1-AC08:** Existing generation-round concurrency and mutation semantics remain intact.

### Verification

**Automated:**
- Extend `node orchestrator/scripts/verify-portrait-telemetry.mjs`.
- Run image connection/BGRM verifier as dependency regression coverage.
- Run typecheck/check.
- Run build.

**Runtime/manual:**
- Optional smoke test with a configured Runware BGRM profile: one Studio candidate with setting off and one with setting on.

### Constraints & Anti-Patterns

- Do not duplicate `removeBackground()` calls directly in Portrait Studio.
- Do not resolve BGRM profile once per candidate.
- Do not turn BGRM failure into candidate failure.
- Do not alter mutation rules, prompt composition, image dimensions, or model selection.
- Do not touch location image generation.

### API Delta

No required public HTTP result-shape change. Internal generation uses the reference-aware result and shared postprocessor.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Core generation orchestration, concurrency, external IO, and persisted candidate results (rubric 2 and 5).

### Task Completion Boundary

The task is complete when all Portrait Studio render paths share identical optional BGRM semantics and the Studio remains fully functional with BGRM disabled, unavailable, or failing.

---

# Phase 4 — Apply BGRM to RP Character Imagery and Preserve URL Reuse

**Phase objective:**  
Make RP character visual autofire BGRM-aware while preserving the existing URL-mapping philosophy, avoiding unnecessary regenerations, and keeping raw fallbacks retryable.

**Phase completion condition:**  
RP character-image cache lookup, in-flight dedupe, generation, BGRM, and persistence all distinguish actual BGRM state correctly.

## Task 4.1 — Integrate BGRM-Aware Cache and Post-Processing Into Character Visual Autofire

### Objective

Apply optional BGRM to RP character images and extend the current cache/upsert logic so raw and transparent assets are correctly reused without cache poisoning.

### Architectural Intent

Delivers BGRM to the RP character-image system only. It preserves the app's core model of storing URLs rather than image files and avoids paying for a new generation when an existing raw URL can simply be background-removed.

### Scope

**Create:**
- None

**Modify:**
- `orchestrator/src/orchestrator/characterVisualAutofire.ts`
- `orchestrator/scripts/verify-character-visual-state.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/orchestrator/characterImagePostProcess.ts`
- `orchestrator/src/io/orchestratorSettings.ts`
- `orchestrator/src/io/imageConnections.ts`
- `db/migrations/0132_character_image_bgrm.sql`
- `orchestrator/src/orchestrator/generateLocationImage.ts`

### Required Logical Changes

#### `orchestrator/src/orchestrator/characterVisualAutofire.ts`

Read `character_visual_bgrm_enabled` before cache selection.

##### Requested cache identity

- Setting off → request `bgrm_applied = false`.
- Setting on → request `bgrm_applied = true`.
- Add requested BGRM mode to the in-memory `combinationInFlight` key so simultaneous raw and transparent requests do not suppress one another.

##### Transparent cache hit

When BGRM is enabled and an exact `bgrm_applied = true` row exists:

- return as the normal cache hit;
- perform no generation and no BGRM call.

##### Raw cache hit when BGRM is disabled

When BGRM is disabled and `bgrm_applied = false` exists:

- return as the normal cache hit;
- perform no generation.

##### Raw-source reuse when BGRM is enabled

When no transparent variant exists but a raw row exists for the same character/outfit/expression:

- reuse its `image_url` as the source for BGRM;
- do not regenerate the character portrait;
- run the existing stale/drop protection as appropriate before spending the BGRM call;
- on BGRM success, persist a new `bgrm_applied = true` row;
- preserve the original raw row.

##### Fresh generation

When no suitable raw source exists:

- perform the existing character prompt/mint/composition flow unchanged;
- generate through the reference-aware image generation API;
- when BGRM is disabled, persist the raw URL with `bgrm_applied = false`;
- when enabled, pass through shared post-processing;
- persist using the **actual** returned `bgrmApplied` state.

##### BGRM failure

If generation succeeded but BGRM failed:

- the raw URL remains usable;
- persist/cache it only as `bgrm_applied = false`;
- never write it under the `true` identity;
- a later enabled request must be free to attempt BGRM again using that raw URL;
- do not regenerate solely because BGRM failed.

##### Upsert

Update the SQL conflict target to include `bgrm_applied` in accordance with migration 0132.

Do not change:

- subject minting;
- expression minting;
- outfit normalization;
- prompt composition;
- active portrait generation engine selection;
- fire-and-forget/no-throw contract.

#### `orchestrator/scripts/verify-character-visual-state.mjs`

Add deterministic scenarios for:

- setting off + raw cache hit → no provider call;
- setting on + transparent cache hit → no provider/BGRM call;
- setting on + raw cache exists → no generation, one BGRM call, transparent row added;
- setting on + no cache → one generation + one BGRM call;
- Runware generated result → UUID used immediately for BGRM;
- URL-only result → URL used;
- BGRM failure → raw row only, no transparent row;
- subsequent enabled call after failure → retries BGRM from cached raw URL without regenerating;
- raw and transparent rows coexist;
- in-flight dedupe distinguishes requested BGRM mode;
- location/chat background tables and generation calls remain untouched.

### Acceptance Criteria

- **T4.1-AC01:** RP character BGRM is controlled only by `character_visual_bgrm_enabled`.
- **T4.1-AC02:** Exact raw/transparent cache hits incur zero unnecessary provider cost.
- **T4.1-AC03:** An existing raw URL may be upgraded to a transparent cached variant without regenerating the character image.
- **T4.1-AC04:** A BGRM failure stores/reuses the asset only as raw and cannot poison the transparent cache identity.
- **T4.1-AC05:** A later enabled request after BGRM failure retries BGRM without requiring a new generation.
- **T4.1-AC06:** Raw and transparent URLs for the same visual combination may coexist.
- **T4.1-AC07:** Runware native ref is used for immediate post-processing when available; cached/raw URL is sufficient for later post-processing.
- **T4.1-AC08:** The fire-and-forget autofire pipeline remains no-throw/fail-open.
- **T4.1-AC09:** Location/chat background generation is never invoked or altered by this feature.

### Verification

**Automated:**
- Extend `node orchestrator/scripts/verify-character-visual-state.mjs` with all cache/BGRM scenarios.
- Run image connection/BGRM verifier.
- Run typecheck/check.
- Run build.

**Runtime/manual:**
- Optional RP smoke test: generate one character combination raw, enable BGRM, trigger/revisit the same combination, verify transparent URL is created without a second generation.

### Constraints & Anti-Patterns

- Do not delete or overwrite the raw row when producing the transparent row.
- Do not write a raw fallback under `bgrm_applied = true`.
- Do not regenerate if a raw source URL already exists and only BGRM is missing.
- Do not merge location-background cache concepts into character imagery.
- Do not change character visual-state parsing/minting semantics.
- Preserve the module's never-throw contract.

### API Delta

Persistence lookup/upsert identity now includes `bgrm_applied`.

External function remains:

```ts
renderCharacterVisualCombination(...) -> Promise<void>
```

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** Core domain logic, cache identity, persistence, in-flight concurrency, and provider IO (rubric 1, 2, 4, and 5).

### Task Completion Boundary

The task is complete when RP character imagery can independently produce/reuse raw and transparent URL variants with no cache poisoning, unnecessary regeneration, or interaction with the location-background subsystem.

---

## 4. Cross-Task Dependency Ledger

| Task | Depends on | Dependency |
| --- | --- | --- |
| `1.2` | `1.1` | `GeneratedImage` and the reference-aware generation contract exist |
| `2.2` | `2.1` | BGRM setting names are legal in persistence and typed settings vocabulary |
| `2.3` | `2.2` | Stable authenticated BGRM settings HTTP contract exists |
| `3.1` | `1.1` | Portrait generation can obtain URL + optional provider ref |
| `3.1` | `1.2` | Shared fail-open character-image BGRM helper exists |
| `3.1` | `2.1` | `portrait_bgrm_enabled` exists |
| `4.1` | `1.1` | Autofire can obtain URL + optional provider ref |
| `4.1` | `1.2` | Shared fail-open character-image BGRM helper exists |
| `4.1` | `2.1` | `character_visual_bgrm_enabled` and `bgrm_applied` persistence exist |

Tasks `3.1` and `4.1` do not depend on the Settings UI task `2.3`; they depend only on the persisted settings contract. They may proceed independently once their backend prerequisites are complete.

## 5. Architectural Acceptance Criteria Traceability

| Architectural AC | Implementation coverage |
| --- | --- |
| `AC-01` | `T1.2`, `T3.1`, `T4.1` |
| `AC-02` | `T1.1`, `T1.2`, `T3.1`, `T4.1` |
| `AC-03` | `T1.1`, `T1.2`, `T3.1`, `T4.1` |
| `AC-04` | `T1.1`, `T1.2` |
| `AC-05` | `T1.1`, `T1.2` |
| `AC-06` | `T1.2`, `T3.1`, `T4.1` |
| `AC-07` | `T2.1`, `T3.1`, `T4.1` |
| `AC-08` | `T1.2`, `T3.1`, `T4.1` |
| `AC-09` | `T1.2`, `T3.1`, `T4.1` |
| `AC-10` | `T1.2` plus existing Chunk 1 adapter verification |
| `AC-11` | Existing Chunk 1 BGRM profile capability; regression gate |
| `AC-12` | Existing Chunk 1 independent activation verification; regression gate |
| `AC-13` | `T2.1`, `T2.3`, `T3.1`, `T4.1` |
| `AC-14` | `T2.3`, `T3.1` |
| `AC-15` | `T2.3`, `T4.1` |
| `AC-16` | `T2.1`, `T4.1` |
| `AC-17` | `T1.2`, `T3.1`, `T4.1` |
| `AC-18` | Existing Chunk 1 connection secret handling; regression gate |
| `AC-19` | `T1.2`, `T3.1`, `T4.1` |
| `AC-20` | All tasks preserve the existing engine-profile architecture; final diff review |

## 6. Blueprint File Coverage Ledger

Every Blueprint create/modify file is assigned to at least one task.

| Blueprint file | Task |
| --- | --- |
| `db/migrations/0132_character_image_bgrm.sql` | `2.1` |
| `orchestrator/src/orchestrator/characterImagePostProcess.ts` | `1.2` |
| `orchestrator/src/server/admin/bgrmSettings.ts` | `2.2` |
| `frontend/src/components/settings/BgrmSettingsPanel.tsx` | `2.3` |
| `orchestrator/src/io/imageGen/types.ts` | `1.1` |
| `orchestrator/src/io/imageGen/runware.ts` | `1.1` |
| `orchestrator/src/io/imageGen/index.ts` | `1.1` |
| `orchestrator/src/orchestrator/portraitGeneration.ts` | `3.1` |
| `orchestrator/src/orchestrator/characterVisualAutofire.ts` | `4.1` |
| `orchestrator/src/io/orchestratorSettings.ts` | `2.1` |
| `orchestrator/src/server/adminServer.ts` | `2.2` |
| `orchestrator/src/server/handleAdminDisplaySettings.ts` | `2.2` |
| `orchestrator/src/server/httpServer.ts` | `2.2` |
| `frontend/src/api/types.ts` | `2.3` |
| `frontend/src/api/client.ts` | `2.3` |
| `frontend/src/views/SettingsView.tsx` | `2.3` |
| `orchestrator/scripts/verify-image-connections.mjs` | `1.1`, `1.2` |
| `orchestrator/scripts/verify-character-visual-state.mjs` | `2.1`, `4.1` |
| `orchestrator/scripts/verify-portrait-telemetry.mjs` | `3.1` |
| `orchestrator/scripts/verify-server.mjs` | `2.2` |

No Blueprint delete files exist.

## 7. Final Integration Verification

After all task-level verification and independent reviews pass, run one final integration gate against the complete BGRM feature.

### Required automated checks

Run the repository's canonical versions of:

- project typecheck/check;
- project build;
- `node orchestrator/scripts/verify-image-connections.mjs`;
- `node orchestrator/scripts/verify-character-visual-state.mjs`;
- `node orchestrator/scripts/verify-portrait-telemetry.mjs`;
- `node orchestrator/scripts/verify-server.mjs`;
- full `npm run verify` (or the repository's current equivalent) when practical.

### Required integration scenarios

1. **Portrait Studio, BGRM off**
   - active BGRM profile exists;
   - Studio toggle off;
   - generation succeeds;
   - zero BGRM calls;
   - raw URL used.

2. **Portrait Studio, Pollinations-style source, BGRM on**
   - generated URL is passed directly to Runware;
   - no image download/upload through BigImagine;
   - transparent URL becomes candidate URL.

3. **Portrait Studio, Runware source, BGRM on**
   - Runware UUID is passed to Runware BGRM;
   - transparent URL becomes candidate URL.

4. **Portrait Studio BGRM failure**
   - generation called once;
   - raw URL remains successful candidate/preview/retry result;
   - failure observable in logs.

5. **RP character imagery, BGRM off**
   - raw cache identity used;
   - transparent row does not substitute for raw mode.

6. **RP character imagery, BGRM on with existing raw URL**
   - no new image generation;
   - raw URL submitted to BGRM;
   - transparent row added alongside raw row.

7. **RP character BGRM failure and retry**
   - raw URL stored only under `bgrm_applied = false`;
   - no false transparent cache hit;
   - next enabled request retries BGRM from raw URL without regenerating.

8. **Location/chat backgrounds regression**
   - no BGRM calls occur in `generateLocationImage` paths;
   - location combination/TOD behaviour remains unchanged.

9. **Settings and profile independence**
   - active BGRM engine profile may exist while both toggles are off;
   - each toggle changes only its own character-image surface;
   - portrait/background generation profiles remain independently active.

### Final diff review

The integration reviewer must explicitly confirm:

- no unrelated refactors;
- no image byte/blob persistence was introduced;
- no local fetch/download/re-upload path was introduced;
- no BGRM logic was added to location backgrounds;
- existing engine-profile architecture remains intact;
- no provider-native UUID is persisted unnecessarily;
- every Blueprint file is accounted for;
- every API Delta matches the finalized Blueprint;
- every Architectural Report acceptance criterion is satisfied or covered by an existing Chunk 1 regression guarantee.

### Final Review Inputs

The integration reviewer must receive:

1. `docs/plans/bgrm/1_ARCHITECTURAL_REPORT.md`
2. `docs/plans/bgrm/2_BLUEPRINT.md`
3. `docs/plans/bgrm/3_IMPLEMENTATION_PLAN.md`
4. full implementation diff
5. deterministic verification results

Final review question:

**Did the completed implementation faithfully deliver character-image background removal without leaking BGRM into generation ownership, location backgrounds, or image-byte persistence?**
