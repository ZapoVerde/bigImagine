# Architectural Report — RP Character Sprite Stage

## 1. High-Level Goal & Rationale

BigImagine's RP chat should support an optional **Visual Novel-style character sprite stage** above the conversation.

The stage displays the current RP scene's character imagery as large character sprites rather than embedding character images inside individual chat messages or displaying them as small portrait cards.

The stage consumes the **effective final character-image URLs** already produced by the RP character visual pipeline.

Where RP character background removal is enabled, these will normally be transparent BGRM-processed images.

Where background removal is disabled, unavailable, or has failed open, the stage may receive the normal generated character image instead.

The sprite stage does not generate images and does not perform background removal.

Its responsibility is presentation:

```text
RP character visual pipeline
        ↓
effective character-image URLs
        ↓
current scene / turn visual state
        ↓
RP Sprite Stage
        ↓
VN-style character presentation
```

The stage should be:

- optional;
- show/hideable directly from the RP chat controls;
- vertically resizable by dragging a divider;
- persistent in its UI preferences;
- driven by existing RP scene/cast and character-image state;
- capable of updating when character imagery arrives after the text response;
- compatible with swipe/history navigation;
- space-efficient on mobile;
- free of a dedicated top RP-chat toolbar.

The existing top RP-chat bar should be removed.

Any small persistent RP status/control pill currently associated with that bar should retain its existing functional role and positioning logic, but should visually **float over the top area of the Sprite Stage / RP viewport rather than occupying a reserved horizontal toolbar region**.

The pill must not create a blocked-out header area or consume dedicated vertical layout space.

---

## 1.1 Detailed Description

The RP chat becomes conceptually:

```text
┌────────────────────────────────────────┐
│        [ existing RP pill ]            │
│                                        │
│           CHARACTER SPRITES            │
│                                        │
│      Character A     Character B       │
│                                        │
├──────────── draggable divider ─────────┤
│                                        │
│                RP CHAT                 │
│                                        │
│  conversation...                       │
│                                        │
├────────────────────────────────────────┤
│ RP controls including sprite toggle    │
│ message composer                       │
└────────────────────────────────────────┘
```

The pill floats over the top of the RP viewport/stage.

It does not establish a toolbar row.

The space beneath and around it remains usable stage space.

The sprite stage and chat occupy a shared RP-chat viewport.

When the sprite stage is hidden, the chat receives the available space.

When the sprite stage is visible, its persisted height ratio determines how much of that viewport is allocated to the stage.

The divider between the stage and chat is directly draggable.

Dragging changes presentation only.

It must not:

- regenerate character images;
- perform BGRM;
- alter scene cast;
- alter character visual identity;
- create new image-combination mappings;
- mutate conversation history.

The stage height should be stored as a **relative layout ratio**, not a raw pixel height.

The persisted ratio represents the user's preferred split under the normal RP layout, excluding temporary reductions caused by the mobile virtual keyboard.

This allows the preference to remain meaningful across:

- browser resizing;
- different desktop window sizes;
- mobile screens;
- device orientation changes;
- temporary mobile keyboard appearance.

The layout must impose sensible minimum and maximum stage sizes so the user cannot accidentally make either the stage or chat unusable.

---

# 2. Core Principles & Constraints

## 2.1 Governing Project Principles

### Existing RP state remains authoritative

The Sprite Stage does not establish a second source of truth for which characters exist in the scene or which character image belongs to a visual state.

Existing RP scene/cast and character-image state remain authoritative.

The stage derives its presentation from that state.

### Image URLs remain references

The stage consumes character-image URLs.

It does not download, copy, proxy, Base64-encode, or locally persist image assets.

### Presentation remains separate from generation

Image generation and BGRM determine which image URL represents a character visual combination.

The Sprite Stage determines how that URL is displayed.

Neither concern should own the other.

### UI preferences remain presentation state

Whether the Sprite Stage is visible and how tall it is are UI preferences.

They are not RP narrative state and must not affect prompts, generation keys, image cache identity, or conversation semantics.

### Mobile space is treated as scarce

The RP interface should avoid permanently reserving vertical space for controls that can safely overlay content.

The existing top RP-chat bar is therefore removed.

