# Blueprint — Character Image Background Removal

> Purpose: translate the approved Background Removal Architectural Report into a repository-grounded definition of **what must change**.
>
> Scope clarification from repository discovery: BGRM applies only to **character imagery**. BigImagine's location/chat-background pipeline is a separate subsystem and is not part of this feature.

---

# 1. Repository Findings

## 1.1 Chunk 1 is already present

The initial BGRM capability has landed successfully.

Current repository state includes:

- `ImageConnectionPurpose = 'background' | 'portrait' | 'bgrm'`;
- one independently active connection per purpose;
- a database constraint restricting `purpose = 'bgrm'` to `kind = 'runware'`;
- Connections UI support for creating/editing/activating a Runware BGRM engine profile;
- generation-only BGRM fields hidden in the connection editor;
- the normal image-generation Test action disabled for BGRM profiles;
- `removeBackground()` as a standalone Runware IO adapter;
- URL and Runware-image-reference inputs passed directly to Runware;
- no local image download/upload/storage.

The landed adapter is correctly separate from the generator factory and already returns the transparent Runware CDN URL.

These pieces should be reused, not redesigned.

---

## 1.2 Current image generation returns URL only

The common image-generation contract is currently:

```ts
ImageGenProvider.generate(req) -> Promise<string>
```

The returned string is the generated CDN URL.

Runware's generator also currently discards the provider-native image UUID even though the Runware response can carry it.

Therefore the application currently cannot satisfy the architecture's preferred path:

```text
Runware generation
      ↓
Runware image UUID
      ↓
Runware BGRM
```

without extending the generation IO boundary.

This should be done **additively**, rather than breaking every current image-generation consumer.

The existing string-returning generation contract is used by:

- location background generation;
- Portrait Studio;
- RP character visual autofire;
- admin connection diagnostics.

Location backgrounds must remain behaviourally untouched.

---

## 1.3 Character images have two actual generation owners

There are two character-image paths requiring BGRM integration.

### Portrait Studio

`orchestrator/src/orchestrator/portraitGeneration.ts`

Owns three character-image render paths:

1. candidate generation rounds;
2. mutation-free Preview;
3. failed-candidate Retry.

All three resolve the active `portrait` image engine profile and call the common image-generation provider.

All three must respect the Portrait Studio BGRM setting.

### RP character imagery

`orchestrator/src/orchestrator/characterVisualAutofire.ts`

Owns RP character portrait generation from:

- Subject;
- Outfit;
- Expression;
- Style;
- Format.

It uses the active `portrait` image generation profile, renders one image, and writes the URL into `character_visual_combinations`.

This is the RP BGRM integration point.

`generateLocationImage.ts` is **not** an RP character-image path and must not perform BGRM.

---

## 1.4 RP character images already have a URL mapping/cache

`character_visual_combinations` is the RP character-image cache.

Current identity is:

```text
user
+ chat
+ character
+ outfit
+ expression
```

and the row stores:

```text
image_url
composed_prompt
```

This is exactly the URL-only reuse model the BGRM feature should preserve.

However, the existing key cannot distinguish:

```text
Amy + blue dress + happy → original image
```

from:

```text
Amy + blue dress + happy → background-removed image
```

If BGRM were inserted without changing this identity, an old raw image could permanently satisfy a BGRM-enabled lookup.

The cache therefore needs one additional **actual asset-state dimension**:

```text
bgrm_applied
```

giving:

```text
character + outfit + expression + bgrm_applied
```

This remains a URL mapping. No image bytes or blobs are introduced.

A raw and transparent version of the same visual combination may therefore coexist when both have legitimately been produced.

---

## 1.5 BGRM failure must not poison the BGRM cache

A generation can succeed while BGRM fails.

In that case the raw URL is valid and remains usable.

However, the raw fallback must **not** subsequently satisfy a cache request for:

```text
bgrm_applied = true
```

