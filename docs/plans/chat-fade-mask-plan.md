# Chat History — Alpha Mask Fade (replacing the per-bubble blur-clone system)

*Status: implemented (line numbers below refer to the 2026-08-11 snapshot; the code has since
drifted). Replaces the blur-clone system with the `.chat-history` alpha mask; JS side is just
the `--chat-fade-px` write inside the existing overlay ResizeObserver. Verified with
`tsc --noEmit` and `vite build`; the §7 browser checks remain manual.*

## 1. Purpose

An external spec asked for the chat container's "backdrop-blur box" to be replaced with a CSS
alpha mask on the messages scroll area, for mobile GPU performance. The literal element the spec
describes (a fixed pseudo-element doing `backdrop-filter`) doesn't exist in this codebase — but the
thing that actually exists is worse for the stated problem, not better: `syncUnderControls`
(`ChatView.tsx:483-553`) is a rAF-throttled, per-frame **JavaScript** routine that, on every scroll
tick, message-count change, and resize:

- walks every `.chat-message`/`.chat-bubble.pending` element near the bottom via
  `querySelectorAll` + `getBoundingClientRect`,
- clones the DOM node of any bubble crossing "the line" (`el.cloneNode(true)`),
- writes `clip-path` and `filter: blur(5px)` inline styles on both the original and the clone every
  frame it's dirty, and
- appends/removes the clones from a dedicated overlay layer (`.chat-under-clone-layer`).

This is real layout thrash plus per-element `filter: blur()` compositing — exactly the mobile GPU
cost the spec is trying to eliminate, just produced by hand-rolled JS instead of `backdrop-filter`.
The fix the spec asks for — a static `mask-image` gradient on the scroll container — applies
directly here and is a strictly bigger win than in the spec's assumed starting point, because it
deletes an entire rAF loop and DOM-cloning system, not just a filter property.

## 2. Non-Goals

- **Not** touching the location-background/parallax layers (`.chat-location-background`,
  `.chat-location-overlay`) — those already sit behind the chat content at `z-index: 0` and are
  unaffected by this change; they're *why* this change matters (the wallpaper is what shows through
  the newly-transparent zone).
- **Not** changing `.chat-bottom-overlay`'s own transparency, pointer-event-swallowing, or its role
  as the height reference for the fade zone (§4.3 below) — it stays exactly what it is today, just
  loses its job of being the thing `syncUnderControls` measures bubbles against.
- **Not** a general-purpose fade utility. This is specific to `.chat-history`; no shared CSS class
  or hook is being extracted for a single call site (`bi_principles.md` §10).
- **Not** adding a JS fallback for browsers without `mask-image` support. Unsupported browsers just
  keep the old hard cutoff (full opacity, no fade) — acceptable degradation, not a regression, and
  not worth a feature-detection branch for a single-user platform (§8 covers this).

## 3. Current State (verified against the code)

- `.chat-history` (`ChatView.css:583-590`, ref: `historyRef`) is the scrollable messages container:
  `flex: 1; overflow-y: auto`, sized by flexbox to fill `.chat-main` below the header. Its box
  bottom edge coincides with `.chat-main`'s bottom edge (no flex siblings below it in normal flow).
- `.chat-bottom-overlay` (`ChatView.css:116-124`, ref: `bottomOverlayRef`) is `position: absolute;
  bottom: 0`, transparent, holding the staging bars, delete bar, and the input row. Its **top
  edge** is "the line" referenced throughout the existing code and comments. Because it's
  `bottom: 0` inside `.chat-main`, its bottom edge is the same point as `.chat-history`'s box
  bottom — i.e. today's "threshold line" and "entry box bottom" from the spec already correspond to
  `bottomOverlayRef`'s top and `.chat-history`'s own box bottom, respectively.
- An existing `ResizeObserver` (`ChatView.tsx:563-578`) already watches `bottomOverlayRef` and
  recomputes `history.style.paddingBottom` from `overlay.offsetHeight` on every change (staging bar
  appears, textarea grows, delete bar shows). This is the dynamic-measurement machinery the spec's
  §3 asks for — it already exists and just needs a second output (a CSS variable) added alongside
  the padding it already writes.
- `syncUnderControls` is invoked from four places: the ResizeObserver above (`:572`), a
  `messages.length` effect (`:582-584`), a per-message-element `ResizeObserver` (`:588-595`), and
  `handleHistoryScroll` (`:690`). All four calls and the per-message observer are removed by this
  plan (§4.1) — none of them have any other purpose.
