import { useEffect, useRef } from 'react';

// IO Wrapper: wires mobile edge touch events to an open callback. It owns no UI state.
// Public API: useEdgeSwipe opens one side's drawer after a deliberate inward edge drag.
// Contracts: mobile-only, open-only, callback/guard refs, and no preventDefault until claimed.
// Last intentional change: 2026-08-20 (restored mobile drawer edge swipes).

const EDGE_ZONE_PX = 20;
const SWIPE_TRAVEL_PX = 28;
const MOBILE_QUERY = '(max-width: 768px)';
const SKIP_SELECTOR = [
  '.chat-input', '.chat-select-box', '.chat-bottom-overlay', '.staging-bar', '.image-staging-bar', '.app-top-bars', '.edge-grip',
  '.chat-settings-rail', '.branch-map-panel', '.canvas-panel', '.chat-restart-dialog',
  '.chat-sync-status-overlay', '.app-nav-layer', '[role="dialog"]', '[aria-modal="true"]',
  'input', 'textarea', 'select', 'button',
].join(', ');

interface EdgeSwipeOptions {
  enabled?: boolean;
  canOpen?: () => boolean;
}

export function useEdgeSwipe(side: 'left' | 'right', onOpen: () => void, opts?: EdgeSwipeOptions) {
  const enabled = opts?.enabled ?? true;
  const onOpenRef = useRef(onOpen);
  const canOpenRef = useRef(opts?.canOpen ?? (() => true));

  useEffect(() => {
    onOpenRef.current = onOpen;
    canOpenRef.current = opts?.canOpen ?? (() => true);
  }, [onOpen, opts?.canOpen]);

  useEffect(() => {
    if (!enabled) return;
    const mediaQuery = window.matchMedia(MOBILE_QUERY);
    let start: { x: number; y: number } | null = null;
    let claimed = false;

    const onTouchStart = (event: TouchEvent) => {
      claimed = false;
      start = null;
      if (!mediaQuery.matches) return;
      const touch = event.touches[0];
      if (!touch) return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(SKIP_SELECTOR)) return;
      const atEdge = side === 'left' ? touch.clientX <= EDGE_ZONE_PX : touch.clientX >= window.innerWidth - EDGE_ZONE_PX;
      if (atEdge) start = { x: touch.clientX, y: touch.clientY };
    };

    const onTouchMove = (event: TouchEvent) => {
      if (!start || claimed) return;
      const touch = event.touches[0];
      if (!touch) return;
      const dx = touch.clientX - start.x;
      const dy = touch.clientY - start.y;
      if (Math.abs(dy) > Math.abs(dx) * 1.5) {
        start = null;
        return;
      }
      const inward = side === 'left' ? dx > 0 : dx < 0;
      if (!inward || Math.abs(dx) < SWIPE_TRAVEL_PX) return;
      if (!canOpenRef.current()) {
        start = null;
        return;
      }
      claimed = true;
      if (event.cancelable) event.preventDefault();
      onOpenRef.current();
    };

    const reset = () => {
      start = null;
      claimed = false;
    };

    window.addEventListener('touchstart', onTouchStart, { passive: true });
    window.addEventListener('touchmove', onTouchMove, { passive: false });
    window.addEventListener('touchend', reset);
    window.addEventListener('touchcancel', reset);
    return () => {
      window.removeEventListener('touchstart', onTouchStart);
      window.removeEventListener('touchmove', onTouchMove);
      window.removeEventListener('touchend', reset);
      window.removeEventListener('touchcancel', reset);
    };
  }, [enabled, side]);
}
