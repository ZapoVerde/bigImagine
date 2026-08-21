# Blueprint — RP Character Sprite Stage

> Purpose: translate the approved RP Character Sprite Stage Architectural Report into a repository-grounded definition of **what must change**.
>
> Scope clarification from repository discovery: BigImagine already has RP scene membership, per-character visual state, rendered visual-combination caching, and asynchronous autofire generation. The Sprite Stage should expose and present those existing outputs rather than create another visual-state system.

---

# 1. Repository Findings

## 1.1 The current RP portrait is only a temporary avatar bridge

`frontend/src/components/chat/ActivePortrait.tsx` currently owns the small portrait box above RP chat.

It:

1. receives `chatId` and `sceneId`;
2. calls the existing chat-scoped `get_scenes` tool;
3. finds the active scene;
4. takes the first `characterId`;
5. calls `fetchCharacterAvatarUrl`;
6. renders that character's avatar in a small opaque box.

Its own file description explicitly identifies it as a simple first-character proof of plumbing and notes that imported/manual avatars are its current data source.

It does **not** read RP-generated character imagery.

Therefore `ActivePortrait` is not a suitable data source for the Sprite Stage.

It should be retired rather than expanded into the new system.

---

## 1.2 RP scene membership already exists

The active RP scene is already propagated through the frontend.

`ChatView.tsx` owns the loaded `ChatSessionRow` and reports `onSceneIdChange(sceneId)` to `App.tsx`.

`App.tsx` stores `activeSceneId` and provides both `activeChatId` and `activeSceneId` to the RP sidebar Cast section.

The active-scene cast is already available through the chat-scoped `get_scenes` tool.

That tool returns an ordered `characterIds: string[]` for the scene.

This existing ordering originates from persisted presence ordering and is already used by `ActivePortrait`.

Therefore the Sprite Stage should reuse the current scene membership/order rather than introduce a VN roster table, manual stage membership, independent character ordering, or a new scene-presence abstraction.

---

## 1.3 RP-generated character imagery already has the correct cache

`orchestrator/src/orchestrator/characterVisualAutofire.ts` already writes rendered RP character imagery into `character_visual_combinations`.

The combination identity is currently effectively:

```text
user
+ chat
+ character
+ outfit
+ expression
+ bgrm_applied
```

and the row stores:

```text
image_url
composed_prompt
```

The autofire pipeline already normalizes outfit and expression, avoids duplicate in-flight renders, checks the combination cache before generating, drops stale triggers, renders asynchronously after the chat response, applies optional BGRM, and persists the resulting URL.

This is precisely the URL mapping the Sprite Stage needs.

The Sprite Stage must consume this cache rather than regenerate an image, promote images into `characters.avatar`, copy image URLs into a new sprite table, or maintain its own image cache.

---

## 1.4 Current character visual state identifies which combination is active

`character_visual_states` contains the canonical current snapshot for each `user + chat + character`, including expression, outfit fields, originating `message_id`, and originating `swipe_id`.

The combination renderer derives its cache keys from this same normalized state.

Therefore the normal current-stage read can resolve:

```text
current character visual state
        ↓
outfit_key + expression_key
        ↓
character_visual_combinations
        ↓
effective image_url
```

No new generation-state table is required.

---

## 1.5 The event ledger contains swipe provenance

`character_visual_state_events` is append-only and already records `message_id`, `swipe_id`, `before_state`, `after_state`, character, and event time.

The current snapshot intentionally outlives any particular turn or swipe.

The **current snapshot alone cannot represent an older selected swipe** after later visual changes have occurred.

The event ledger provides the information needed to recover historical visual state, but there is presently no stage-facing read model that performs that resolution.

The Blueprint must therefore distinguish current latest state from selected historical/swipe state rather than making the frontend infer historical state.

---

## 1.6 There is currently no frontend API for RP visual-combination assets

Repository search shows server/admin APIs for enabling character visual state, configuring character visual behaviour, and generating combinations internally, but no frontend read API whose contract is “give me the displayable character sprites for this RP chat/scene.”

`ActivePortrait` works around this because avatars already have a dedicated fetch endpoint.

The Sprite Stage should not reproduce that workaround.

A new read-only server boundary is required that returns presentation-ready RP visual asset references.

The frontend should not calculate outfit keys, query visual state pieces separately, know the BGRM cache dimension, choose between raw and transparent database rows, or reconstruct historical visual state.

