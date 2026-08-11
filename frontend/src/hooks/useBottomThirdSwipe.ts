import { useEffect, useRef } from 'react';

// Mobile bottom-third navigation swipes — IO Wrapper: wires window touch events to a caller
// callback, nothing else.
//
// A horizontal drag STARTING in the bottom third of the screen (y >= 2/3 viewport height)
// fires the caller's callback once with a direction, mirroring SillyTavern's gesture swipes
// (st-source/public/scripts/RossAscends-mods.js: sweeps on the chat surface browse the last
// entry's alternatives; finger-left -> 'next', finger-right -> 'prev'). This replaces the old
// useEdgeSwipe drawer-summon: drawers now open ONLY by grabbing their .edge-grip handle (tap),
// the middle of the screen is a dead zone nothing claims, and the bottom third is the one
// gesture surface for browsing a reply's variants.
//
// Contracts:
// - Reads touch events only; calls preventDefault ONLY on a claimed horizontal drag, to stop
//   the browser's own native edge gesture (Chrome's back/forward swipe) from firing on top.
//   NOTE: preventDefault can only win drags the browser hasn't already committed to — a drag
//   STARTING inside Chrome's native edge band (the outer ~20px) may be taken by the browser
//   regardless. That loss is accepted: the middle of the screen stays a dead zone and the
//   drawer summon is grip-grab only, so a claimed drag being stolen by the browser loses a
//   variant browse, never a drawer pull.
//   Vertical scrolls and the chat's pull-down are never claimed and keep working.
// - CanSwipe guard: the gesture is claimed only when canSwipe() is true (e.g. the last reply
//   actually has alternatives to browse), so an unswipeable chat never swallows the browser's
//   native edge gesture.
// - Only drags STARTING in the bottom third count — the upper two thirds (grip zone, dead
//   middle) are left entirely to their own surfaces.
// - Drags starting on interactive chrome are left alone: the chat input row (text selection),
//   form fields, the select-checkboxes, and the top bars.
// - Mobile-gated per event via matchMedia, so a desktop touchscreen never triggers it.
// - enabled=false attaches no listeners at all (hidden tabs); otherwise the listeners are
//   subscribed once and the callbacks are refreshed via refs every render, so callers can pass
//   inline closures without re-subscribing.
//
// Last intentional change: 2026-08-17 (initial — replaces the removed useEdgeSwipe.ts).

const ZONE_BOTTOM_FRACTION = 2 / 3; // drags must start in the bottom third of the screen
const SWIPE_TRAVEL_PX = 50; // horizontal travel before the gesture counts as a navigation
const MOBILE_QUERY = '(max-width: 768px)'; // same breakpoint as the .mobile-only CSS
// Drags starting on these are never claimed — text selection, form controls, the tab bars,
// the drawer grips (a grab on a grip must stay a grab, not a variant swipe), and the
// attachment staging rows in the bottom overlay (their chips are tap targets, not swipe
// surfaces).
const SKIP_SELECTOR = '.edge-grip, .chat-input, .chat-select-box, .staging-bar, .image-staging-bar, input, textarea, .app-top-bars';

interface BottomThirdSwipeOptions {
  /** When false the listeners aren't attached at all (e.g. this tab is hidden). Default true. */
  enabled?: boolean;
  /** Guard checked right before a gesture is claimed; return false to abandon the drag and
   *  let the browser handle it (native back-edge gesture keeps working when there's nothing
   *  to navigate to). Defaults to always-allow. */
  canSwipe?: () => boolean;
}

export function useBottomThirdSwipe(onSwipe: (direction: 'prev' | 'next') => void, opts?: BottomThirdSwipeOptions) {
  const enabled = opts?.enabled ?? true;
  const onSwipeRef = useRef(onSwipe);
  const canSwipeRef = useRef(opts?.canSwipe ?? (() => true));
  useEffect(() => {
    onSwipeRef.current = onSwipe;
    canSwipeRef.current = opts?.canSwipe ?? (() => true);
  }, [onSwipe, opts?.canSwipe]);

  useEffect(() => {
    if (!enabled) return;
    const mq = window.matchMedia(MOBILE_QUERY);
    let start: { x: number; y: number } | null = null;
    let claimed = false;

    const onTouchStart = (e: TouchEvent) => {
      claimed = false;
      if (!mq.matches) {
        start = null;
        return;
      }
      const t = e.touches[0];
      if (!t) return;
      const target = e.target instanceof Element ? e.target : null;
      if (target && target.closest(SKIP_SELECTOR)) {
        start = null;
        return;
      }
      start = t.clientY >= window.innerHeight * ZONE_BOTTOM_FRACTION ? { x: t.clientX, y: t.clientY } : null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start || claimed) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        // Dominant vertical — a scroll, not our gesture.
        start = null;
        return;
      }
      if (Math.abs(dx) < SWIPE_TRAVEL_PX) return;
      if (!canSwipeRef.current()) {
        // Nothing to navigate — don't claim the drag, so the browser's native edge gesture
        // (back/forward swipe) still gets it.
        start = null;
        return;
      }
      claimed = true;
      if (e.cancelable) e.preventDefault(); // suppress the browser's own edge gesture
      onSwipeRef.current(dx < 0 ? 'next' : 'prev'); // finger-left -> next, finger-right -> prev
    };

    const onTouchEnd = () => {
      start = null;
      claimed = false;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', onTouchEnd);
    window.addEventListener('touchcancel', onTouchEnd);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', onTouchEnd);
      window.removeEventListener('touchcancel', onTouchEnd);
    };
  }, [enabled]);
}