Otherwise one transient Runware BGRM failure would permanently disable background removal for that visual combination.

Therefore:

- successful BGRM result → `bgrm_applied = true`;
- raw image, whether BGRM was disabled or failed → `bgrm_applied = false`.

A later BGRM-enabled lookup only considers the `true` variant a completed BGRM cache hit.

If a raw variant already exists, it may be reused as the source URL for another BGRM attempt without regenerating the character image.

---

## 1.6 Portrait Studio does not need a new cache identity

`visual_candidates` represents generation attempts rather than reusable visual-combination mappings.

Each candidate already owns its own `image_url`.

Therefore BGRM does not require a new candidate-key dimension.

The effective URL stored on the candidate should simply be:

- raw generation URL when BGRM is disabled;
- transparent Runware URL on BGRM success;
- raw generation URL on BGRM failure.

Preview remains disposable and persists no candidate.

Retry continues to update the existing candidate's `image_url`.

---

## 1.7 Two independent BGRM enablement settings are required

The approved architecture says an active BGRM engine profile alone must **not** globally change every character render.

The two character-image consumers therefore require separate runtime settings:

```text
portrait_bgrm_enabled
character_visual_bgrm_enabled
```

Both default to false when unset.

Meaning:

```text
portrait_bgrm_enabled
    → Portrait Studio Generate / Preview / Retry

character_visual_bgrm_enabled
    → RP character visual autofire
```

The active BGRM engine profile remains selected through the existing Connections architecture.

These toggles answer **whether to use BGRM**.

The active `purpose = bgrm` profile answers **how to perform BGRM**.

---

## 1.8 Settings UI already has an appropriate ownership boundary

`SettingsView.tsx` is the household runtime-settings surface.

The Connections tab already owns BGRM engine profiles.

Therefore the clean user-facing split is:

```text
Connections
    → configure + activate Runware BGRM engine profile

Settings
    → enable BGRM for:
       [ ] Portrait Studio
       [ ] RP character portraits
```

No connection picker is required.

---

## 1.9 Existing verification is usable

Relevant existing verification includes:

- `verify-image-connections.mjs`
  - image connection purpose separation;
  - Runware request shape;
  - BGRM adapter URL/UUID pass-through;
  - BGRM adapter failure handling.

- `verify-character-visual-state.mjs`
  - RP visual state;
  - autofire;
  - character visual combination caching.

- `verify-portrait-telemetry.mjs`
  - Portrait Studio generation/image-call behaviour.

- `verify-server.mjs`
  - HTTP route-level behaviour.

These should be extended rather than replacing the existing harness.

---

# 2. Core Scope & Changes

## File: `orchestrator/src/io/imageGen/types.ts`

**Current responsibility:**  
Defines the common request object passed to every image-generation adapter.

**Required logical change:**  
Add a generated-image result shape capable of carrying both:

```text
imageUrl
providerImageRef?
```

The optional provider-native reference exists specifically so a consumer that performs post-processing can use a stronger provider-native identity when available.

A URL remains mandatory.

A provider-native reference remains optional.

**Reason this file is core:**  
The architecture requires BGRM to consume an existing image reference and prefer a Runware UUID when available.

**API Delta Ledger:**

- **Symbol:** `GeneratedImage`
- **Before:** Does not exist.
- **After:** Common generated-image result containing the usable URL and optional provider-native reference.
- **Reason:** Allows post-processing without forcing every generator to expose provider-specific identifiers.

---

## File: `orchestrator/src/io/imageGen/runware.ts`

**Current responsibility:**  
Calls Runware `imageInference` and returns only its CDN image URL.

**Required logical change:**  
Preserve the existing URL-returning generation API for current callers while adding an additive generation path that also retains Runware's returned image UUID.

The detailed Runware result becomes:

```text
imageUrl
providerImageRef = Runware image UUID
```

when Runware supplies one.

The existing URL-only generation function remains available and behaviourally unchanged.