Those responsibilities belong at the server/database seam.

---

## 1.7 BGRM already produces the correct downstream URL

The landed BGRM architecture changed RP character combination identity to include actual `bgrm_applied` state.

The character visual autofire pipeline therefore already knows which rendered URL corresponds to the effective processing mode.

The Sprite Stage does not need another BGRM decision.

It only needs a resolved display URL.

---

## 1.8 RP chat layout currently has two independent vertical consumers above history

Today the RP view is structured approximately as:

```text
view-container-rp
    ActivePortrait
    ChatView
        chat-top-bar
        sync banner
        chat history
        bottom overlay/composer
```

`App.css` explicitly turns `.view-container-rp` into a flex column because `ActivePortrait` consumes its own row above `ChatView`.

`ActivePortrait.css` gives that row a surface background, padding, bottom border, and fixed portrait sizing.

This entire presentation is replaced by the Sprite Stage.

---

## 1.9 ChatView currently owns a dedicated chat header

`ChatView.tsx` currently renders a `chat-top-bar` containing `chat-header`, title, `CleanupStatusPill`, chat menu/branch button, and canvas switch.

For RP chats the desktop `⋯` menu is mounted in this header.

On mobile a second copy of the same menu is already mounted inside the composer row.

Therefore removing the dedicated RP header has an important compatibility consequence: mobile already has a composer-row home for the RP `⋯` menu, while desktop currently does not.

The RP header cannot simply disappear without relocating its still-required desktop controls.

---

## 1.10 The "pill" is `CleanupStatusPill`

The current RP header includes `CleanupStatusPill` whenever cleanup is enabled.

It is coupled to `ChatView` state because its `onSettled` callback triggers the canonical chat refresh after cleanup finishes.

The pill should therefore remain owned by `ChatView`.

It should **move visually**, not move state ownership.

The correct target is an absolutely positioned floating overlay near the top of the RP content/stage.

It should not return to `App.tsx` and should not become part of `SpriteStage`'s data model.

---

## 1.11 Mobile top-bar collapse currently includes the chat header

`App.tsx` and `ChatView.tsx` currently cooperate on mobile to hide `TabStrip`, `TimerStrip`, and `chat-header` using `topBarsHidden` / `onTopBarsHiddenChange` and CSS targeting both `.app-top-bars` and `.chat-top-bar`.

Removing the RP `chat-top-bar` means the existing collapse behaviour becomes asymmetric: ordinary chat still has App top bars + chat header, while RP has only App top bars.

The generic top-bar state itself should remain because normal chats still use it.

The change must therefore be RP-specific rather than deleting the entire collapse subsystem.

---

## 1.12 The composer is already a floating bottom overlay

`ChatView` already treats the entire bottom control stack as a transparent overlay over chat history.

That stack contains staging bars, selection controls, composer, mobile RP `⋯` menu, jump-to-bottom, and Send.

This is the correct location for the new Sprite Stage show/hide control.

No new toolbar should be introduced.

---

## 1.13 There is no frontend unit-test harness

`frontend/package.json` currently exposes Vite build and TypeScript check/verify, but no Jest/Vitest/Playwright-style component test suite.

Therefore presentation behaviour should not acquire invented low-value test scaffolding solely for this feature.

Deterministic logic that can be isolated cleanly should be tested where practical, while stage geometry and touch interaction require build/typecheck plus deliberate browser verification.

---

# 2. Core Scope & Changes

### File: `orchestrator/src/server/characterSpriteState.ts` — CREATE

**Current responsibility:**  
Does not exist.

**Required logical change:**  
Create the read-only server/domain boundary that resolves the Sprite Stage's presentation model.

Conceptual response:

```ts
interface CharacterSpriteState {
  characterId: string;
  name: string;
  presenceOrder: number;
  imageUrl: string | null;
  expression: string | null;
}
```

The resolver owns validating chat ownership, resolving active scene/cast in canonical presence order, resolving visual state applicable to the selected timeline/swipe, deriving normalized outfit/expression combination identity server-side, selecting the correct existing `character_visual_combinations` row, returning its URL when available, and returning `imageUrl: null` when imagery is absent.

It must not generate images, call BGRM, mint Subject/Expression definitions, mutate state, or create combination rows.