The existing RP pill remains available but floats over the RP viewport rather than owning a dedicated toolbar row.

### Mobile usability remains required

The stage, divider, floating pill, toggle, chat, and composer must remain usable at phone width.

The resize divider must have a sufficiently generous interaction target for touch input even if its visible line is visually thin.

---

## 2.2 Change-Specific Principles

### The stage consumes the final character-image contract

The BGRM architecture defines the effective final character image:

- generated URL when BGRM is disabled;
- BGRM URL when BGRM succeeds;
- generated URL when BGRM was requested but fails open.

The Sprite Stage consumes that result.

It must not need to understand how the URL was produced.

### Show/hide does not control generation

The Sprite Stage visibility toggle controls presentation only.

Hiding the stage must not disable:

- character visual extraction;
- image generation;
- BGRM;
- character-image combination caching;
- persistence of generated image URLs.

### Resizing does not control generation

Dragging the divider affects only stage/chat layout.

No resize operation may trigger image generation or BGRM.

### Stage size is persisted as a ratio

The user's chosen stage size should be represented by a normalized ratio or percentage of the normal available RP-chat viewport.

The implementation should clamp that ratio to safe limits.

A sensible initial range is approximately:

```text
minimum stage: ~20%
default stage: ~33%
maximum stage: ~60%
```

The chat must always retain a usable minimum area.

### The mobile keyboard does not redefine the saved stage size

Opening the virtual keyboard temporarily reduces the usable visual viewport.

That temporary viewport reduction must not overwrite the user's persisted Sprite Stage ratio.

While the keyboard is open:

- the saved stage ratio remains unchanged;
- the rendered stage may be temporarily reduced or clamped;
- enough space must remain for the composer and a usable portion of chat;
- divider resizing should be disabled or otherwise prevented from persisting a keyboard-constrained ratio.

When the keyboard closes, the stage returns to the persisted normal-layout ratio.

### Sprites scale with the available stage

Character sprites should be bottom-anchored within the stage and scale according to the available stage dimensions.

Increasing stage height should naturally allow larger character presentation.

Decreasing stage height should shrink the sprites.

The implementation should preserve image aspect ratio.

### The scene determines stage membership

The Sprite Stage should derive visible characters automatically from the current RP scene/cast state.

The initial implementation should not introduce PersonaLyze-style manual roster management.

### Initial stage population should remain deliberately simple

The first implementation should support a small number of simultaneously displayed sprites cleanly:

- 1 character — centred;
- 2 characters — left/right;
- 3 characters — left/centre/right.

Scenes may contain more characters than the stage displays.

The stage's display limit must not become a limit on scene cast data.

### Late-arriving imagery updates in place

RP text completion must not wait for character-image generation or BGRM.

When a character's effective image URL becomes available later, the corresponding stage sprite updates in place.

### Historical navigation restores historical visual state

When the user navigates between RP swipes/turn variants, the stage should resolve character imagery corresponding to the selected conversation state.

Existing character-image mappings should be reused.

### Missing imagery is not a stage failure

A scene character may temporarily or permanently have no usable character image.

The stage renders the characters for which usable imagery exists without treating missing imagery as fatal.

### The floating RP pill does not own layout space

Removing the top RP-chat bar must not be replaced by an equivalent blank/header region.

The existing pill should:

- retain its current semantic role;
- remain positioned near the top of the RP viewport;
- float above stage/chat content;
- use normal overlay/z-index behaviour;
- not force padding equivalent to the removed toolbar height.

Small local spacing required to prevent the pill itself obscuring essential interactive content is acceptable.

A full-width reserved strip is not.

---

## 2.3 Explicit Non-Goals

The following are outside this architectural change:

- implementing character image generation;
- implementing Runware BGRM;
- changing BGRM engine profiles;
- changing character image combination/cache identity;
- applying BGRM to location backgrounds;
- embedding character images into individual chat messages;
- introducing manual VN roster management;
- introducing PersonaLyze-style focus promotion controls;
- introducing sprite scroll arrows;
- introducing a VN hamburger/menu system;
- allowing direct drag-and-drop repositioning of individual characters;
- defining complex speaker emphasis or animation;
- lip sync;
- sprite animation;
- modifying character prompts based on stage position;
- generating different images merely because the stage was resized;
- storing stage dimensions in conversation history;
- making stage visibility part of RP narrative state;
- redesigning the existing RP pill's function;
- replacing the removed top bar with another persistent full-width header.

