/**
 * @file frontend/src/components/chat/backgroundParallax.ts
 * @architectural-role UI code — imperative chat-background parallax pan (parallax_fade_teststep.md §2)
 * @description
 * A faithful port of SillyTavern-Vistalyze's ui/parallax.js
 * (st-extensions/SillyTavern-Vistalyze): the chat location background image pans horizontally
 * opposite the pointer, and on tilt-capable devices opposite device orientation, eased toward the
 * target with a requestAnimationFrame lerp — the image never snaps. Cap 200px in each direction
 * (ST's pan cap), listener goes on the chat container (the layer itself is pointer-events: none).
 * The caller toggles the oversized `.parallax-active` class on the img so the pan never reveals
 * the container edge; this module only owns the transform + the listeners + the rAF loop.
 *
 * Teardown contract: the returned dispose() cancels the rAF loop and removes both listeners —
 * the caller MUST call it on chat switch / unmount / disable, so no stale loop outlives its
 * ChatView (parallax_fade_teststep.md §2.1).
 */

export interface ParallaxHandle {
  dispose(): void;
}

const PAN_CAP = 200; // px, each direction — ST's parallax cap
const LERP = 0.06; // per-frame ease toward the target position

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Attaches the parallax pan to `img` (the `.chat-location-background` layer), driven by pointer
 *  movement over `container` (the chat view) plus device tilt. Returns a handle whose dispose()
 *  tears everything down. Idempotent-safe: dispose() twice is a no-op. */
export function attachBackgroundParallax(container: HTMLElement, img: HTMLElement): ParallaxHandle {
  let targetX = 0;
  let targetY = 0;
  let currentX = 0;
  let currentY = 0;
  let rafId = 0;
  let disposed = false;

  const onMouseMove = (e: MouseEvent): void => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // Normalized -1..1, centered on the container — left edge = -1, right edge = +1.
    targetX = ((e.clientX - rect.left) / rect.width) * 2 - 1;
    targetY = ((e.clientY - rect.top) / rect.height) * 2 - 1;
  };

  const onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.gamma == null || e.beta == null) return;
    // gamma = left/right tilt (-90..90), beta = front/back — normalized and clamped to ±1.
    targetX = clamp(e.gamma / 45, -1, 1);
    targetY = clamp(e.beta / 45, -1, 1);
  };

  const tick = (): void => {
    if (disposed) return;
    currentX += (targetX - currentX) * LERP;
    currentY += (targetY - currentY) * LERP;
    // Pan opposite the pointer (ST's parallax feel): cursor right → image drifts left.
    img.style.transform = `translate3d(${(-currentX * PAN_CAP).toFixed(2)}px, ${(-currentY * PAN_CAP).toFixed(2)}px, 0)`;
    rafId = requestAnimationFrame(tick);
  };

  container.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('deviceorientation', onOrientation);
  img.classList.add('parallax-active');
  rafId = requestAnimationFrame(tick);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      container.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('deviceorientation', onOrientation);
      img.classList.remove('parallax-active');
      img.style.transform = '';
    },
  };
}