**Reason this file is core:**  
The repository has the required data but no presentation read model. This boundary prevents frontend duplication of domain/cache logic and bridges existing RP visual state to the new stage.

**API Delta Ledger:**

- **Symbol:** new sprite-state resolver/handler
- **Before:** no public RP sprite-state read contract
- **After:** authenticated read-only RP sprite-state contract
- **Reason:** frontend currently has no supported way to obtain RP-generated character imagery

---

### File: `orchestrator/src/server/httpServer.ts`

**Current responsibility:**  
Owns HTTP route registration/dispatch for orchestrator server APIs.

**Required logical change:**  
Register the new authenticated RP Sprite Stage read endpoint and route it to the sprite-state handler.

Suggested resource shape:

```text
GET /v1/chats/:chatId/character-sprites
```

The final route name should follow current chat-resource conventions discovered during implementation.

This is a read endpoint only.

**Reason this file is core:**  
The new Sprite Stage read model requires a reachable authenticated API boundary.

**API Delta Ledger:**

- **Symbol:** new HTTP route
- **Before:** no character-sprite endpoint
- **After:** authenticated chat-scoped sprite-state GET
- **Reason:** expose existing visual combination state to the frontend

---

### File: `frontend/src/api/types.ts`

**Current responsibility:**  
Owns frontend wire/API DTOs.

**Required logical change:**  
Add the Sprite Stage response type.

The type should remain presentation-oriented and not expose raw outfit-key serialization, internal cache ids unless required, BGRM provider details, composed prompt, or internal visual-state audit data.

**Reason this file is core:**  
The feature introduces a new public frontend/server read contract.

**API Delta Ledger:**

- **Symbol:** new `CharacterSpriteState` / equivalent type
- **Before:** absent
- **After:** typed representation of one displayable stage character
- **Reason:** typed client consumption of new endpoint

---

### File: `frontend/src/api/client.ts`

**Current responsibility:**  
Owns frontend HTTP API calls.

**Required logical change:**  
Add a typed read function for the new chat Sprite Stage endpoint, conceptually `getChatCharacterSprites(chatId, apiKey)`.

The function should only transport the server's resolved display model.

It must not implement scene lookup, cache matching, or BGRM selection client-side.

**Reason this file is core:**  
The stage needs a supported API-client seam rather than direct fetch logic inside a component.

**API Delta Ledger:**

- **Symbol:** `getChatCharacterSprites` or equivalent
- **Before:** absent
- **After:** typed read of chat-scoped sprite state
- **Reason:** support Sprite Stage presentation

---

### File: `frontend/src/components/chat/SpriteStage.tsx` — CREATE

**Current responsibility:**  
Does not exist.

**Required logical change:**  
Create the RP Sprite Stage presentation component.

The component owns stage-specific UI behaviour: fetching/resolving stage characters through the new client API, displaying up to three visible stage sprites, deterministic one/two/three-character layout, retaining scene/presence ordering, responding to refresh triggers when RP state may have changed, showing available URLs while tolerating null URLs, bottom anchoring, aspect-ratio-preserving rendering, stage visibility, draggable height interaction, temporary keyboard clamping, and persisted normal height ratio.

The component should not own RP scene truth, image generation, BGRM, visual combination identity, character state parsing, `CleanupStatusPill`, or chat menu state.

**Reason this file is core:**  
This is the primary presentation owner defined by the Architectural Report.

**API Delta Ledger:**

New component contract, expected to require `apiKey`, `chatId`, `refreshToken`, and active/presentation state as needed.

---

### File: `frontend/src/components/chat/SpriteStage.css` — CREATE

**Current responsibility:**  
Does not exist.

**Required logical change:**  
Own all Sprite Stage-specific geometry and presentation: stage clipping, transparent surface, one/two/three-slot positioning, bottom anchoring, responsive sprite scaling, draggable divider, enlarged invisible touch target, drag interaction state, mobile geometry, and floating-content compatibility.

No opaque card/panel treatment should be introduced around individual sprites.

**Reason this file is core:**  
The new stage has substantial independent layout semantics and should not add another large block to the already very large `ChatView.css`.

**API Delta Ledger:**  
None.

---

### File: `frontend/src/App.tsx`

**Current responsibility:**  
Owns mounted application views, active RP `sceneId`, tab identity, and currently mounts `ActivePortrait` above RP `ChatView`.

