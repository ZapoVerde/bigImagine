# Mobile Side-Panel Edge-Swipe Implementation Plan

*Created 2026-08-20. Governed by `bi_principles.md`, principle 18 (Mobile-First). Verified against
the current codebase (frontend package `@bigbrain/frontend`) before write-up; see verification
notes inline. Implemented by Reasonix 2026-08-20; reviewed by Claude Code — see the end of this
file for the review note. Per `docs/roles.md`, this is a `-plan.md`, not a `-repair.md`: it stays
as reference even though the work is now shipped.*

## Goal

Restore mobile edge swipes as the primary way to open the app's side panels, while retaining the
existing 6 px edge grips as tap fallbacks.

- Swipe right from the left screen edge to open the contextual left sidebar.
- Swipe left from the right screen edge to open Chat/RP Chat settings.
- Apply the left-edge behaviour everywhere the active tab actually has sidebar content.
- Apply the right-edge behaviour to both ordinary Chat and RP Chat.
- Remove RP Chat's touch gesture for browsing message alternatives.
- Preserve message alternatives, regeneration, and their explicit `‹` / `›` controls. This change
  removes only the touch gesture.
- Keep desktop behaviour unchanged.

## What the current code does

- `frontend/src/hooks/useBottomThirdSwipe.ts` owns a window-level mobile gesture. A horizontal
  drag beginning in the bottom third navigates the last assistant reply's stored alternatives.
- `frontend/src/views/ChatView.tsx` computes the last swipeable assistant message
  (`swipeTarget`, ~line 602) and connects that hook to the existing `swipe()` operation
  (`useBottomThirdSwipe` registration at ~line 615).
- `frontend/src/App.tsx` owns `sidebarCollapsed` (line 62) and renders the left edge grip only for
  tab types listed in `SIDEBAR_CONTENT_TABS` (line 42: `chat`, `rp`, `characters`, `notes`,
  `portraits` — confirmed against `Sidebar.tsx`'s content switch, which renders real content only
  for those five cases; every other tab type falls to its `default` and gets an empty drawer).
- `frontend/src/views/ChatView.tsx` owns `settingsCollapsed` (line 565) and renders the right edge
  grip for every Chat/RP Chat.
- Both drawers are already mobile overlays (`Sidebar.css`, `ChatView.css`). No layout or server
  changes are required.
