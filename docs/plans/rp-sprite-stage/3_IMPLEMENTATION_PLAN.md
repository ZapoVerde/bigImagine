# Implementation Plan — RP Character Sprite Stage

> Purpose: implement the approved RP Character Sprite Stage architecture through small, independently implementable and independently reviewable tasks.
>
> Governing intent comes from the approved Architectural Report and finalized Blueprint. The Blueprint remains authoritative for repository scope, ownership, compatibility requirements, and API deltas.

---

# 1. Mission Summary

BigImagine's RP chat will replace the existing single-avatar `ActivePortrait` bridge with a VN-style Sprite Stage backed by the existing RP character visual-state and visual-combination cache.

The implementation must expose a narrow read-only sprite-state API, consume existing rendered character-image URLs, add the resizable stage and persistence behaviour, preserve late-image arrival and swipe/history semantics, remove the dedicated RP chat header, float the cleanup pill, retain required RP controls, and finally retire the old portrait bridge.

No task may alter character generation, BGRM semantics, scene-state ownership, or character visual combination identity except where an explicit Planning Deviation proves the finalized Blueprint incorrect.

---

# 2. Validation Classification

The plan uses the coding-loop rubric:

- **Tier 1 — Basic:** presentation-only or deletion/cleanup work with low architectural risk.
- **Tier 2 — Standard:** bounded feature logic and frontend state coordination.
- **Tier 3 — Critical:** persistence/I/O boundaries, canonical state resolution, history/swipe reconstruction, or other high-risk architectural seams.

---

# 3. Implementation Phases

# Phase 1 — Establish the Sprite Read Model

**Phase objective:**  
Expose the existing RP scene, character visual state, and cached visual-combination URLs through one authenticated, read-only server contract suitable for the Sprite Stage.

**Phase completion condition:**  
The server can return ordered RP sprite rows for a chat without triggering generation or requiring frontend knowledge of visual-state/cache internals.

## Task 1.1 — Implement Current Sprite-State Resolution

### Objective

Create the server-side resolver that returns the current active-scene characters in canonical presence order with their currently resolved existing visual-combination image URLs.

### Architectural Intent

The frontend must consume a presentation-ready sprite model rather than reconstructing outfit keys, expression keys, BGRM state, or scene membership itself.

### Scope

**Create:**
- `orchestrator/src/server/characterSpriteState.ts`
- `orchestrator/scripts/verify-character-sprite-state.mjs`

**Modify:**
- None unless required by repository-local test harness registration

**Delete:**
- None

**Expected but unchanged dependencies:**
- `orchestrator/src/orchestrator/characterVisualAutofire.ts`
- `orchestrator/src/orchestrator/characterVisualState.ts`
- scene/presence persistence and `get_scenes` ownership
- `character_visual_states`
- `character_visual_combinations`
- BGRM-related cache identity

### Required Logical Changes

#### `orchestrator/src/server/characterSpriteState.ts`

- Add a read-only resolver for one authenticated RP chat.
- Resolve the current active scene and ordered cast from canonical scene/presence data.
- For each present character:
  - resolve current canonical visual state;
  - derive the same outfit/expression identity used by autofire;
  - resolve an existing matching visual combination;
  - return its `imageUrl` when present;
  - otherwise return `imageUrl: null`.
- Preserve scene presence order.
- Return missing imagery as a per-character null, not a whole-request failure.
- Do not call generation or BGRM.
- Do not mutate any state.
- Do not promote images into `characters.avatar`.

#### `orchestrator/scripts/verify-character-sprite-state.mjs`

Add deterministic verification for:

- one present character with matching combination;
- multiple characters preserving presence order;
- missing visual state;
- missing combination;
- user/chat isolation;
- no active scene;
- no generation side effects.

### Acceptance Criteria

- **T1.1-AC01:** The resolver returns only characters belonging to the current active scene.
- **T1.1-AC02:** Returned characters preserve canonical scene presence order.
- **T1.1-AC03:** A matching current visual combination returns its stored image URL.
- **T1.1-AC04:** A present character with no usable image returns `imageUrl: null`.
- **T1.1-AC05:** Missing imagery does not fail the entire sprite-state result.
- **T1.1-AC06:** The resolver performs no generation, minting, BGRM, or persistence writes.
- **T1.1-AC07:** Characters from another user or chat cannot leak into the result.
- **T1.1-AC08:** No active scene returns an empty result rather than an error.

### Verification

**Automated:**
- targeted `verify-character-sprite-state.mjs`
- orchestrator typecheck/build
- existing character visual-state verification if required to confirm key compatibility