**Required logical change:**  
Remove the `ActivePortrait` import and RP mount.

The RP container should cease owning a separate portrait row.

Do not move character-sprite fetching into `App.tsx`.

`activeSceneId` remains because the sidebar Cast section still uses it.

**Reason this file is core:**  
The old portrait UI is physically mounted here and must be removed to allow the RP viewport to become the stage/chat layout described by the architecture.

**API Delta Ledger:**  
None expected.

---

### File: `frontend/src/views/ChatView.tsx`

**Current responsibility:**  
Owns the chat pane, active session, message/swipe UI, RP control menu, cleanup pill state, composer overlay, active location background, top-bar-collapse interactions, and RP `sceneId` reporting.

**Required logical change:**  
For RP chats: mount the new Sprite Stage inside the RP chat layout; remove the dedicated RP `chat-top-bar` / `chat-header`; preserve normal-chat header unchanged; keep `CleanupStatusPill` owned here but render it as a floating top overlay; add the Sprite Stage show/hide button to the existing bottom composer/control row; ensure the RP `⋯` menu remains reachable on desktop after header removal; preserve the existing mobile menu mount; trigger Sprite Stage refresh after state-changing operations that can affect selected visuals; avoid coupling stage show/hide to generation; and ensure sync banner positioning still works without assuming an RP header exists.

The clean ownership is:

```text
ChatView
  ├─ floating CleanupStatusPill
  ├─ SpriteStage
  ├─ chat history
  └─ bottom composer controls
```

For ordinary chats the existing header/history/composer shape remains.

**Reason this file is core:**  
This is the actual RP viewport owner and control surface.

**API Delta Ledger:**

No external `ChatView` prop change is required unless implementation discovery proves a stage refresh signal must be lifted.

---

### File: `frontend/src/views/ChatView.css`

**Current responsibility:**  
Owns ChatView geometry including background layers, chat header, history, floating composer, mobile menu swap, settings rail, sync banner, and mobile top-bar behaviour.

**Required logical change:**  
Add/adjust RP-specific layout rules so RP does not reserve `chat-header` height, the floating cleanup pill overlays content, desktop RP menu controls have a non-header home, stage and history divide available vertical space cleanly, existing location background can remain behind both stage and chat where intended, sync banner remains readable, composer overlay continues to function, and normal chats retain existing header behaviour.

Do not place Sprite Stage slot/layout rules here; those belong in `SpriteStage.css`.

**Reason this file is core:**  
Removing the RP header and integrating the stage changes the fundamental ChatView vertical layout.

**API Delta Ledger:**  
None.

---

### File: `frontend/src/App.css`

**Current responsibility:**  
Owns app/view container geometry, mobile top-bar collapsing, and the current `.view-container-rp` accommodation for `ActivePortrait`.

**Required logical change:**  
Remove the `ActivePortrait`-specific RP flex-row accommodation that exists solely because the old portrait consumes a separate row.

Retain `.view-container-rp` only if it still has meaningful RP-specific ownership after the stage moves inside `ChatView`.

Update mobile collapse selectors so removal of the RP chat header does not disturb App TabStrip/TimerStrip collapsing, ordinary-chat header collapsing, or mobile drawer anchoring.

Do not globally delete `.chat-top-bar` behaviour because non-RP chat still uses it.

**Reason this file is core:**  
Current app-level layout explicitly exists to make room for the portrait being replaced.

**API Delta Ledger:**  
None.

---

### File: `frontend/src/components/chat/ActivePortrait.tsx` — DELETE

**Current responsibility:**  
Shows one first-listed scene character using the legacy avatar path.

**Required logical change:**  
Delete after Sprite Stage is wired.

**Reason this file is core:**  
The Sprite Stage supersedes this UI and uses the actual RP visual-combination asset source.

**API Delta Ledger:**

- **Symbol:** `ActivePortrait`
- **Before:** app-level RP portrait component
- **After:** removed
- **Reason:** superseded by multi-character Sprite Stage

---

### File: `frontend/src/components/chat/ActivePortrait.css` — DELETE

**Current responsibility:**  
Owns the opaque fixed portrait row.

**Required logical change:**  
Delete with `ActivePortrait`.

**Reason this file is core:**  
Its visual contract directly conflicts with the new transparent VN-style stage.

**API Delta Ledger:**  
None.

---

# 3. Dependency Discovery