**Reason this file is core:**  
This is the only place where the Runware-native UUID exists and therefore the only correct place to capture it.

**API Delta Ledger:**

- **Symbol:** existing `generateRunwareImage`
- **Before:** returns URL string.
- **After:** remains URL-string compatible.
- **Reason:** Avoid unrelated breakage.

- **Symbol:** new detailed Runware generation API
- **Before:** Does not exist.
- **After:** returns `GeneratedImage`.
- **Reason:** Exposes the Runware UUID without leaking Runware response parsing into orchestration.

---

## File: `orchestrator/src/io/imageGen/index.ts`

**Current responsibility:**  
Provider-dispatch factory for the existing URL-only image-generation contract.

**Required logical change:**  
Add an additive generic generation entry point for consumers requiring a post-processing reference.

Behaviour:

```text
Runware
    → detailed Runware generation
    → URL + UUID when available

Other providers
    → existing generation
    → URL + no provider-native ref
```

The existing:

```ts
createImageGenProvider(...).generate() -> string
```

remains unchanged.

**Reason this file is core:**  
Provider-specific generation differences must remain inside the image IO dispatch boundary, not leak into Portrait Studio or RP orchestration.

**API Delta Ledger:**

- **Symbol:** existing `ImageGenProvider.generate`
- **Before:** URL string.
- **After:** unchanged.

- **Symbol:** new reference-aware generation function
- **Before:** Does not exist.
- **After:** returns `GeneratedImage`.
- **Reason:** Gives character-image pipelines one provider-neutral post-processing input.

---

## File: `orchestrator/src/orchestrator/characterImagePostProcess.ts`

**Status:** Create.

**Current responsibility:**  
Does not exist.

**Required logical change:**  
Own the shared **character-image BGRM orchestration seam**.

Input:

```text
generated image
active BGRM profile or absence
```

Decision:

```text
no usable BGRM profile
    → log fallback
    → raw URL

usable Runware BGRM profile
    → choose:
        providerImageRef when available
        otherwise imageUrl
    → call removeBackground()
```

Output must distinguish:

```text
imageUrl
bgrmApplied
```

Failure behaviour:

```text
removeBackground throws
    → log failure
    → return original generated URL
    → bgrmApplied = false
```

This module must not:

- generate images;
- inspect image bytes;
- download images;
- persist URLs;
- own surface enablement settings;
- know Portrait Studio or RP chat semantics.

**Reason this file is core:**  
Both character-image pipelines require exactly the same fail-open BGRM behaviour. Duplicating it would immediately create two provider-specific post-processing implementations.

**API Delta Ledger:**

New public character-image post-processing contract.

---

## File: `orchestrator/src/orchestrator/portraitGeneration.ts`

**Current responsibility:**  
Owns Portrait Studio Generate, Preview, and Retry image rendering.

**Required logical change:**

All three character-image render paths must:

1. read `portrait_bgrm_enabled`;
2. generate using the reference-aware image generation seam;
3. when disabled, use the generated URL directly;
4. when enabled:
   - resolve the active `bgrm` engine profile;
   - pass the generated image through the shared character-image postprocessor;
5. use the returned effective URL downstream.

For candidate rounds:

- resolve BGRM enablement/profile once per round rather than once per candidate;
- parallel candidate rendering may then reuse the same resolved profile;
- one candidate's BGRM failure falls back independently to that candidate's raw image;
- BGRM failure must **not** become `candidate.failed`;
- `candidate.failed` remains reserved for actual image-generation failure.

For Preview:

- successful generation + failed BGRM still returns a successful preview using the raw image.

For Retry:

- the current BGRM setting at retry time governs the newly rendered URL;
- no new mutation round is created.

**Reason this file is core:**  
It owns every Portrait Studio character render that must receive BGRM.

**API Delta Ledger:**

No required HTTP-facing result-shape change.

Internal candidate dispatch gains BGRM outcome state.

---