- Commit `4a2b3b93c26a863a125d2167eeb847599a50528f` ("mobile: replace rail-summoning FABs with
  edge grips + edge swipes") contains the former `useEdgeSwipe.ts`. Commit
  `88c62579b7f954e20a2be0a72577bef170abbfd6` ("mobile: grip-grab drawer summons + bottom-third nav
  swipes") replaced it with the current bottom-third message gesture. A later fix, commit
  `dcd82a6724f4b4132e26f0d421267d0b4f72346f`, added `.chat-settings-rail`, `.branch-map-panel`,
  `.canvas-panel`, and `.chat-restart-dialog` to `useBottomThirdSwipe`'s skip selector after those
  overlays were found to leak touches to the hidden message underneath. **That fix never added
  `.chat-sync-status-overlay`** (`ChatView.css` line ~1401, a `position: fixed; inset: 0; z-index:
  40` scrim rendered when `syncStatusOpen` is true) — it's the same class of bug, just not caught
  in that pass. The restored hook's skip selector must include it from the start.

## Files to change

### 1. Restore `frontend/src/hooks/useEdgeSwipe.ts`

Reintroduce the reusable mobile edge-swipe hook, based on the previous implementation
(`git show 4a2b3b93c26a863a125d2167eeb847599a50528f:frontend/src/hooks/useEdgeSwipe.ts`) but
reviewed against the current UI rather than restored verbatim — the skip selector in particular
predates several overlays that now exist.

Implement:

- Accept `side: 'left' | 'right'`, an `onOpen` callback, and `enabled` / `canOpen` guards.
- Attach `touchstart`, non-passive `touchmove`, `touchend`, and `touchcancel` listeners only
  while enabled.
- Gate every gesture with the existing mobile breakpoint: `(max-width: 768px)`.
- Accept a gesture only when it starts inside the edge band. The prior implementation used 20 px.
- Require movement inward from that edge:
  - Left edge: positive horizontal movement.
  - Right edge: negative horizontal movement.
- Require a deliberate horizontal threshold. The prior implementation used 28 px.
- Abandon a gesture once vertical movement clearly dominates so normal page/chat scrolling and
  the top-bar pull gesture continue to work.
- Call `preventDefault()` only after the gesture has passed all checks and has been claimed.
- Fire once per touch sequence.
- Store `onOpen` and `canOpen` in refs so inline callbacks do not repeatedly subscribe window
  listeners.
- Keep the gesture open-only. Closing continues through each panel's existing close/toggle
  control; swiping an already-open panel must not toggle it shut.
- Update the skip selector for the current app. The prior version only skipped `.chat-bubble,
  .chat-input, .chat-select-box, input, textarea, .app-top-bars` — written when bubbles still
  owned a variant-swipe gesture, before any of the current mobile overlays existed. It must not
  claim touches beginning on:
  - Form controls.
  - The composer.
  - Selection controls.
  - Staging bars (`.staging-bar`, `.image-staging-bar`).
  - Horizontally scrollable top bars (`.app-top-bars`).
  - Edge grips (`.edge-grip`).
  - Any open modal or floating panel.
- Include the current chat overlays, confirmed present in `ChatView.tsx`/`.css` today:
  - `.chat-settings-rail`
  - `.branch-map-panel`
  - `.canvas-panel`
  - `.chat-restart-dialog`
  - `.chat-sync-status-overlay` — missing from every prior skip selector; add it here.
  - App navigation (`AppNavDrawer`) and other modal surfaces.
- Ensure an edge drag cannot open a drawer underneath a foreground dialog.
- Preserve cleanup of all listeners on disable or unmount.

Do not restore the old claim that chat bubbles own a message-variant gesture (the prior skip
selector's `.chat-bubble` entry existed only for that purpose). After this change, they do not,
and `.chat-bubble` does not need to reappear in the new selector.

### 2. Delete `frontend/src/hooks/useBottomThirdSwipe.ts`

This hook exists solely for the Chat/RP Chat message-alternative touch gesture. Once `ChatView`
no longer imports it, delete it rather than leaving dead gesture code available for accidental
reuse.

No API, database, or message model code is removed. The word "swipe" remains valid in the
data/API domain because message alternatives are still called swipes internally
(`swipe(messageId, direction)`, `SwipeResult`).

### 3. Update `frontend/src/App.tsx`

This is the owner of the left sidebar state, so it should own the left-edge gesture.

Implement:

- Import `useEdgeSwipe`.
- Derive a single `hasSidebarContent` boolean from the active tab and `SIDEBAR_CONTENT_TABS`
  (currently computed inline at the edge-grip's render condition, line 263 — factor it out so
  both the gesture and the grip share one boolean).
- Use the same boolean for both the gesture and the existing edge-grip render condition so the
  two opening mechanisms cannot drift apart.
- Register `useEdgeSwipe('left', ...)` at component scope.
- On a valid left-edge swipe, explicitly open the sidebar with:

  `setSidebarCollapsed(false)`

  Do not toggle it.
- Enable or allow the gesture only when:
  - The active tab has real sidebar content.
  - The sidebar is collapsed.
  - The app navigation drawer is not open.
- Keep the left edge-grip button and its current click fallback. Its click may continue toggling
  because the open drawer covers the grip on mobile, although using an explicit open is also
  acceptable for clarity.
- Rewrite the stale comments that currently say the grip is the only summon and there is no edge
  swipe (`App.tsx` lines ~256–262, and the `SIDEBAR_CONTENT_TABS` comment at line ~38 if it makes
  the same claim).

`navOpen` (the app-nav-drawer state) is owned by `App.tsx` itself (confirmed at implementation
time — an earlier draft of this plan incorrectly flagged it as owned by `ChatView.tsx`), so the
`canOpen` guard can read it directly with no ownership issue.

Coverage from the existing tab set remains:

- `chat`
- `rp`
- `characters`
- `notes`
- `portraits`

Tabs whose `Sidebar.tsx` branch renders no content must not gain a useless swipe target.

### 4. Update `frontend/src/views/ChatView.tsx`

This file owns both the obsolete message gesture and the right settings drawer.

Remove:

- The `useBottomThirdSwipe` import (line 62).
- The `swipeTarget` `useMemo` block used only by the bottom-third gesture (~line 602).
- The `useBottomThirdSwipe(...)` registration and its direction-to-`swipe()` callback (~line 615).
- Comments describing bottom-third message navigation (~lines 593–601).
- Comments saying the right grip is the only drawer summon (~line 597, and the matching
  `ChatView.css` comment at ~line 348).

Add:

- Import `useEdgeSwipe`.
- Register `useEdgeSwipe('right', ...)` from `ChatView`.
- Open settings with:

  `setSettingsCollapsed(false)`

  Do not toggle it.
- Enable the listener only for the active mounted tab, reusing the same `active` prop the
  removed `useBottomThirdSwipe` call already gated on (`enabled: active`) — `App.tsx` keeps
  inactive `ChatView` instances mounted, so this guard is required to prevent hidden chats
  reacting to the same touch.
- Allow the gesture only while the settings rail is collapsed and no blocking in-chat surface is
  open. Confirmed state to gate on: `branchMapOpen`, `mobileShowCanvas` (Canvas — note the actual
  state name is `mobileShowCanvas`, not a generic "canvas open" flag), `restartOpen`,
  `syncStatusOpen`.
- At minimum, account for:
  - Branch Map (`branchMapOpen`).
  - Canvas (`mobileShowCanvas`).
  - Restart confirmation (`restartOpen`).
  - Standalone sync status (`syncStatusOpen`).
  - Any other modal state already held by `ChatView` (e.g. `chatMenuOpen`) if it turns out to
    cover the right edge band during manual testing.
- Treat the hook's target exclusions as a second line of defence, not a replacement for state
  gating where state is available.
- Leave the right edge-grip button in place as the tap fallback.
- Leave the following untouched:
  - `swipe(messageId, direction)`
  - `swipeMessage`
  - `SwipeResult`
  - Swipe state.
  - Timeline handling.
  - Visible per-message alternative controls (`ChatMessageRow.tsx`'s `‹` / `›` buttons, which
    call `onSwipe` directly and have no touch handler of their own today).

Those elements serve explicit controls and regeneration, not the removed touch gesture.

This applies identically to `chat` and `rp` because both are rendered through `ChatView`. The
requested RP Chat behaviour is therefore fixed without creating a divergent RP-only gesture
system.

### 5. Update `frontend/src/App.css`

No geometry change is required. The grips already provide the desired visible and tappable
fallback.

Change only the documentation comments around `.edge-grip` (lines ~108–113): they currently state
"grabbing it is the ONLY way to open the rail (no edge swipe...)" — this is now false and must be
rewritten.

- Describe the 6 px strips and 14 px hit areas as fallback tap affordances.
- Remove statements that grabbing the grip is the only way to open a panel.
- Remove statements that edge swipes are intentionally prohibited.
- Keep the breakpoint, positioning, z-index, dimensions, and hit areas unchanged unless manual
  testing exposes an actual conflict.

### 6. Update `frontend/src/components/sidebar/Sidebar.css`

No functional CSS change is expected.

Update the mobile drawer comment (line ~26, "the summon control is now a grab on the edge grip
... instead of taking up its own strip of screen") so it describes the collapsed drawer as being
opened by an inward edge swipe or the edge-grip fallback, rather than by the grip alone.

Keep widths, overlay positioning, and z-index unchanged.

## Files reviewed but not expected to change

### `frontend/src/components/sidebar/Sidebar.tsx`

It already exposes `collapsed` and `onToggleCollapsed`. `App.tsx` owns the state needed for the
gesture.

Its contextual content switch (`case 'chat'`, `'rp'`, `'characters'`, `'notes'`, `'portraits'`)
confirms which tab types should enable the gesture — verified to match `SIDEBAR_CONTENT_TABS`
exactly.

### `frontend/src/components/chat/ChatMessageRow.tsx`

Explicit alternative navigation buttons (`onSwipe(m.messageId!, 'prev' | 'next')`) still call
`onSwipe`. No row-level touch handler currently needs removal — confirmed none exists.

### `frontend/src/components/appNav/AppNavDrawer.tsx`

### `frontend/src/components/appNav/AppNavDrawer.css`

Existing modal behaviour stays intact. The new gesture must respect `navOpen` and modal
exclusions rather than modifying this drawer.

### `frontend/src/views/ChatView.css`

The settings rail is already a fixed mobile overlay with collapsed/open states. No styling
change is needed to make edge opening work.

### `frontend/package.json`

The frontend has TypeScript and build verification (`check`: `tsc --noEmit`, `build`: `vite
build`, package name `@bigbrain/frontend` — confirmed) but no UI test runner. Do not introduce a
test framework solely for this gesture change.

## Tests and verification

### Automated checks

Run the existing lightweight frontend checks:

1. `pnpm --filter @bigbrain/frontend check`
2. `pnpm --filter @bigbrain/frontend build`

Search for dead references:

- No imports or calls to `useBottomThirdSwipe`.
- No stale comments claiming bottom-third message swipes.
- No stale comments claiming grip-only drawer opening.
- `useEdgeSwipe` is imported only by the intended panel state owners.

Do not add a UI testing dependency for this change. The meaningful verification is touch
behaviour on a narrow viewport or device.

### Manual mobile verification

Use a phone or browser device emulation at 768 px or narrower.

#### Left panel

- On Chat, RP Chat, Cards/Characters, Notes, and Portraits, swipe inward from the left edge and
  confirm the contextual sidebar opens.
- Confirm the existing left grip still opens it by tap.
- On tabs without sidebar content — Settings, Connections, Chub, Locations, and so on — confirm
  a left-edge swipe does nothing and the left grip is absent.
- With the sidebar already open, confirm another edge gesture does not close or toggle it.

#### Right panel

- In ordinary Chat and RP Chat, swipe inward from the right edge and confirm settings opens.
- Confirm the existing right grip still opens settings by tap.
- Confirm an inactive mounted Chat/RP Chat tab does not react when another tab is visible.
- With settings already open, confirm the gesture does not close or toggle it.
- Open the standalone sync status panel and confirm a right-edge swipe underneath it does not
  also open settings — this is the specific case `.chat-sync-status-overlay` was missing from
  the skip selector historically (see "What the current code does" above).

#### Message alternatives

- In RP Chat with multiple alternatives on the last assistant message, swipe horizontally
  through the bottom third and confirm:
  - The displayed alternative does not change.
  - No regeneration begins.
- Confirm the explicit `‹` / `›` controls still move between alternatives.
- Confirm explicit "next" at the newest alternative still performs the existing regeneration
  behaviour where allowed.

#### Gesture coexistence

- Vertically scroll chat history starting near either edge. It must scroll rather than open a
  panel when vertical movement dominates.
- Verify the chat's pull-down/top-bar reveal still works.
- Drag or scroll the tab strip.
- Type and select text in composer and settings fields.
- Manipulate attachments.
- Use selection-mode checkboxes.
- Confirm none of those interactions trigger a panel.
- Open App Navigation, Branch Map, Canvas, restart confirmation, and standalone sync status.
- Confirm edge swipes on those surfaces do not open a drawer underneath.
- Check both top-bars-visible and top-bars-collapsed states.
- At desktop width above 768 px, confirm touch/mouse behaviour and permanent rail controls are
  unchanged.

### Browser caveat

Mobile browsers may reserve the outermost edge for native back/forward navigation. The hook can
suppress that only after JavaScript receives and claims the drag.

Verify on the actual target browser. If the 20 px start band is unreliable, tune the edge band
deliberately rather than broadening the gesture to the whole screen and creating conflicts with
scrolling or content interaction.

## Acceptance criteria

- Mobile inward edge swipes open every side panel that exists for the current view.
- Existing tiny edge grips remain functional fallbacks.
- RP Chat horizontal touch gestures no longer browse or regenerate message alternatives.
- Explicit alternative buttons and their underlying server behaviour still work.
- Empty-sidebar tabs do not acquire stray gesture behaviour.
- Inactive mounted tabs do not respond to gestures.
- Desktop layouts remain unchanged.
- Scrolling, forms, and modal surfaces (including `.chat-sync-status-overlay`, historically
  missed) do not acquire stray gesture behaviour.
- TypeScript check and production build pass.

## Scope boundary

This is a frontend-only interaction change.

It does not alter:

- Message swipe storage.
- API routes.
- Database migrations.
- Regeneration semantics.
- Drawer contents.
- Panel dimensions.
- Desktop navigation.

## Review note (Claude Code, 2026-08-20)

Implementation matches this plan. Verified: `useEdgeSwipe.ts`'s skip selector includes
`.chat-sync-status-overlay` plus `.app-nav-layer` and `[role="dialog"]`/`[aria-modal="true"]` as
extra defence; `useBottomThirdSwipe.ts` deleted with no dead references; `App.tsx`'s
`hasSidebarContent` shared between the grip and the gesture with an explicit
`setSidebarCollapsed(false)`; `ChatView.tsx`'s right-edge gesture gated on `active` and
`canOpen: settingsCollapsed && !branchMapOpen && !mobileShowCanvas && !restartOpen &&
!syncStatusOpen && !chatMenuOpen` (the `chatMenuOpen` check goes beyond the plan's stated minimum,
which is a reasonable extra precaution); message-alternative API surface (`swipe`, `swipeMessage`,
`SwipeResult`, `ChatMessageRow`'s `‹`/`›` buttons) untouched. `tsc --noEmit` and `vite build` both
pass. Not verified in this environment: actual touch behaviour on a real narrow viewport — no
browser/device tooling available here, so the manual verification checklist above still needs a
real pass before calling this fully proven out.