The core changes touch several established subsystems that must be deliberately preserved.

## 3.1 Scene/cast infrastructure

The new stage depends on existing scene presence ordering and should reuse it without modifying its writer or tool contract unless the new server read model can more efficiently query the same canonical tables directly.

The existing sidebar Cast section remains independent.

## 3.2 Character visual autofire

`characterVisualAutofire.ts` is the producer of the URLs consumed by the stage and should not need behavioural modification.

Classification: **Verification-only.**

## 3.3 Character visual state

`characterVisualState.ts` owns the canonical current snapshot and append-only event provenance.

The new read model consumes these tables.

No change to the state writer should be necessary unless repository inspection during implementation finds that historical active-swipe reconstruction lacks sufficient provenance.

Classification: **Verification-only / potentially collateral only if a proven provenance gap exists.**

Do not modify the write pipeline speculatively.

## 3.4 BGRM

BGRM post-processing remains an upstream asset producer.

Classification: **Inspected / no change.**

## 3.5 Cleanup pill

`CleanupStatusPill` remains mounted by `ChatView`; only positioning changes.

Classification: **Verification-only component; collateral CSS/layout change occurs in ChatView.**

## 3.6 Chat menu

RP desktop currently relies on the header copy of the `⋯` menu. Mobile already relies on the composer-row copy.

Removing the header means desktop must expose the same shared menu from the composer/control area or another non-space-consuming overlay.

Classification: **Collateral modification inside `ChatView.tsx` / `ChatView.css`.**

## 3.7 Top-bar collapse

`topBarsHidden` remains required for App top bars and ordinary chat. RP should simply cease having a collapsible chat-header participant.

Classification: **Collateral modification.**

## 3.8 Complete Discovered File Manifest

| File | Classification | Why it is affected |
| --- | --- | --- |
| `orchestrator/src/server/characterSpriteState.ts` | Core create | New read model connecting canonical RP visual state to display URLs |
| `orchestrator/src/server/httpServer.ts` | Core modification | Register sprite-state endpoint |
| `frontend/src/api/types.ts` | Core modification | New wire DTO |
| `frontend/src/api/client.ts` | Core modification | New frontend API call |
| `frontend/src/components/chat/SpriteStage.tsx` | Core create | Stage presentation and resize owner |
| `frontend/src/components/chat/SpriteStage.css` | Core create | Stage geometry and responsive layout |
| `frontend/src/views/ChatView.tsx` | Core modification | RP viewport, toggle, pill relocation, menu relocation, refresh |
| `frontend/src/views/ChatView.css` | Core modification | Header removal and RP viewport layout |
| `frontend/src/App.tsx` | Core modification | Remove old ActivePortrait mount |
| `frontend/src/App.css` | Core modification | Remove obsolete portrait-row accommodation; adjust mobile collapse |
| `frontend/src/components/chat/ActivePortrait.tsx` | Core delete | Superseded |
| `frontend/src/components/chat/ActivePortrait.css` | Core delete | Superseded |
| `orchestrator/src/orchestrator/characterVisualAutofire.ts` | Verification-only | Producer/cache identity consumed by stage |
| `orchestrator/src/orchestrator/characterVisualState.ts` | Verification-only | Current state + provenance source |
| existing character visual-state migrations | Inspected / no change | Existing persistence supports state/cache read |
| `frontend/src/components/cleanup/CleanupStatusPill.tsx` | Inspected / no change | Function stays unchanged; only mount position changes |
| `frontend/src/components/sidebar/CastSection.tsx` | Inspected / no change | Existing scene/cast consumer remains independent |
| `frontend/package.json` | Inspected / no change | Confirms no frontend component-test harness |

---

# 4. Collateral Changes

### File: `frontend/src/views/ChatView.tsx` — RP menu relocation

**Current responsibility:**  
Desktop RP `⋯` menu is hosted in the chat header; mobile copy is hosted beside the composer.

**Fixing logic required:**  
Once the RP header is removed, render the RP menu from the bottom control area at both breakpoints.

Reuse the existing `chatMenuOpen`, `chatMenuItems`, and outside-click handling rather than creating another menu implementation.

If two mounts are no longer necessary, simplify to one responsive mount.

Do not alter menu semantics.

**API Delta Ledger:**  
None.

---

### File: `frontend/src/views/ChatView.tsx` — floating CleanupStatusPill