## File: `orchestrator/src/orchestrator/characterVisualAutofire.ts`

**Current responsibility:**  
Generates and caches RP character images keyed by character/outfit/expression.

**Required logical change:**

Read:

```text
character_visual_bgrm_enabled
```

before cache selection.

### Cache lookup

When disabled:

```text
lookup bgrm_applied = false
```

When enabled:

```text
lookup bgrm_applied = true
```

A matching requested variant is a normal cache hit.

### Optional raw-source reuse

When BGRM is enabled and no transparent variant exists:

- if a `bgrm_applied = false` row for the same character/outfit/expression already exists,
- use its `image_url` directly as the BGRM source,
- do not regenerate the portrait merely to background-remove it.

This preserves the application's URL-reuse philosophy.

### Fresh render

When no reusable source exists:

1. build the normal portrait prompt;
2. generate through the reference-aware image seam;
3. if BGRM is enabled, run the shared character-image postprocessor;
4. persist the effective URL with its **actual** `bgrm_applied` state.

If BGRM fails:

```text
raw URL remains usable
bgrm_applied = false
```

Therefore a later enabled request is still free to retry BGRM.

### In-flight identity

The in-memory render guard must include requested BGRM mode.

Otherwise an enabled and disabled request for the same visual combination could incorrectly suppress one another.

**Reason this file is core:**  
It owns the RP character-image lifecycle and cache.

**API Delta Ledger:**

`renderCharacterVisualCombination(...)` remains externally `Promise<void>`.

Its internal cache identity changes.

---

## File: `db/migrations/0132_character_image_bgrm.sql`

**Status:** Create.

**Current responsibility:**  
Does not exist.

**Required logical change:**

### Settings vocabulary

Widen `orchestrator_settings.key` to include:

```text
portrait_bgrm_enabled
character_visual_bgrm_enabled
```

Do not seed either setting.

Unset means false.

### Character image cache

Add:

```text
bgrm_applied boolean not null default false
```

to:

```text
character_visual_combinations
```

Existing rows become:

```text
bgrm_applied = false
```

because they predate BGRM.

Replace the current uniqueness:

```text
user_id
chat_id
character_id
outfit_key
expression_key
```

with:

```text
user_id
chat_id
character_id
outfit_key
expression_key
bgrm_applied
```

This allows at most:

```text
one raw URL
one BGRM URL
```

for an otherwise identical character visual combination.

No image data or binary media columns are introduced.

**Reason this file is core:**  
Persistence currently cannot represent the two derived forms required by AC-16.

**API Delta Ledger:**  
Database contract only.

---

## File: `orchestrator/src/io/orchestratorSettings.ts`

**Current responsibility:**  
Defines the complete legal runtime-settings vocabulary.

**Required logical change:**

Add:

```text
portrait_bgrm_enabled
character_visual_bgrm_enabled
```

to `SETTING_NAMES`.

Document:

- both are live-read;
- both default false when unset;
- one controls Studio;
- one controls RP character autofire.

**Reason this file is core:**  
Both character-image consumers require independently persisted enablement state.

**API Delta Ledger:**

- **Symbol:** `SettingName`
- **Before:** does not include BGRM enablement.
- **After:** includes both BGRM keys.
- **Reason:** Enables typed runtime reads/writes.

---

## File: `orchestrator/src/server/admin/bgrmSettings.ts`

**Status:** Create.

**Current responsibility:**  
Does not exist.

**Required logical change:**

Own the settings-store representation for character-image BGRM.

Public read shape:

```text
portraitStudioEnabled: boolean
characterAutofireEnabled: boolean
```

Both default false when their setting is absent.

Support a strict partial update for either/both values.

This module performs no BGRM provider calls.

**Reason this file is core:**  
The settings are one coherent domain and should not be scattered through Portrait, Character, or generic image-generation settings.

**API Delta Ledger:**

New BGRM settings read/parse/write contracts.

---

# 3. Dependency Discovery