**Runtime/manual:**
- None

### Constraints & Anti-Patterns

- Do not duplicate the visual-combination identity in a subtly different form.
- Reuse existing normalization helpers where available.
- Do not add a new sprite persistence table.
- Do not alter the autofire writer.
- Do not alter BGRM semantics.
- No unrelated refactor.

### API Delta

New internal server resolver contract for ordered RP sprite rows.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** touches canonical state resolution and persistence read logic; rubric items 2, 4, and 5.

### Task Completion Boundary

Current RP sprite state is deterministically resolvable from existing canonical data without any HTTP or frontend changes.

---

## Task 1.2 — Prove Historical / Swipe Sprite Resolution

### Objective

Determine whether existing visual-state provenance is sufficient to resolve sprite state for a selected historical/swipe state, and implement that resolution if it is supported by the existing model.

### Architectural Intent

Swipe/history presentation must follow the selected conversation state without inventing a second visual-history system or silently using the newest snapshot.

### Scope

**Create:**
- None unless a small dedicated resolver helper file is justified by existing ownership boundaries

**Modify:**
- `orchestrator/src/server/characterSpriteState.ts`
- `orchestrator/scripts/verify-character-sprite-state.mjs`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `character_visual_state_events`
- `character_visual_states`
- `chat_messages.active_swipe_id`
- existing message/swipe provenance
- `orchestrator/src/orchestrator/characterVisualState.ts`

### Required Logical Changes

#### `orchestrator/src/server/characterSpriteState.ts`

- Inspect the current selected swipe/message state for the target RP chat.
- Reconstruct or resolve the applicable character visual state using existing provenance only.
- Prefer the current snapshot when it already corresponds to the active selected state.
- Use append-only event provenance for historical selection only where the existing model supports a deterministic answer.
- Resolve the resulting state to existing combination URLs exactly as Task 1.1 does.

If repository inspection proves the existing provenance cannot faithfully reconstruct selected historical/swipe state:

- stop;
- record a Planning Deviation;
- do not invent a second history model inside this task.

### Acceptance Criteria

- **T1.2-AC01:** Selected swipe state never blindly displays a newer visual snapshot when repository provenance proves an older applicable state.
- **T1.2-AC02:** Historical resolution uses existing visual-state/event provenance only.
- **T1.2-AC03:** A known historical visual combination reuses its existing URL.
- **T1.2-AC04:** The resolver does not trigger regeneration solely because the user selected an older swipe.
- **T1.2-AC05:** If existing provenance is insufficient, implementation stops with a Planning Deviation rather than silently approximating.

### Verification

**Automated:**
- targeted fixtures covering at least two swipe variants with differing visual state
- orchestrator typecheck/build

**Runtime/manual:**
- None

### Constraints & Anti-Patterns

- No new history table without returning to planning.
- Do not mutate `character_visual_states` while reading history.
- Do not regenerate historical sprites.
- No frontend historical reconstruction.
- No unrelated refactor.

### API Delta

None beyond the Task 1.1 internal resolver contract.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** historical canonical state reconstruction and persistence semantics; rubric items 2, 4, and 5.

### Task Completion Boundary

The server resolver either faithfully supports selected historical/swipe sprite state using existing provenance, or a formal Planning Deviation has stopped execution before later sprite-stage work proceeds.

---

## Task 1.3 — Expose the Chat-Scoped Sprite-State API

### Objective

Expose the finalized sprite-state resolver through one authenticated chat-scoped GET endpoint.

### Architectural Intent

The frontend receives a resolved presentation model through a narrow server boundary and remains ignorant of visual-state/cache internals.

### Scope

**Create:**
- None

**Modify:**
- `orchestrator/src/server/httpServer.ts`
- `orchestrator/src/server/characterSpriteState.ts`
- `orchestrator/scripts/verify-character-sprite-state.mjs`
- `orchestrator/scripts/verify-server.mjs` only if the repository's route verification requires it

**Delete:**
- None

**Expected but unchanged dependencies:**
- existing authentication/user scoping
- chat ownership validation
- existing HTTP utilities

### Required Logical Changes

#### `orchestrator/src/server/httpServer.ts`

Register the new authenticated read route.

Preferred shape unless repository conventions dictate otherwise:

```text
GET /v1/chats/:chatId/character-sprites
```

#### `orchestrator/src/server/characterSpriteState.ts`

Add the HTTP handler or exported server-facing function required by current route conventions.

### Acceptance Criteria