- `.chat-under-clone-layer` (`ChatView.css:131-137`, JSX at `ChatView.tsx:1719`) exists solely to
  host the blur clones. Removed entirely.
- Pointer events for the fade zone are already handled correctly and need no change: because
  `.chat-bottom-overlay` is a later DOM sibling at the same `z-index: 1` as `.chat-history`
  (`ChatView.css:101-104`, `:121`), it paints on top of and physically intercepts clicks/taps over
  its own footprint regardless of what's rendered (or how transparent) underneath. Masking bubbles
  to near-zero opacity in that strip doesn't change what's clickable — the overlay was already
  swallowing those events before this change.

## 4. Target Design

### 4.1 Delete the blur-clone system

Remove from `ChatView.tsx`:
- `UNDER_CONTROLS_BLUR`, `underControlsRafRef`, `underCloneLayerRef`, `underCloneRefs`,
  `underTouchedRef` (`:483-487`)
- `syncUnderControls` in full (`:488-553`)
- the per-message `ResizeObserver` effect (`:588-595`)
- the `messages.length` effect that exists only to call `syncUnderControls` (`:582-584`)
- the `syncUnderControls()` call inside `handleHistoryScroll` (`:690`) — the rest of that handler
  (top-bar collapse logic) stays
- the `<div className="chat-under-clone-layer" ref={underCloneLayerRef} ... />` JSX (`:1719`) and
  its explanatory comment (`:1716-1718`)

Remove from `ChatView.css`:
- `.chat-main > .chat-under-clone-layer` (`:131-137`)
- the "Slice under the controls" framing in the `.chat-bottom-overlay` comment (`:106-115`) gets
  rewritten to describe the mask instead (it currently documents the blur-clone mechanism this plan
  deletes)

### 4.2 Apply the mask to `.chat-history`

```css
.chat-history {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  /* Fades messages to transparent through the entry-box strip instead of the old per-bubble
     blur-clone system (chat-fade-mask-plan.md): opaque until --chat-fade-px above the box
     bottom, then a linear falloff to 0%. --chat-fade-px tracks .chat-bottom-overlay's live
     height (ChatView.tsx's overlay ResizeObserver) so the fade always spans exactly the input
     stack's footprint, however tall it currently is. */
  -webkit-mask-image: linear-gradient(
    to bottom,
    black 0,
    black calc(100% - var(--chat-fade-px, 0px)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    black 0,
    black calc(100% - var(--chat-fade-px, 0px)),
    transparent 100%
  );
}
```

This is a single declaration on the existing rule — no new element, no new stacking context beyond
what `.chat-history` already has (`position: relative; z-index: 1` from the blanket rule at
`ChatView.css:101-104`).

### 4.3 Wire `--chat-fade-px` through the existing ResizeObserver

Extend the `sync()` closure at `ChatView.tsx:567-573` (currently writes only `paddingBottom`) to
also set the CSS variable from the same `overlay.offsetHeight` read already in hand:

```ts
const sync = () => {
  const base = parseFloat(getComputedStyle(history).paddingTop) || 16;
  const spacer = history.querySelector<HTMLElement>('.chat-history-spacer');
  const spacerH = spacer?.offsetHeight ?? 0;
  history.style.paddingBottom = `${Math.max(base, overlay.offsetHeight + base - spacerH)}px`;
  history.style.setProperty('--chat-fade-px', `${overlay.offsetHeight}px`);
};
```

No new `ResizeObserver`, no new effect — this is one extra line inside a callback that already
fires on every overlay height change (staging bar in/out, textarea growing, delete bar toggling).

### 4.4 GPU layer promotion (mobile)

Add to the same `.chat-history` rule:

```css
will-change: mask-image;
```

Test on iOS Safari specifically (§7) before deciding whether `transform: translateZ(0)` is also
needed — older WebKit has historically needed an explicit transform hint to promote masked elements
to their own compositor layer, but recent versions may not. Don't add it speculatively; add it only
if the mobile pass in §7 shows it's still needed after `will-change: mask-image` alone.

## 5. Geometry mapping (spec's three zones → this codebase)

| Spec zone | This implementation |
|---|---|
| Zone 1 — opaque, top to threshold line | `0` to `calc(100% - var(--chat-fade-px))` of `.chat-history`'s own box height — mask stays solid black (fully opaque) |
| Zone 2 — linear falloff, threshold line to entry-box bottom | The `var(--chat-fade-px)` span at the bottom of the gradient, sized to exactly `bottomOverlayRef.offsetHeight` — black to transparent |
| Zone 3 — fully transparent below entry-box bottom | Needs no separate rule: `.chat-history`'s box *ends* at the same point `.chat-bottom-overlay`'s bottom does (§3), so there is no space below the mask's `100%` stop for content to bleed into — it's structurally impossible, not just masked to invisible |