## Discovered File Manifest

| File | Classification | Why it is affected |
| --- | --- | --- |
| `orchestrator/src/io/imageGen/removeBackground.ts` | Inspected / no change | Chunk 1 adapter already matches required BGRM IO contract |
| `orchestrator/src/io/imageConnections.ts` | Inspected / no change | `bgrm` purpose and independent active profile already implemented |
| `db/migrations/0131_image_connections_bgrm_purpose.sql` | Inspected / no change | BGRM engine profile schema already correct |
| `orchestrator/src/server/admin/imageConnections.ts` | Inspected / no change | BGRM profile validation already present |
| `frontend/src/components/connections/ImageConnectionEditor.tsx` | Inspected / no change | BGRM profile editor already implemented |
| `frontend/src/views/ConnectionsView.tsx` | Inspected / no change | BGRM active-profile display already implemented |
| `orchestrator/src/orchestrator/generateLocationImage.ts` | Inspected / no change | Location/chat backgrounds are explicitly outside BGRM |
| `db/migrations/0129_location_image_combinations.sql` | Inspected / no change | Location cache is unrelated |
| `orchestrator/src/io/imageGen/types.ts` | Core modification | Add reference-aware result type |
| `orchestrator/src/io/imageGen/runware.ts` | Core modification | Preserve Runware UUID |
| `orchestrator/src/io/imageGen/index.ts` | Core modification | Add provider-neutral reference-aware generation seam |
| `orchestrator/src/orchestrator/portraitGeneration.ts` | Core modification | Integrate BGRM into all Studio character renders |
| `orchestrator/src/orchestrator/characterVisualAutofire.ts` | Core modification | Integrate BGRM and BGRM-aware character cache |
| `orchestrator/src/io/orchestratorSettings.ts` | Core modification | Add two live settings |
| `orchestrator/src/server/adminServer.ts` | Collateral modification | Re-export new admin BGRM settings domain |
| `orchestrator/src/server/handleAdminDisplaySettings.ts` | Collateral modification | HTTP GET/POST handlers for Settings UI |
| `orchestrator/src/server/httpServer.ts` | Collateral modification | Register BGRM settings routes |
| `frontend/src/api/types.ts` | Collateral modification | Add BGRM settings response/patch types |
| `frontend/src/api/client.ts` | Collateral modification | Add BGRM settings GET/POST client |
| `frontend/src/components/settings/BgrmSettingsPanel.tsx` | Core UI creation | Own the two independent BGRM settings toggles |
| `frontend/src/views/SettingsView.tsx` | Collateral modification | Mount the new BGRM settings fieldset |
| `orchestrator/scripts/verify-image-connections.mjs` | Verification modification | Verify detailed Runware reference capture without regressing existing adapter |
| `orchestrator/scripts/verify-character-visual-state.mjs` | Verification modification | Verify RP BGRM/cache behaviour |
| `orchestrator/scripts/verify-portrait-telemetry.mjs` | Verification modification | Exercise Studio BGRM success/fallback without changing round semantics |
| `orchestrator/scripts/verify-server.mjs` | Verification modification | Verify BGRM settings HTTP surface |

---

# 4. Collateral Changes

## File: `orchestrator/src/server/adminServer.ts`

**Current responsibility:**  
Stable façade over modular `server/admin/*` domains.

**Fixing logic required:**  
Re-export the new BGRM settings module through the existing stable façade.

Do not implement logic here.

---

## File: `orchestrator/src/server/handleAdminDisplaySettings.ts`

**Current responsibility:**  
HTTP handlers for database-backed runtime settings surfaced in Settings.

**Fixing logic required:**  
Add admin GET/POST handlers delegating to the new BGRM settings domain.

No BGRM provider calls.

---

## File: `orchestrator/src/server/httpServer.ts`

**Current responsibility:**  
HTTP route table and dependency wiring.

**Fixing logic required:**

Register:

```text
GET  /v1/admin/bgrm-settings
POST /v1/admin/bgrm-settings
```

through the existing admin-auth wrapper.

No direct settings or BGRM implementation belongs here.

---

## File: `frontend/src/api/types.ts`

**Current responsibility:**  
Frontend HTTP contract definitions.

**Fixing logic required:**

Add:

```text
BgrmSettings
BgrmSettingsPatch
```

matching the admin endpoint.

---

## File: `frontend/src/api/client.ts`

**Current responsibility:**  
Typed frontend HTTP client.

**Fixing logic required:**

Add:

```text
adminGetBgrmSettings()
adminSetBgrmSettings()
```

using the existing admin auth-header conventions.

---

## File: `frontend/src/components/settings/BgrmSettingsPanel.tsx`

**Status:** Create.

**Current responsibility:**  
Does not exist.

**Fixing logic required:**

Render a small household-settings fieldset:

```text
Character image background removal

[x] Portrait Studio
[x] RP character portraits
```

The controls are independent.

The panel must not expose:

- BGRM model;
- API key;
- engine configuration.

Those belong to the active BGRM profile in Connections.

A short explanatory line should make the relationship clear:

```text
Uses the active Background Removal engine from Connections.
```

The panel must remain phone-width usable.

---

## File: `frontend/src/views/SettingsView.tsx`

**Current responsibility:**  
Household runtime settings.

**Fixing logic required:**  
Mount `BgrmSettingsPanel` in the existing unlocked Settings content.

Do not inline another large state machine into this already-large view.

---

# 5. Complete API Delta Ledger

## Image generation

### New `GeneratedImage`

```text
imageUrl: string
providerImageRef?: string
```

### Existing `ImageGenProvider.generate`

Unchanged:

```text
Promise<string>
```

### New reference-aware generation seam

```text
ImageConnectionProfile + ImageGenRequest
    → GeneratedImage
```

### Runware detailed result

Captures Runware UUID when present.

---

## Character-image BGRM

New shared post-processing result:

```text
imageUrl: string
bgrmApplied: boolean
```

BGRM errors fold into:

```text
original generated URL
bgrmApplied = false
```

rather than throwing through the character-image pipeline.

---

## Settings

New typed settings:

```text
portrait_bgrm_enabled
character_visual_bgrm_enabled
```

New admin HTTP resource:

```text
GET  /v1/admin/bgrm-settings
POST /v1/admin/bgrm-settings
```

---

## Persistence

`character_visual_combinations` gains:

```text
bgrm_applied boolean
```

and BGRM state joins its uniqueness identity.

No location/background persistence contracts change.

---

# 6. Verification Assessment

## File Verification

| File | Verification requirement | Reason |
| --- | --- | --- |
| `imageGen/types.ts` | Typecheck | Contract-only addition |
| `imageGen/runware.ts` | Extend mocked Runware verification | UUID extraction is provider-wire behaviour |
| `imageGen/index.ts` | Verify Runware detailed path + non-Runware URL fallback | Provider-neutral abstraction |
| `characterImagePostProcess.ts` | Deterministic mocked tests | Core fail-open behaviour |
| `portraitGeneration.ts` | Extend Portrait generation verification | Three character-render paths affected |
| `characterVisualAutofire.ts` | Extend character visual-state verifier | Cache identity and reuse change |
| `orchestratorSettings.ts` | Typecheck + settings route tests | New legal setting names |
| `admin/bgrmSettings.ts` | Parser/read/write tests | Persistent runtime configuration |
| `httpServer.ts` | Existing server verifier | New routes |
| `BgrmSettingsPanel.tsx` | Build + manual narrow-width UI check | Presentation/settings surface |
| `SettingsView.tsx` | Build + manual UI check | Component placement only |
| migration 0132 | Migration inspection + DB verification | Existing rows and uniqueness must remain valid |

---

## Behaviour Verification