- **T1.3-AC01:** Authenticated callers can read sprite state for a chat they own.
- **T1.3-AC02:** Unauthorized/cross-user access is rejected by existing auth/scoping rules.
- **T1.3-AC03:** Endpoint returns ordered presentation rows, not raw persistence records.
- **T1.3-AC04:** Endpoint remains read-only.
- **T1.3-AC05:** No sprite-state request initiates image generation or BGRM.

### Verification

**Automated:**
- targeted endpoint verification
- orchestrator typecheck/build
- relevant server route verification

**Runtime/manual:**
- direct endpoint smoke check against a known RP chat if available

### Constraints & Anti-Patterns

- Do not expose composed prompts or internal cache ids without necessity.
- Do not expose raw event ledgers to the frontend.
- Do not add admin-only semantics to a normal authenticated RP read.
- No unrelated refactor.

### API Delta

New authenticated chat-scoped Sprite Stage GET endpoint.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** new authenticated I/O boundary; rubric items 5 and 6.

### Task Completion Boundary

A stable server API exists and can be consumed independently by frontend work.

---

# Phase 2 — Add the Frontend Sprite Data Contract

**Phase objective:**  
Give frontend code a typed, narrow API for reading sprite-stage state without yet changing RP layout.

**Phase completion condition:**  
Frontend code can call the endpoint and receive typed ordered sprite rows.

## Task 2.1 — Add Sprite DTO and API Client

### Objective

Add the frontend DTO and API client function for the Sprite Stage endpoint.

### Architectural Intent

Keep domain/cache logic on the server and expose only presentation-ready data.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/api/types.ts`
- `frontend/src/api/client.ts`

**Delete:**
- None

**Expected but unchanged dependencies:**
- existing auth/request helpers
- new Task 1.3 endpoint

### Required Logical Changes

#### `frontend/src/api/types.ts`

Add the new sprite presentation type containing only fields required by the UI, expected to include `characterId`, `name`, `presenceOrder`, `imageUrl`, and optionally `expression`.

#### `frontend/src/api/client.ts`

Add `getChatCharacterSprites(...)` or repository-conventional equivalent.

No transformation of raw state/cache identity belongs here.

### Acceptance Criteria

- **T2.1-AC01:** The new endpoint response has a typed frontend DTO.
- **T2.1-AC02:** The API client exposes one typed chat-scoped read function.
- **T2.1-AC03:** No visual-state normalization or cache matching exists in frontend code.
- **T2.1-AC04:** Frontend typecheck succeeds.

### Verification

**Automated:**
- frontend typecheck
- frontend build

**Runtime/manual:**
- optional direct smoke use if useful

### Constraints & Anti-Patterns

- Do not expose persistence detail just because it exists.
- Do not calculate keys client-side.
- No unrelated API cleanup.

### API Delta

- new Sprite Stage DTO
- new frontend client read function

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded frontend API contract consuming an already-established server boundary.

### Task Completion Boundary

Frontend has a stable typed sprite-state read contract but no visual stage is mounted yet.

---

# Phase 3 — Build the Sprite Stage Presentation

**Phase objective:**  
Render the RP scene's existing sprite URLs in a standalone transparent stage component, without changing RP header structure or resize behaviour yet.

**Phase completion condition:**  
A static-height stage can render current scene sprites and refresh when character imagery changes.

## Task 3.1 — Create the Base Sprite Stage

### Objective

Create the standalone stage component and deterministic one/two/three-character layout.

### Architectural Intent

The stage is a presentation owner only. It consumes server-resolved URLs and overlays them over the existing location background.

### Scope

**Create:**
- `frontend/src/components/chat/SpriteStage.tsx`
- `frontend/src/components/chat/SpriteStage.css`

**Modify:**
- None beyond imports required for isolated development if necessary

**Delete:**
- None

**Expected but unchanged dependencies:**
- `frontend/src/api/client.ts`
- `frontend/src/api/types.ts`

### Required Logical Changes

#### `SpriteStage.tsx`

- Fetch sprite state for the active RP chat.
- Render up to three visible characters.
- Preserve server-provided order.
- Layout 1 center, 2 left/right, 3 left/center/right.
- Ignore null image URLs for rendering while preserving stable character ordering semantics.
- Render nothing fatal when no images exist.
- Keep the stage background transparent.
- Preserve source aspect ratio.
- Bottom-anchor sprites.
- Accept a refresh token or equivalent explicit signal.
- Respect `active` state so hidden tabs do not fetch/poll unnecessarily.

#### `SpriteStage.css`

- Transparent stage region.
- Slot positioning.
- no-crop containment behaviour.
- bottom anchoring.
- bounded overflow.
- desktop/mobile responsive sizing.

### Acceptance Criteria

- **T3.1-AC01:** One available sprite renders centered.
- **T3.1-AC02:** Two available sprites render left/right.
- **T3.1-AC03:** Three available sprites render left/center/right.
- **T3.1-AC04:** More than three scene characters do not cause uncontrolled crowding.
- **T3.1-AC05:** Missing images do not break remaining sprites.
- **T3.1-AC06:** Stage background remains transparent.
- **T3.1-AC07:** Sprite images preserve aspect ratio and are not cropped by the stage.
- **T3.1-AC08:** Hidden/inactive tabs do not continue unnecessary stage activity.

### Verification

**Automated:**
- frontend typecheck
- frontend build

**Runtime/manual:**
- one-character fixture
- two-character fixture
- three-character fixture
- >3 cast fixture
- missing-image fixture
- desktop and mobile width checks

### Constraints & Anti-Patterns

- No opaque portrait cards.
- No manual roster controls.
- No focus/promote controls.
- No image generation.
- No background-image subsystem changes.
- No unrelated refactor.

### API Delta

New `SpriteStage` component API.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded stateful presentation logic.

### Task Completion Boundary

The Sprite Stage can independently render current RP sprite data at a fixed parent-provided height.

---

## Task 3.2 — Add Bounded Late-Image Refresh

### Objective

Allow sprites generated after the assistant response to appear in place without a page reload.

### Architectural Intent

The stage observes late-arriving persisted state. It never drives generation.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/components/chat/SpriteStage.tsx`