**Current responsibility:**  
CleanupStatusPill currently sits in the header and calls back into ChatView when the latest cleaned response settles.

**Fixing logic required:**  
Keep the component and callback exactly at the current ownership level, but mount the pill into an RP-only floating overlay.

The overlay does not reserve vertical space, remains clickable, paints above sprites/history, and does not block the entire stage width.

**API Delta Ledger:**  
None.

---

### File: `frontend/src/App.css` / `frontend/src/views/ChatView.css` — top-bar collapse compatibility

**Current responsibility:**  
Mobile collapse currently treats `.app-top-bars` and `.chat-top-bar` as a pair.

**Fixing logic required:**  
Preserve the behaviour for ordinary chats and App bars while allowing RP to have no dedicated chat header.

Do not remove `topBarsHidden` globally.

**API Delta Ledger:**  
None.

---

# 5. Complete API Delta Ledger

### New server API

```text
GET /v1/chats/:chatId/character-sprites
```

or repository-conventional equivalent.

Returns an ordered presentation model of current/selected RP scene characters and their resolved existing image URLs.

### New frontend client API

`getChatCharacterSprites(...)` or equivalent.

### New frontend DTO

`CharacterSpriteState` or equivalent.

### Removed frontend component API

`ActivePortrait({ apiKey, chatId, sceneId })` is deleted.

No changes are required to character visual generation APIs, BGRM APIs, scene writer APIs, `CleanupStatusPill` API, or `ChatView`'s external props unless implementation discovery proves otherwise.

---

# 6. Verification Assessment

## 6.1 File Verification

| File | Verification requirement | Reason |
| --- | --- | --- |
| `orchestrator/src/server/characterSpriteState.ts` | Add deterministic server verification | New DB/read-domain logic |
| `orchestrator/src/server/httpServer.ts` | Extend server endpoint verification | New authenticated route |
| `frontend/src/api/types.ts` | Frontend typecheck | DTO contract |
| `frontend/src/api/client.ts` | Frontend typecheck + endpoint integration check | New API call |
| `SpriteStage.tsx` | Typecheck/build + deliberate browser verification | Stateful presentation/pointer behaviour |
| `SpriteStage.css` | Desktop + mobile manual verification | Geometry |
| `ChatView.tsx` | Typecheck/build + regression verification | Central high-risk view |
| `ChatView.css` | Desktop/mobile browser verification | Header/composer/overlay layout |
| `App.tsx` | Typecheck/build | ActivePortrait removal |
| `App.css` | Mobile regression verification | Top-bar collapse |
| `ActivePortrait.*` | Build confirms no remaining imports | Deleted legacy path |

## 6.2 Server Behaviour Verification

Add a deterministic verification script following the repository's existing `orchestrator/scripts/verify-*.mjs` pattern.

Required cases:

1. one active scene character with matching combination → URL returned;
2. multiple characters → canonical presence order preserved;
3. present character with no visual state → character survives with `imageUrl: null`;
4. state exists but combination render has not landed → `imageUrl: null`;
5. matching raw/BGRM variants → resolver chooses the asset corresponding to the effective state/settings contract rather than arbitrary row order;
6. character from another chat/user cannot leak;
7. deleted/non-present character is not returned;
8. selected swipe with historical visual state resolves the corresponding known combination where provenance permits;
9. no scene → empty result rather than server failure.

## 6.3 Behaviour Verification