| Acceptance Criterion | Verification method |
| --- | --- |
| `AC-01` | Shared postprocessor test proves BGRM occurs after generation, outside generator |
| `AC-02` | Existing `removeBackground` URL test + postprocessor URL-source scenario |
| `AC-03` | Runware generation mock returns image UUID; BGRM receives that exact UUID |
| `AC-04` | Non-Runware generated result has no native ref; BGRM receives URL |
| `AC-05` | Runware and Pollinations-style generated results pass through same postprocessor contract |
| `AC-06` | Success test asserts downstream URL is BGRM URL |
| `AC-07` | Disabled Studio/RP tests assert zero BGRM calls and original URL |
| `AC-08` | Forced BGRM failure returns raw image as successful render |
| `AC-09` | Failure test asserts generation called exactly once |
| `AC-10` | BGRM mock asserts no source fetch/upload occurs from BigImagine |
| `AC-11` | Existing image-connection verifier proves independent active `bgrm` purpose |
| `AC-12` | Existing activation tests prove portrait/background profiles unaffected |
| `AC-13` | Toggle-off tests prove active BGRM profile alone causes no BGRM call |
| `AC-14` | Portrait Studio enabled/disabled round + preview/retry scenarios |
| `AC-15` | Character visual autofire enabled/disabled scenarios |
| `AC-16` | RP cache tests prove raw row does not satisfy BGRM-enabled lookup and transparent/raw variants can coexist |
| `AC-17` | Forced missing-profile and provider-failure tests verify fallback + logging path |
| `AC-18` | Existing connection security tests remain authoritative |
| `AC-19` | Shared postprocessor test proves callers contain no Runware request construction |
| `AC-20` | Existing image profile architecture remains unchanged |
| `AC-21` | Existing location-image verification remains unchanged and passing |

---

# 7. Complete File Manifest

## Create

- `db/migrations/0132_character_image_bgrm.sql`
- `orchestrator/src/orchestrator/characterImagePostProcess.ts`
- `orchestrator/src/server/admin/bgrmSettings.ts`
- `frontend/src/components/settings/BgrmSettingsPanel.tsx`

## Modify