**Delete:**
- None

**Expected but unchanged dependencies:**
- existing post-turn character autofire
- sprite-state endpoint

### Required Logical Changes

- Refresh sprite data after a completed RP turn/swipe.
- If expected present characters still lack URLs, perform a bounded retry loop.
- Cancel polling when all currently relevant sprite images are available, retry limit expires, chat changes, tab becomes inactive, or component unmounts.
- Never create an unbounded background poll.
- Reuse existing URLs when they appear.
- Do not call generation endpoints.

### Acceptance Criteria

- **T3.2-AC01:** Cached sprites appear immediately on first fetch.
- **T3.2-AC02:** A newly generated sprite can appear after text rendering without page reload.
- **T3.2-AC03:** Polling stops when resolved or bounded retry expires.
- **T3.2-AC04:** Polling stops on chat switch, hidden tab, or unmount.
- **T3.2-AC05:** No refresh path initiates generation/BGRM.
- **T3.2-AC06:** Swipe to a known combination reuses the existing mapped URL.

### Verification

**Automated:**
- frontend typecheck/build

**Runtime/manual:**
- turn where combination already exists
- turn where image arrives late
- hide/switch tab mid-poll
- swipe between known combinations

### Constraints & Anti-Patterns

- No endless interval.
- No provider polling from frontend.
- No generation fallback.
- No duplicated cache.
- No unrelated refactor.

### API Delta

None.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded asynchronous UI state coordination.

### Task Completion Boundary

Late persisted sprite URLs can appear in place safely and polling lifecycle is bounded.

---

# Phase 4 — Integrate the Stage into RP Chat

**Phase objective:**  
Mount the stage into RP chat, add the show/hide control, and preserve ordinary chat behaviour.

**Phase completion condition:**  
RP chat can show/hide the Sprite Stage without generation coupling, while normal chat remains unchanged.

## Task 4.1 — Mount Sprite Stage and Add Visibility Toggle

### Objective

Integrate the Sprite Stage into `ChatView` for RP chats and add a persistent show/hide control in the bottom chat controls.

### Architectural Intent