Because `mask-image`'s percentage stops resolve against the *masked element's own box* (the visible
scroll viewport), not the scrolled content height, this mask stays pinned to the viewport as content
scrolls underneath it — no per-scroll recalculation needed, which is the entire performance win over
`syncUnderControls`.

## 6. Step-by-step

1. `ChatView.css:583-590` — add the `mask-image`/`-webkit-mask-image` and `will-change` declarations
   to `.chat-history` (§4.2, §4.4).
2. `ChatView.css:106-137` — delete `.chat-main > .chat-under-clone-layer` (`:131-137`); rewrite the
   `.chat-bottom-overlay` comment block (`:106-115`) to describe the mask instead of the blur-clone
   mechanism.
3. `ChatView.tsx:483-487` — delete the now-unused refs/constant.
4. `ChatView.tsx:488-553` — delete `syncUnderControls`.
5. `ChatView.tsx:563-578` — add the `--chat-fade-px` line to `sync()` (§4.3); leave the rest of the
   effect (padding-bottom sync, `ResizeObserver` on `overlay`) untouched.
6. `ChatView.tsx:582-584` — delete the `messages.length` effect.
7. `ChatView.tsx:588-595` — delete the per-message `ResizeObserver` effect.
8. `ChatView.tsx:690` — delete the `syncUnderControls()` call inside `handleHistoryScroll`; keep the
   rest of the function.
9. `ChatView.tsx:1716-1719` — delete the clone-layer JSX and its comment.
10. Grep the file for any other `underClone`/`syncUnderControls`/`UNDER_CONTROLS_BLUR` references
    to make sure nothing is left dangling.

## 7. Verification

- **Desktop Chrome/Firefox:** open a chat with enough messages to scroll; confirm the fade starts
  exactly at the input row's top and messages are fully invisible by the row's bottom, at rest and
  while scrolling.
- **Resize the entry box:** grow the textarea (multi-line paste), trigger the staging bar (attach a
  file) and the delete bar (selection mode) — confirm the fade span visibly grows/shrinks with the
  overlay's height in real time, with no stale gap or premature cutoff.
- **Mobile (real device or remote-debugged Chrome/Safari on a phone):** scroll a long chat fast;
  confirm smooth 60fps with no stutter, and decide on the `translateZ(0)` question from §4.4.
- **Location background:** with a wallpaper set, confirm the image reads fully sharp behind the
  fade zone — no residual blur anywhere (this is the main visual regression risk if any old `filter`
  inline style is left behind on a message element from before this change; a hard refresh clears
  it, but check a long-running tab that had the old code applied first).
- **Both chat bubble themes / legibility toggles** (`ChatView.css:627+`) — confirm the mask doesn't
  visually fight with the existing bubble opacity (`color-mix` fills) — it shouldn't, since mask
  and background-alpha compose independently, but check exactly one bubble crossing the line to be
  sure.
- **Principle 19 (mobile-first):** verify at phone width specifically, not just resized desktop
  Chrome — the `.chat-input` mobile wrap layout (`ChatView.css:1087-1108`) changes the overlay's
  height composition and is the real-world case this whole plan is for.

## 8. Risks / open questions

- **Browser support:** `mask-image` (unprefixed) is supported in current Chrome/Firefox/Safari;
  `-webkit-mask-image` covers older Safari/iOS. No known target browser lacks both. If one somehow
  does, it degrades to a hard opaque cutoff at the box bottom — not a crash, not a broken layout,
  just the pre-existing "hard line" look the spec is trying to move away from. Acceptable per §2.
- **Stale inline styles from the old system:** any bubble mid-transition (clip-path/filter applied)
  at the moment this ships needs those inline styles gone — since the whole code path is deleted,
  no code remains that could *write* them, but double-check no stray `style` attributes linger from
  a previous session's live DOM during manual testing (a fresh load has none).
- **`will-change: mask-image` cost:** `will-change` reserves a compositor layer persistently, which
  has its own (much smaller) memory cost. Given `.chat-history` is a single, long-lived element with
  the platform's chat as its home surface (`bi_principles.md` §5), this is the right tradeoff — just
  don't copy this pattern onto short-lived or frequently-mounted elements elsewhere without the same
  justification.
