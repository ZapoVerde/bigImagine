import { useEffect, useRef } from 'react';

// Edge-swipe drawer summon for mobile — IO Wrapper: wires window touch events to a caller
// callback, nothing else.
//
// A horizontal drag starting within ~20px of the chosen screen edge, moving away from that
// edge, fires the caller's callback once (open-only: closing stays with the drawer's own
// chrome — its header toggle — so the gesture is never ambiguous about direction). This is
// the "don't have to aim at the 6px grip" fallback for the .edge-grip strips (App.css):
// the grip is the visible affordance, the swipe is the forgiving one.
//
// Contracts:
// - Reads touch events only; calls preventDefault ONLY on a claimed horizontal drag, to stop
//   the browser's own native edge gesture (Chrome's back/forward swipe) from firing on top.
//   Vertical scrolls, the chat pull-down gesture, and bubble swipe-to-variant drags are never
//   claimed and keep working.
// - CanOpen guard: the gesture is claimed only when canOpen() is true (drawer currently
//   closed), so an already-open rail never swallows the browser's native edge gesture.
// - Drags starting on interactive chrome are left alone: chat bubbles (their variant-swipe
//   owns horizontal drags), the chat input row (text selection), form fields, and the top
//   bars (horizontal tab scrolling / their own controls).
// - Mobile-gated per event via matchMedia, so a desktop touchscreen never triggers it.
// - enabled=false attaches no listeners at all (hidden tabs); otherwise the listeners are
//   subscribed once per `side` and the callbacks are refreshed via refs every render, so
//   callers can pass inline closures without re-subscribing.
//
// Last intentional change: 2026-08-16 (initial — replaced the old .side-fab summoning arrows).

const EDGE_ZONE_PX = 20; // the swipe must start within this distance of the screen edge
const SWIPE_TRAVEL_PX = 28; // horizontal travel before the gesture counts as a summon
const MOBILE_QUERY = '(max-width: 768px)'; // same breakpoint as the .mobile-only CSS
// Drags starting on these are never claimed — the listed surfaces own their horizontal drags
// (bubble variant-swipes, text selection, tab-bar scrolling) or are form controls.
const SKIP_SELECTOR = '.chat-bubble, .chat-input, .chat-select-box, input, textarea, .app-top-bars';

interface EdgeSwipeOptions {
  /** When false the listeners aren't attached at all (e.g. this tab is hidden). Default true. */
  enabled?: boolean;
  /** Guard checked right before a gesture is claimed; return false to abandon the drag and
   *  let the browser handle it (native back-edge gesture keeps working once the drawer is
   *  already open). Defaults to always-open. */
  canOpen?: () => boolean;
}

export function useEdgeSwipe(side: 'left' | 'right', onSwipe: () => void, opts?: EdgeSwipeOptions) {
  const enabled = opts?.enabled ?? true;
  const onSwipeRef = useRef(onSwipe);
  const canOpenRef = useRef(opts?.canOpen ?? (() => true));
  useEffect(() => {
    onSwipeRef.current = onSwipe;
    canOpenRef.current = opts?.canOpen ?? (() => true);
  }, [onSwipe, opts?.canOpen]);

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
      const inZone =
        side === 'left'
          ? t.clientX <= EDGE_ZONE_PX
          : t.clientX >= window.innerWidth - EDGE_ZONE_PX;
      start = inZone ? { x: t.clientX, y: t.clientY } : null;
    };

    const onTouchMove = (e: TouchEvent) => {
      if (!start || claimed) return;
      const t = e.touches[0];
      if (!t) return;
      const dx = t.clientX - start.x;
      const dy = t.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        // Dominant vertical — a scroll or the chat's pull-down, not our gesture.
        start = null;
        return;
      }
      // Opening direction: the left drawer is pulled out toward the right (dx > 0), the right
      // rail toward the left (dx < 0). A drag in the wrong direction is left alone.
      const opens = side === 'left' ? dx > 0 : dx < 0;
      if (!opens || Math.abs(dx) < SWIPE_TRAVEL_PX) return;
      if (!canOpenRef.current()) {
        // Drawer already open — don't claim the drag, so the browser's native edge gesture
        // (back/forward swipe) still gets it.
        start = null;
        return;
      }
      claimed = true;
      if (e.cancelable) e.preventDefault(); // suppress the browser's own edge gesture
      onSwipeRef.current();
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
  }, [side, enabled]);
}