The stage is a view preference within RP chat, not a generation switch.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/views/ChatView.tsx`
- `frontend/src/views/ChatView.css`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `SpriteStage`
- existing bottom overlay/composer
- existing character generation/autofire
- ordinary chat header behaviour

### Required Logical Changes

#### `ChatView.tsx`

- Mount `SpriteStage` only for RP chat.
- Add stage show/hide button near existing composer controls.
- Persist visibility using frontend UI preference storage consistent with current app patterns.
- Keep generation/autofire fully independent.
- Provide stage refresh token/signals after completed turns, swipe changes, and other selected-state changes already handled by ChatView.

#### `ChatView.css`

- Give the stage a real layout region above chat history.
- Keep the existing location background behind both.
- Preserve bottom composer overlay behaviour.

### Acceptance Criteria

- **T4.1-AC01:** RP chat can show/hide the stage from the composer control area.
- **T4.1-AC02:** Stage visibility persists across reload/remount according to chosen UI-storage convention.
- **T4.1-AC03:** Hiding the stage returns its layout space to conversation history.
- **T4.1-AC04:** Showing/hiding does not alter image generation, BGRM, prompts, or visual cache identity.
- **T4.1-AC05:** Ordinary non-RP chats remain behaviourally unchanged.
- **T4.1-AC06:** Existing location background remains visible behind the transparent stage.

### Verification

**Automated:**
- frontend typecheck
- frontend build

**Runtime/manual:**
- toggle repeatedly
- reload with stage visible
- reload with stage hidden
- verify no provider request caused by toggle
- compare normal chat regression

### Constraints & Anti-Patterns

- No new toolbar.
- No stage setting inside RP narrative state.
- No backend persistence for this UI preference unless existing app convention already requires it.
- No unrelated refactor.

### API Delta

None expected.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded RP presentation integration.

### Task Completion Boundary

RP chat has a stable show/hideable stage integrated into the existing viewport at fixed height.

---

# Phase 5 — Add Resizable Stage Behaviour

**Phase objective:**  
Replace fixed stage height with direct manipulation while preserving a stable saved normal-layout ratio.

**Phase completion condition:**  
Desktop and mobile users can resize the stage safely, and keyboard appearance never corrupts the saved preference.

## Task 5.1 — Add Draggable Divider and Persisted Ratio

### Objective

Add pointer-driven stage resizing with min/max clamps and persistent ratio storage.

### Architectural Intent

The user directly controls stage size. The preference is a relative normal-layout ratio, never raw pixels.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/components/chat/SpriteStage.tsx`
- `frontend/src/components/chat/SpriteStage.css`
- `frontend/src/views/ChatView.tsx` only if parent ownership of ratio is required by existing layout structure

**Delete:**
- None

**Expected but unchanged dependencies:**
- existing frontend preference/localStorage patterns
- stage integration from Task 4.1

### Required Logical Changes

- Add divider at the stage/chat boundary.
- Support pointer input for mouse and touch.
- Clamp approximately min 20%, default 33%, max 60%.
- Persist normalized ratio after completed deliberate drag.
- Use pointer capture or equivalent reliable global lifecycle.
- Clean up listeners/capture on interruption.
- Ensure chat retains minimum usable height.
- Resize sprites naturally with stage.

### Acceptance Criteria

- **T5.1-AC01:** Divider can be dragged with mouse.
- **T5.1-AC02:** Divider can be dragged with touch/pointer input.
- **T5.1-AC03:** Stage cannot exceed configured safe min/max bounds.
- **T5.1-AC04:** Saved preference is a normalized ratio, not pixel height.
- **T5.1-AC05:** Reload restores the chosen stage ratio.
- **T5.1-AC06:** Browser resizing preserves a meaningful split.
- **T5.1-AC07:** Interrupted drag leaves no stuck pointer/listener state.
- **T5.1-AC08:** Sprite images resize without distortion or cropping.

### Verification

**Automated:**
- frontend typecheck/build

**Runtime/manual:**
- mouse drag
- touch drag
- drag beyond both bounds
- reload
- desktop resize
- mobile orientation

### Constraints & Anti-Patterns

- Do not persist pixels.
- Do not regenerate images on resize.
- Do not add size preset buttons.
- No unrelated refactor.

### API Delta

None expected.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded interaction state and persistence.

### Task Completion Boundary

Stage size is directly draggable and reliably restored under normal viewport conditions.

---

## Task 5.2 — Add Mobile Keyboard-Aware Temporary Clamping

### Objective

Make the Sprite Stage temporarily adapt to virtual-keyboard viewport reduction without changing the user's saved normal size.

### Architectural Intent