- `orchestrator/src/io/imageGen/types.ts`
- `orchestrator/src/io/imageGen/runware.ts`
- `orchestrator/src/io/imageGen/index.ts`
- `orchestrator/src/orchestrator/portraitGeneration.ts`
- `orchestrator/src/orchestrator/characterVisualAutofire.ts`
- `orchestrator/src/io/orchestratorSettings.ts`
- `orchestrator/src/server/adminServer.ts`
- `orchestrator/src/server/handleAdminDisplaySettings.ts`
- `orchestrator/src/server/httpServer.ts`
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/views/SettingsView.tsx`
- `orchestrator/scripts/verify-image-connections.mjs`
- `orchestrator/scripts/verify-character-visual-state.mjs`
- `orchestrator/scripts/verify-portrait-telemetry.mjs`
- `orchestrator/scripts/verify-server.mjs`

## Delete

None.

## Inspected but deliberately unchanged

- `orchestrator/src/io/imageGen/removeBackground.ts`
- `orchestrator/src/io/imageConnections.ts`
- `orchestrator/src/server/admin/imageConnections.ts`
- `frontend/src/components/connections/ImageConnectionEditor.tsx`
- `frontend/src/views/ConnectionsView.tsx`
- `db/migrations/0131_image_connections_bgrm_purpose.sql`
- `orchestrator/src/orchestrator/generateLocationImage.ts`
- `db/migrations/0129_location_image_combinations.sql`
- `frontend/src/components/sidebar/CharacterVisualStateToggle.tsx`
- `frontend/src/components/sidebar/PortraitConnectionPanel.tsx`
- `frontend/src/components/sidebar/Sidebar.tsx`

---

# 8. Blueprint Constraints & Risks

## 8.1 Do not route BGRM through the generator factory as a generator

`purpose = bgrm` remains an engine-profile classification.

The actual BGRM call remains:

```text
removeBackground()
```

not:

```text
createImageGenProvider(...).generate()
```

---

## 8.2 Do not apply BGRM to location backgrounds

No change to:

```text
generateLocationImage
location_image_combinations
location_swipe_images
background TOD behaviour
ChatView background rendering
```

This is a hard scope boundary.

---

## 8.3 Preserve the existing URL-only generation API

The repository has several mature consumers of:

```text
generate() -> string
```

The BGRM feature does not justify forcing location backgrounds and admin diagnostics through a new return type.

The reference-aware API must therefore be additive.

---

## 8.4 Do not persist Runware UUIDs merely for BGRM

The UUID is useful during the immediate generation → BGRM sequence.

The durable application artifact remains a URL.

If a previously cached raw image is background-removed later, its URL is a valid BGRM source.

No provider-native identifier persistence is required.

---

## 8.5 BGRM failure is not image-generation failure

Portrait Studio must not display a failed candidate merely because BGRM failed.

RP character autofire must not discard a successful generated URL merely because BGRM failed.

The raw URL remains valid.

---

## 8.6 Failed BGRM output must remain retryable

A raw fallback must be recorded as:

```text
bgrm_applied = false
```

never as the requested mode.

Otherwise the BGRM cache becomes poisoned by a transient failure.

---

## 8.7 Existing raw cache rows must survive migration

All pre-BGRM `character_visual_combinations` rows represent raw assets.

Migration default:

```text
bgrm_applied = false
```

preserves their semantics.

No existing URL should be deleted or regenerated during migration.

---

## 8.8 Active BGRM profile changes do not invalidate existing URLs

The active profile determines future BGRM operations.

Existing transparent URLs remain reusable.

Changing BGRM model/profile must not trigger a bulk recook.

---

## 8.9 Settings default off

Both BGRM feature toggles must be opt-in.

Deploying the migration must not suddenly run additional paid Runware calls.

---

## 8.10 Do not redesign Connections

The current engine-profile model remains authoritative for this feature.

Splitting provider credentials from engine configuration is a future architecture project.

---

# 9. Discovery Deviations

## Deviation 1 — “RP image surface” was initially too broad

**Architectural assumption:**  
The approved report referred generically to an RP image surface.

**Repository reality:**  
There are two entirely separate systems:

```text
RP character imagery
    → characterVisualAutofire.ts

location/chat backgrounds
    → generateLocationImage.ts
```

**Impact on Blueprint:**  
Only the first receives BGRM.

**Architectural intent remains valid:**  
Yes. This is scope clarification, not architectural contradiction.

---

## Deviation 2 — current generator contract cannot expose Runware UUID

**Architectural assumption:**  
Runware BGRM can prefer the UUID created by Runware generation.

**Repository reality:**  
The existing generator adapter immediately collapses the provider response to a URL string.

**Impact on Blueprint:**  
Add a reference-aware generation path while preserving the existing string API.

**Architectural intent remains valid:**  
Yes.

---

## Deviation 3 — RP character cache cannot currently represent BGRM state

**Architectural assumption:**  
Cached character assets can distinguish processing mode.

**Repository reality:**  
`character_visual_combinations` currently keys only on character/outfit/expression.

**Impact on Blueprint:**  
Add `bgrm_applied` to the cache identity.

**Architectural intent remains valid:**  
Yes. This directly implements AC-16.

---

## Deviation 4 — Chunk 1 is already implemented

**Architectural assumption:**  
The full BGRM feature includes establishing the BGRM profile and provider adapter.

**Repository reality:**  
That capability has already landed.

**Impact on Blueprint:**  
Those files are treated as existing infrastructure and verified dependencies rather than future implementation work.

**Architectural intent remains valid:**  
Yes.

---

No repository discovery invalidates the Architectural Report.

The Blueprint is ready to proceed to **Stage 3 — Implementation Plan**.