| Acceptance Criterion | Verification method |
| --- | --- |
| AC-01 | Browser: RP Sprite Stage renders above conversation |
| AC-02 | Browser: composer-row stage toggle shows/hides it |
| AC-03 | Browser: hiding stage returns space to history |
| AC-04 | Server logs/cache + browser: toggle causes no image-generation/BGRM request |
| AC-05 | Browser mouse drag |
| AC-06 | Mobile/touch pointer drag |
| AC-07 | Browser: min/max clamps |
| AC-08 | Inspect persisted preference; resize viewport |
| AC-09 | Reload/browser reopen |
| AC-10 | Desktop resize + mobile orientation |
| AC-11 | Mobile keyboard open; inspect unchanged persisted ratio |
| AC-12 | Mobile keyboard: temporary stage clamp |
| AC-13 | Close keyboard: original split returns |
| AC-14 | Attempt divider interaction during keyboard state |
| AC-15 | Visual check with differing source ratios |
| AC-16 | Resize stage and confirm proportional sprite response |
| AC-17 | Server resolver verification confirms existing combination URL is consumed |
| AC-18 | Browser with BGRM-transparent combination |
| AC-19 | Browser/server fixture with raw effective combination |
| AC-20 | Server fixture verifies scene/cast derivation |
| AC-21 | Browser one/two/three-character layouts |
| AC-22 | Browser >3 cast fixture |
| AC-23 | Reload/state refresh with cached image present |
| AC-24 | Turn with delayed autofire; sprite appears without chat reload |
| AC-25 | Swipe between known visual states; stage follows selected swipe |
| AC-26 | Server/cache logs confirm existing combination reused |
| AC-27 | No provider call caused by stage resize/toggle/swipe-to-known |
| AC-28 | Missing image fixture leaves rest of UI intact |
| AC-29 | Corrupt/remove persisted ratio and reload |
| AC-30 | Physical/emulated phone touch target |
| AC-31 | Code inspection + prompt diagnostics confirm UI state does not enter RP prompt/state |
| AC-32 | Code inspection confirms URL-only reads |
| AC-33 | Stage hidden: RP history/composer regression pass |
| AC-34 | Browser: RP dedicated header absent |
| AC-35 | Browser: CleanupStatusPill retains behaviour |
| AC-36 | Browser: pill overlays stage/content |
| AC-37 | Mobile comparison confirms reclaimed height |
| AC-38 | DOM/CSS inspection: no replacement full-width header reservation |
| AC-39 | Browser: pill collision handling remains local |

---

# 7. Complete File Manifest

## Create

- `orchestrator/src/server/characterSpriteState.ts`
- `frontend/src/components/chat/SpriteStage.tsx`
- `frontend/src/components/chat/SpriteStage.css`
- `orchestrator/scripts/verify-character-sprite-state.mjs` or repository-conventional equivalent

## Modify