Keyboard appearance is temporary viewport state, not a user stage-size preference.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/components/chat/SpriteStage.tsx`
- `frontend/src/components/chat/SpriteStage.css`

**Delete:**
- None

**Expected but unchanged dependencies:**
- browser `visualViewport` where supported
- persisted ratio from Task 5.1

### Required Logical Changes

- Detect meaningful mobile visual-viewport reduction associated with keyboard presentation.
- While keyboard-constrained, retain saved normal ratio unchanged, temporarily clamp/shrink stage as necessary, preserve composer and usable chat area, and prevent resize interaction from writing a keyboard-constrained ratio.
- Restore normal persisted ratio when keyboard closes.
- Remove viewport listeners on unmount.

### Acceptance Criteria

- **T5.2-AC01:** Opening the virtual keyboard does not alter persisted stage ratio.
- **T5.2-AC02:** Stage may shrink temporarily to preserve usable chat/composer space.
- **T5.2-AC03:** Closing the keyboard restores normal preferred stage size.
- **T5.2-AC04:** Divider interaction during keyboard-constrained layout cannot corrupt saved ratio.
- **T5.2-AC05:** Unsupported/missing `visualViewport` degrades safely.
- **T5.2-AC06:** Hidden tabs do not keep unnecessary viewport listeners active.

### Verification

**Automated:**
- frontend typecheck/build

**Runtime/manual:**
- mobile/emulated phone keyboard open/close
- focus/blur composer repeatedly
- rotate with keyboard closed
- attempt resize while keyboard open

### Constraints & Anti-Patterns

- Do not infer a new persisted preference from viewport changes.
- Do not hardcode device-specific keyboard heights.
- No unrelated refactor.

### API Delta

None.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded mobile viewport state behaviour.

### Task Completion Boundary

Normal stage ratio and temporary keyboard-constrained layout are cleanly separated.

---

# Phase 6 — Remove the RP Header and Rehome Its Controls

**Phase objective:**  
Reclaim vertical space by eliminating the dedicated RP chat header while preserving every still-required control and cleanup behaviour.

**Phase completion condition:**  
RP has no reserved top header row, cleanup pill floats, menus remain reachable, and normal chat header behaviour is untouched.

## Task 6.1 — Relocate RP Menu and Auxiliary Header Controls

### Objective

Move all still-required RP header controls to non-header locations before deleting the RP header.

### Architectural Intent

Removing the top bar must not silently delete functional controls.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/views/ChatView.tsx`
- `frontend/src/views/ChatView.css`

**Delete:**
- None

**Expected but unchanged dependencies:**
- existing `chatMenuItems`
- existing menu open/outside-click state
- mobile composer-row RP menu
- canvas-switch behaviour if applicable

### Required Logical Changes

- Rehome desktop RP `⋯` menu into the bottom control/composer area.
- Prefer one responsive menu mount if current structure permits.
- Preserve every existing menu item and behaviour.
- Rehome any required RP mobile Canvas switch if it currently depends on the header.
- Do not create another permanent toolbar.

### Acceptance Criteria

- **T6.1-AC01:** Desktop RP chat menu remains reachable without the header.
- **T6.1-AC02:** Mobile RP chat menu remains reachable.
- **T6.1-AC03:** Existing RP menu actions retain behaviour.
- **T6.1-AC04:** Required Canvas switch remains reachable if applicable.
- **T6.1-AC05:** No new full-width control row is introduced.

### Verification

**Automated:**
- frontend typecheck/build

**Runtime/manual:**
- desktop menu open/close/outside-click
- mobile menu
- each menu action smoke test
- canvas toggle if applicable

### Constraints & Anti-Patterns

- Do not duplicate menu logic.
- Do not drop controls merely because they were header children.
- No unrelated refactor.

### API Delta

None.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** bounded UI control relocation.

### Task Completion Boundary

All required RP header controls have valid non-header homes.

---

## Task 6.2 — Float CleanupStatusPill and Remove RP Header Row

### Objective

Remove the dedicated RP header row and render the existing cleanup pill as a floating overlay near the top of the RP viewport/stage.

### Architectural Intent