---

# 3. Architectural Flows

## 3.1 User Flow

### Enter RP Chat

1. The RP chat opens without a dedicated top toolbar.
2. The existing RP pill remains available as a floating overlay near the top of the RP viewport.
3. The pill does not consume a dedicated row of vertical space.
4. The persisted Sprite Stage visibility and height preferences are restored.

### Show Sprite Stage

1. The user enables the Sprite Stage using a control with the existing RP controls near the composer.
2. BigImagine restores the persisted stage height.
3. The stage derives relevant characters from current RP state.
4. Available effective character-image URLs are displayed.
5. The conversation occupies the remaining RP viewport.

### Hide Sprite Stage

1. The user presses the Sprite Stage toggle.
2. The stage leaves the visible layout.
3. The conversation expands into the released space.
4. Character visual processing continues normally.
5. The persisted stage height is retained.

### Resize Sprite Stage

1. The user presses or touches the divider between stage and conversation.
2. Pointer movement changes the split live.
3. The split is clamped to safe bounds.
4. Sprites scale with the stage.
5. On completion, the resulting normal-layout ratio is persisted.
6. No character-image processing is triggered.

### Mobile Keyboard Opens

1. The user focuses the RP composer.
2. The virtual keyboard reduces the visual viewport.
3. The normal persisted stage ratio remains unchanged.
4. The stage is temporarily reduced/clamped as required to preserve usable chat and composer space.
5. Resize persistence is suspended while the keyboard-constrained layout is active.
6. The floating RP pill remains an overlay and does not cause additional vertical reservation.

### Mobile Keyboard Closes

1. The normal visual viewport returns.
2. The stage restores its persisted normal-layout ratio.
3. No new stage size is written merely because the viewport changed.

### New RP Turn

1. RP text completes normally.
2. Current scene/cast state determines which characters belong on the stage.
3. Existing cached imagery can appear immediately.
4. New imagery may continue generating asynchronously.
5. As effective image URLs arrive, the stage updates corresponding sprites in place.

### Swipe/History Navigation

1. The user selects another RP turn/swipe state.
2. RP state changes to the selected historical state.
3. The stage derives its presentation from that state.
4. Existing character-image mappings are resolved.
5. Previously generated URLs are reused where available.

---

## 3.2 Data Flow

```text
RP conversation state
        ↓
current selected turn/swipe
        ↓
scene/cast + character visual combinations
        ↓
existing character-image mapping
        ↓
effective final image URLs
        ↓
Sprite Stage presentation selector
        ↓
1–3 visible sprite slots
        ↓
resizable VN-style stage
```

Separately:

```text
user UI preferences
        ↓
spriteStageVisible
spriteStageHeightRatio
        ↓
RP chat layout
```

Temporary viewport state remains separate:

```text
visual viewport / virtual keyboard state
        ↓
temporary stage clamp
        ↓
rendered layout only
```

The temporary keyboard-adjusted layout must not overwrite `spriteStageHeightRatio`.

---

## 3.3 Layout Flow

```text
RP viewport
    ↓
top toolbar?
    ↓
none — floating pill overlays viewport
    ↓
stage visible?
 ├─ no
 │    ↓
 │  chat uses normal available viewport
 │
 └─ yes
      ↓
 read persisted normal stage ratio
      ↓
 keyboard reducing viewport?
   ├─ no → apply persisted ratio
   │
   └─ yes → temporarily clamp stage
      ↓
 allocate:
   sprite stage
   divider
   chat
      ↓
 stage dimensions change
      ↓
 sprite presentation recalculates
```

The browser layout remains the source of truth for actual pixel dimensions.

Persisted state stores the desired normal relative split only.

---

## 3.4 Late Image Flow

```text
assistant turn becomes visible
        ↓
scene character requires new visual combination
        ↓
stage renders available existing sprites
        ↓
character generation continues asynchronously
        ↓
optional BGRM
        ↓
effective final URL becomes available
        ↓
existing RP character-image state updates
        ↓
Sprite Stage observes new state
        ↓
character sprite updates in place
```