- `orchestrator/src/server/httpServer.ts`
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`
- `frontend/src/views/ChatView.tsx`
- `frontend/src/views/ChatView.css`
- `frontend/src/App.tsx`
- `frontend/src/App.css`
- root/orchestrator verification command manifest only if required

## Delete

- `frontend/src/components/chat/ActivePortrait.tsx`
- `frontend/src/components/chat/ActivePortrait.css`

## Inspected but deliberately unchanged

- `orchestrator/src/orchestrator/characterVisualAutofire.ts`
- `orchestrator/src/orchestrator/characterVisualState.ts`
- `orchestrator/src/server/characterVisualState.ts`
- existing character visual-state migrations
- BGRM post-processing implementation
- `frontend/src/components/cleanup/CleanupStatusPill.tsx`
- `frontend/src/components/sidebar/CastSection.tsx`
- scene-presence writers/tool implementation
- `frontend/package.json`

---

# 8. Blueprint Constraints & Risks

## 8.1 Do not turn the frontend into a visual-state resolver

The largest architectural trap is exposing raw expression/outfit/BGRM/cache/event state and asking `SpriteStage.tsx` to combine them.

The server endpoint must return the resolved presentation URL.

## 8.2 Do not use `characters.avatar`

The new stage must use `character_visual_combinations`.

Writing generated chat imagery back into `characters.avatar` would collapse character identity and turn-specific character appearance into the same field.

## 8.3 Late image arrival needs a deliberate refresh trigger

Character visual autofire happens after the response has already been sent.

A single stage fetch immediately after the chat response can legitimately return `imageUrl: null` for a newly changed combination.

The frontend needs a bounded refresh mechanism analogous in spirit to the existing location-image replacement poll. It should refresh after a completed RP turn/swipe, stop once currently expected images arrive or the bounded retry window expires, cancel on chat/tab changes/unmount, and never itself trigger generation.

Do not create an endless background poll.

## 8.4 Hidden tabs remain mounted

Any Sprite Stage polling, pointer listeners, or `visualViewport` listeners must respect whether the ChatView is active.

Hidden RP tabs must not continue unnecessary polling or own active resize behaviour.

## 8.5 Keyboard detection must distinguish temporary visual viewport reduction

The persisted ratio describes the normal RP viewport.

Implementation must not treat every viewport resize as a new preferred stage ratio.

Persist only deliberate divider changes made in normal layout.

## 8.6 Pointer resizing must clean up globally

A divider drag may leave the divider element before `pointerup`.

Resize handling must safely capture/observe the active pointer and always release drag state.

## 8.7 The location background and stage are layered in the same chat pane

`ChatView` already renders the location image absolutely behind its content.

The Sprite Stage should therefore be designed as a transparent foreground region unless a later feature explicitly adds another stage backdrop.

## 8.8 More than three present characters is presentation overflow, not scene-state overflow

The scene can contain any valid number of characters.

The initial stage shows at most three.

The selection rule must be deterministic and should initially preserve existing presence ordering rather than inventing speaker analysis.

## 8.9 CleanupStatusPill must remain operational after becoming an overlay

It is not decorative.

Its current settle callback causes ChatView to refresh the canonical cleaned message.

Moving it must not break this callback or swallow pointer interaction.

## 8.10 Removing the RP header affects more than the title

The RP header currently houses title, `CleanupStatusPill`, desktop `⋯` menu, and optional mobile canvas switch.

Each must receive an explicit disposition.

The RP title itself may disappear from the in-chat viewport because the active tab already identifies the chat.

The menu remains required, the pill floats, and any canvas switch still required on RP mobile needs a non-header home.

## 8.11 Do not refactor the entire `ChatView.tsx` incidentally

The new Sprite Stage should be extracted into its own component rather than adding stage fetch/geometry/render code inline.

The implementation should not use this feature as an excuse for an unrelated ChatView rewrite.

---

# 9. Discovery Deviations

## Deviation 1 — the existing portrait is not the RP-generated character image

**Architectural assumption:**  
The existing character display could potentially evolve into the Sprite Stage.

**Repository reality:**  
`ActivePortrait` resolves `characters.avatar`, while RP autofire imagery is stored separately in `character_visual_combinations`.

**Impact on Blueprint:**  
Replace `ActivePortrait`; do not extend its image-fetch path. A new server read model is required.

**Architectural intent remains valid:**  
Yes.

## Deviation 2 — final sprite URLs exist, but they are server-internal

**Architectural assumption:**  
The stage could consume existing final character-image URLs directly.

**Repository reality:**  
Those URLs are persisted correctly, but no frontend API exposes them.

**Impact on Blueprint:**  
Add one narrow chat-scoped read endpoint rather than new persistence.

**Architectural intent remains valid:**  
Yes.

## Deviation 3 — historical visual state is not represented by the current snapshot

**Architectural assumption:**  
Selecting another swipe/turn could directly resolve that state's image.

**Repository reality:**  
`character_visual_states` stores only the latest snapshot. Historical state is represented indirectly through the append-only event ledger and its `message_id` / `swipe_id` provenance.

**Impact on Blueprint:**  
Historical resolution belongs in the server Sprite Stage read model. The frontend must not assume the current snapshot equals the selected historical state.

Implementation must verify that existing event provenance is sufficient before modifying any writer.

If a genuine provenance hole is found, planning must return to architecture rather than silently inventing a second history model.

**Architectural intent remains valid:**  
Yes, subject to that verification.

## Deviation 4 — the RP header contains functional controls

**Architectural assumption:**  
The top RP bar could simply be removed while leaving the pill floating.

**Repository reality:**  
The bar also hosts the desktop RP `⋯` menu and potentially the mobile Canvas switch.

**Impact on Blueprint:**  
Those controls must be relocated before deleting the header.

The existing mobile composer-row menu gives the preferred pattern.

**Architectural intent remains valid:**  
Yes.

## Deviation 5 — mobile top-bar collapse is shared with ordinary chat

**Architectural assumption:**  
Removing the RP top bar could remove its collapse behaviour.

**Repository reality:**  
`topBarsHidden` also controls App-wide bars and ordinary chat.

**Impact on Blueprint:**  
Make the change conditional to RP. Preserve the general collapse mechanism.

**Architectural intent remains valid:**  
Yes.

## Deviation 6 — the existing location background is already the natural VN backdrop

**Architectural assumption:**  
The Sprite Stage was described primarily as a transparent sprite region.

**Repository reality:**  
`ChatView` already has a persistent location-image layer behind the entire chat pane.

**Impact on Blueprint:**  
Keep the Sprite Stage transparent. BGRM sprites can naturally sit over the existing location background without a second backdrop subsystem.

**Architectural intent remains valid:**  
Yes.