The RP viewport begins at the top; the pill floats over it and consumes no dedicated vertical strip.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/views/ChatView.tsx`
- `frontend/src/views/ChatView.css`
- `frontend/src/App.css`

**Delete:**
- None

**Expected but unchanged dependencies:**
- `CleanupStatusPill.tsx`
- normal chat header
- App top-bar collapse state
- mobile drawers

### Required Logical Changes

#### `ChatView.tsx`

- For RP, stop rendering dedicated `chat-top-bar/chat-header`.
- Keep `CleanupStatusPill` owned by ChatView.
- Mount it in a small absolute/floating overlay.
- Preserve its `onSettled` refresh callback.
- For non-RP, preserve existing header.

#### `ChatView.css`

- Add RP floating pill positioning.
- Ensure only the pill's own footprint captures pointer input.
- Ensure it paints above stage/history.
- Do not create compensating full-width padding equal to old header height.

#### `App.css`

- Adjust mobile collapse selectors so App top bars still collapse normally, non-RP chat header still participates, RP absence of chat header causes no layout break, and mobile drawer anchoring is preserved.

### Acceptance Criteria

- **T6.2-AC01:** RP chat has no dedicated full-width top header row.
- **T6.2-AC02:** CleanupStatusPill remains visible/functional when cleanup is enabled.
- **T6.2-AC03:** Pill floats over RP content and does not reserve toolbar-height layout space.
- **T6.2-AC04:** Pill settle callback still refreshes canonical cleaned text.
- **T6.2-AC05:** Ordinary chat header remains unchanged.
- **T6.2-AC06:** App/mobile top-bar collapse still behaves correctly.
- **T6.2-AC07:** No replacement blank/full-width header strip exists.

### Verification

**Automated:**
- frontend typecheck/build

**Runtime/manual:**
- RP with cleanup enabled
- RP with cleanup disabled
- normal chat
- mobile top-bar collapse/reveal
- drawer positioning
- verify pill doesn't block stage width

### Constraints & Anti-Patterns

- Do not move cleanup state ownership to SpriteStage.
- Do not reserve global padding for the pill.
- Do not delete ordinary chat header behaviour.
- No unrelated refactor.

### API Delta

None.

### Validation

- **Tier:** Tier 2
- **Criticality:** Not Critical
- **Reason:** central presentation/layout change but no canonical state change.

### Task Completion Boundary

RP has no dedicated chat header and all former header responsibilities are preserved elsewhere.

---

# Phase 7 — Retire the Legacy Portrait Bridge

**Phase objective:**  
Delete the old first-character avatar display and remove app-level layout accommodation that only existed for it.

**Phase completion condition:**  
Sprite Stage is the only RP character-image presentation surface above chat.

## Task 7.1 — Remove ActivePortrait and App-Level Portrait Row

### Objective

Delete the legacy `ActivePortrait` component and remove its mount/layout support.

### Architectural Intent

RP character presentation now comes from turn-aware visual combinations, not the character's generic avatar.

### Scope

**Create:**
- None

**Modify:**
- `frontend/src/App.tsx`
- `frontend/src/App.css`

**Delete:**
- `frontend/src/components/chat/ActivePortrait.tsx`
- `frontend/src/components/chat/ActivePortrait.css`

**Expected but unchanged dependencies:**
- `activeSceneId` remains for sidebar Cast usage
- `portraitsEnabled` remains for Portrait Studio/other existing uses

### Required Logical Changes

#### `App.tsx`

- Remove `ActivePortrait` import.
- Remove its RP mount.
- Keep `activeSceneId` plumbing because Sidebar Cast still requires it.
- Do not move SpriteStage up into App.

#### `App.css`

- Remove rules whose only purpose is giving `ActivePortrait` a separate row.
- Keep `.view-container-rp` only if still needed for unrelated RP layout.

### Acceptance Criteria

- **T7.1-AC01:** `ActivePortrait` files are deleted.
- **T7.1-AC02:** No remaining imports/usages exist.
- **T7.1-AC03:** RP no longer fetches `characters.avatar` for top-of-chat presentation.
- **T7.1-AC04:** Sidebar Cast still receives active scene state.
- **T7.1-AC05:** App layout has no obsolete portrait-row reservation.

### Verification

**Automated:**
- frontend typecheck/build
- repository search for `ActivePortrait`

**Runtime/manual:**
- RP layout smoke check
- Sidebar Cast smoke check

### Constraints & Anti-Patterns

- Do not remove `activeSceneId`.
- Do not remove Portrait Studio kill-switch logic.
- No unrelated App cleanup.

### API Delta

Removes `ActivePortrait({ apiKey, chatId, sceneId })`.

### Validation

- **Tier:** Tier 1
- **Criticality:** Not Critical
- **Reason:** deletion/cleanup after replacement is already integrated.

### Task Completion Boundary

Legacy portrait bridge is fully gone and no layout dependency remains.

---

# Phase 8 — Integration Hardening

**Phase objective:**  
Verify the complete RP Sprite Stage behaviour across current state, history/swipes, late image arrival, mobile resize/keyboard behaviour, header removal, and normal-chat regressions.

**Phase completion condition:**  
Every Architectural Report criterion and Blueprint file/API contract is accounted for and the branch is ready for final integration review.

## Task 8.1 — Integration Verification and Regression Repair

### Objective

Run the complete verification matrix and repair only integration defects that remain within the finalized plan.

### Architectural Intent

Confirm the finished change faithfully delivers the architecture across all task boundaries.

### Scope

**Create:**
- None unless a small integration verification script is genuinely needed

**Modify:**
- only files already in the finalized Blueprint manifest, and only for defects discovered by integration verification

**Delete:**
- None beyond already-planned legacy deletion

**Expected but unchanged dependencies:**
- all prior tasks

### Required Logical Changes

- Run full relevant orchestrator verification.
- Run frontend typecheck/build.
- Exercise stage hidden/visible, one/two/three/>3 cast, raw and BGRM assets, late image arrival, swipe/history restoration, mobile drag, keyboard open/close, header absence, floating cleanup pill, RP menu, and normal chat regression.
- Review branch diff for unrelated changes.
- Confirm all API deltas match Blueprint.

### Acceptance Criteria

- **T8.1-AC01:** All prior task verifications remain passing.
- **T8.1-AC02:** Every Architectural Report acceptance criterion is mapped to a passing automated or manual verification.
- **T8.1-AC03:** Every Blueprint file is created/modified/deleted or explicitly confirmed unchanged as planned.
- **T8.1-AC04:** No unrelated branch changes remain.
- **T8.1-AC05:** Normal chat remains behaviourally intact.
- **T8.1-AC06:** No unresolved Planning Deviation remains.

### Verification

**Automated:**
- full relevant orchestrator verification
- frontend typecheck
- frontend build
- any project-level verification command required by repository convention

**Runtime/manual:**
- full acceptance matrix above

### Constraints & Anti-Patterns

- Do not redesign during integration.
- Do not weaken acceptance criteria to obtain a pass.
- Any architectural contradiction becomes a Planning Deviation.

### API Delta

None.

### Validation

- **Tier:** Tier 3
- **Criticality:** Critical
- **Reason:** full-system integration gate across I/O, canonical state, and high fan-out UI.

### Task Completion Boundary

The complete implementation is ready for the coding harness Final Integration Gate.

---

# 4. Cross-Task Dependency Ledger

| Task | Depends on | Dependency |
| --- | --- | --- |
| `1.2` | `1.1` | Current sprite-state resolver exists before historical resolution is added |
| `1.3` | `1.1`, `1.2` | Finalized resolver semantics exist before public API exposure |
| `2.1` | `1.3` | Stable server endpoint/response contract exists |
| `3.1` | `2.1` | Typed frontend sprite read contract exists |
| `3.2` | `3.1` | Base stage fetch/render lifecycle exists |
| `4.1` | `3.2` | Stage can render and refresh independently before ChatView integration |
| `5.1` | `4.1` | Integrated stage exists before resizing |
| `5.2` | `5.1` | Persisted normal ratio exists before keyboard-specific clamping |
| `6.1` | `4.1` | Bottom RP controls exist before desktop header controls are moved there |
| `6.2` | `6.1` | Required header controls are relocated before header removal |
| `7.1` | `4.1` | Sprite Stage is integrated before old portrait bridge is deleted |
| `8.1` | all prior tasks | Complete system state required for integration verification |

Tasks `5.1/5.2` and `6.1/6.2` may proceed in either branch order after `4.1`, but each pair must preserve its internal dependency order.

---

# 5. Final Integration Verification

After every task has passed its frozen Task Contract verification and independent review, the coding harness must perform the Final Integration Gate.

### Required checks

- run all sprite-state server verification;
- run relevant character visual-state/autofire verification;
- run project/frontend typecheck and build;
- confirm no new generation/BGRM calls are caused by stage show/hide, stage resize, viewport resize, mobile keyboard, or selection of a known historical swipe;
- confirm current scene cast ordering is preserved;
- confirm late image arrival updates in place;
- confirm hidden tabs do not keep stage polls/viewport listeners active;
- confirm Stage visibility and height preferences are presentation-only;
- confirm location background remains visible behind transparent sprites;
- confirm RP header is gone;
- confirm cleanup pill floats and remains operational;
- confirm RP menu remains fully reachable;
- confirm normal chat header and top-bar collapse still work;
- confirm `ActivePortrait` is deleted and no avatar bridge remains;
- review full branch diff for unrelated changes;
- map every Architectural Report acceptance criterion to verification evidence;
- confirm every Blueprint API Delta and file disposition is satisfied.

### Final Review Inputs

The integration reviewer must receive:

1. `1_ARCHITECTURAL_REPORT.md`
2. finalized `2_BLUEPRINT.md`
3. this `3_IMPLEMENTATION_PLAN.md`
4. full implementation diff
5. deterministic verification results
6. any runtime/manual verification record required by the plan

The final review question is:

**Did the completed implementation faithfully deliver the original RP Sprite Stage architectural intent across the whole change?**