---

## 3.5 Failure Flow

### Character image unavailable

The RP chat remains usable and other available sprites continue rendering.

### Character image generation fails

Existing character-image failure handling remains authoritative.

### BGRM fails

The BGRM pipeline's fail-open result remains authoritative.

The Sprite Stage does not retry BGRM itself.

### Persisted stage ratio is invalid

Use a safe default and clamp invalid numeric values.

### Pointer resize is interrupted

Terminate resize state safely and retain the latest valid layout.

### Mobile keyboard detection/layout adjustment fails

The RP composer and chat remain higher priority than preserving the full requested sprite-stage size.

The implementation should favour a usable chat/composer over preserving exact stage dimensions.

The persisted normal stage ratio must remain intact.

### Floating pill overlaps content

The solution should adjust the pill's local positioning or the specific interactive element underneath it.

It should not reintroduce a full-width reserved top bar.

---

# 4. Overall Acceptance Criteria

- **AC-01:** RP chat can display an optional VN-style Sprite Stage above the conversation.
- **AC-02:** The stage can be shown or hidden using a control integrated near the RP composer.
- **AC-03:** Hiding the stage returns its layout space to the conversation.
- **AC-04:** Showing or hiding the stage does not affect generation or BGRM.
- **AC-05:** A divider between stage and chat can be dragged to resize the stage.
- **AC-06:** Resize interaction supports mouse and touch/pointer input.
- **AC-07:** Stage/chat sizing is constrained to safe usable bounds.
- **AC-08:** Stage size is persisted as a relative normal-layout ratio rather than pixels.
- **AC-09:** Reopening RP chat restores the stage visibility and normal preferred height.
- **AC-10:** Browser resizing and orientation changes preserve a meaningful split.
- **AC-11:** Opening the mobile virtual keyboard does not overwrite the persisted stage ratio.
- **AC-12:** While the keyboard is open, the rendered stage may temporarily shrink to preserve usable chat and composer space.
- **AC-13:** Closing the keyboard restores the persisted normal-layout stage size.
- **AC-14:** Keyboard-constrained resizing cannot accidentally persist a reduced stage ratio.
- **AC-15:** Character sprites preserve aspect ratio and remain bottom-anchored.
- **AC-16:** Sprite size responds to available stage dimensions.
- **AC-17:** The Sprite Stage consumes existing effective character-image URLs.
- **AC-18:** BGRM-transparent images can be displayed directly.
- **AC-19:** A raw fallback image can still be displayed where that is the effective result.
- **AC-20:** Stage membership derives from existing RP scene/cast state.
- **AC-21:** One-, two-, and three-character stage layouts are deterministic and usable.
- **AC-22:** More than three scene characters do not cause uncontrolled crowding.
- **AC-23:** Existing mapped imagery appears immediately where available.
- **AC-24:** Late image results update the stage in place.
- **AC-25:** Swipe/history navigation updates the stage to the selected RP state.
- **AC-26:** Previously known visual combinations reuse their existing mapped URLs.
- **AC-27:** Stage interaction does not trigger unnecessary regeneration.
- **AC-28:** Missing imagery does not break the RP conversation or remaining sprites.
- **AC-29:** Invalid persisted layout state falls back safely.
- **AC-30:** The resize divider remains touch-friendly at mobile widths.
- **AC-31:** Stage UI preferences do not enter RP prompts, narrative state, visual combination identity, or image cache keys.
- **AC-32:** No local image storage, proxying, or duplicated image persistence is introduced.
- **AC-33:** Existing RP chat behaviour remains unchanged when the stage is hidden, except for removal of the top RP-chat toolbar.
- **AC-34:** The existing dedicated top RP-chat bar is removed.
- **AC-35:** The existing RP pill retains its function and remains near its current top-of-chat location.
- **AC-36:** The RP pill floats over the RP viewport/stage rather than occupying a dedicated layout row.
- **AC-37:** Removing the top bar increases usable vertical RP-chat space, particularly on mobile.
- **AC-38:** No replacement full-width header or equivalent blank vertical reservation is introduced.
- **AC-39:** Any pill/content collision is solved locally rather than by reserving a toolbar-height strip across the viewport.
