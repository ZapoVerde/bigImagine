/**
 * @file frontend/src/components/chat/backgroundParallax.ts
 * @architectural-role UI code — imperative chat-background parallax pan (parallax_fade_teststep.md §2)
 * @description
 * A faithful port of SillyTavern-Vistalyze's ui/parallax.js
 * (st-extensions/SillyTavern-Vistalyze): the chat location background image is scaled to fit the
 * container's height (height: 100%, width: auto — never object-fit:cover-cropped), centered, and
 * the parallax pans it horizontally opposite the pointer, and on tilt-capable devices opposite
 * device orientation, eased toward the target with a requestAnimationFrame lerp — the image never
 * snaps. The pan range is bounded by the image's own horizontal overflow — how much wider it is
 * than the container, halved — capped at 200px each way (ST's pan cap, ui/parallax.js:29), so the
 * pan travels to the image edges and can never reveal the container edge. The listener goes on the
 * chat container (the layer itself is pointer-events: none); this module owns the geometry (the
 * inline left + transform) and the listeners + rAF loop, and toggles the `.parallax-active` class.
 *
 * The img src swaps during background fades (ChatView's fade state machine, §3), and the attach
 * effect keys on URL nullness rather than the URL value — so the module re-geometries itself on
 * every `load`, not just at attach.
 *
 * Teardown contract: the returned dispose() cancels the rAF loop, removes all listeners, and
 * clears the inline geometry — the caller MUST call it on chat switch / unmount / disable, so no
 * stale loop outlives its ChatView (parallax_fade_teststep.md §2.1).
 */

export interface ParallaxHandle {
  dispose(): void;
}

const PAN_CAP = 200; // px, each direction — ST's parallax cap (ui/parallax.js:29)
const ALPHA_MOUSE = 0.12; // per-frame lerp for pointer input (ui/parallax.js:30)
const ALPHA_TILT = 0.06; // more damping for the noisy accelerometer (ui/parallax.js:31)
const WRITE_THRESHOLD = 0.1; // px — skip the DOM write when the pan is effectively idle
const TILT_CLAMP_DEG = 30; // gamma clamp, ui/parallax.js:82

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Recomputes the centered base position + effective pan range from the image's natural
 *  dimensions and the container's current size — ui/parallax.js:53-59. The image is scaled to
 *  fit the container height (width follows the aspect ratio), centered, and the pan range is how
 *  much wider the image is than the container (halved), capped at PAN_CAP. A narrower-than-
 *  container image gets pan range 0 and simply sits centered. */
function computeGeometry(img: HTMLImageElement, container: HTMLElement): {
  baseLeft: number;
  effectivePan: number;
} {
  const containerWidth = container.clientWidth;
  const containerHeight = container.clientHeight;
  const displayedWidth = img.naturalWidth * (containerHeight / img.naturalHeight);
  const baseLeft = (containerWidth - displayedWidth) / 2;
  const panRange = Math.max(0, (displayedWidth - containerWidth) / 2);
  const effectivePan = Math.min(panRange, PAN_CAP);
  return { baseLeft, effectivePan };
}

/** Attaches the parallax pan to `img` (the `.chat-location-background` layer) over `container`
 *  (the chat pane). The layer's resting CSS is height-fit + centered (left: 50% /
 *  translateX(-50%)); while active this module owns the inline left (baseLeft px) and transform
 *  (the pan). Returns a handle whose dispose() tears everything down. Idempotent-safe:
 *  dispose() twice is a no-op. */
export function attachBackgroundParallax(container: HTMLElement, img: HTMLImageElement): ParallaxHandle {
  let targetX = 0;
  let currentX = 0;
  let effectivePan = 0;
  let alpha = ALPHA_MOUSE;
  let rafId = 0;
  let disposed = false;

  const onMouseMove = (e: MouseEvent): void => {
    const rect = container.getBoundingClientRect();
    if (rect.width === 0) return;
    // Normalized -1..1 centered on the container (left edge = -1, right edge = +1), mapped to
    // ±effectivePan; pan opposite the pointer (ui/parallax.js:175-177): cursor right → image
    // drifts left, so the pan never outruns the image's own edges.
    targetX = -((e.clientX - rect.left) / rect.width - 0.5) * 2 * effectivePan;
  };

  const onOrientation = (e: DeviceOrientationEvent): void => {
    if (e.gamma == null) return;
    // Horizontal tilt only (ui/parallax.js:79-86): gamma = left/right tilt, clamped to ±30° and
    // mapped to ±effectivePan, opposite the tilt. Once tilt input arrives, use its damping.
    alpha = ALPHA_TILT;
    targetX = -(clamp(e.gamma, -TILT_CLAMP_DEG, TILT_CLAMP_DEG) / TILT_CLAMP_DEG) * effectivePan;
  };

  const tick = (): void => {
    if (disposed) return;
    const next = currentX + (targetX - currentX) * alpha;
    // Skip the DOM write when effectively idle — avoids unnecessary compositor work
    // (ui/parallax.js:68-71).
    if (Math.abs(next - currentX) >= WRITE_THRESHOLD) {
      img.style.transform = `translateX(${next.toFixed(2)}px)`;
    }
    currentX = next;
    rafId = requestAnimationFrame(tick);
  };

  const recompute = (): void => {
    if (container.clientHeight <= 0 || img.naturalHeight <= 0) return;
    const { baseLeft, effectivePan: ep } = computeGeometry(img, container);
    img.style.left = `${baseLeft}px`;
    effectivePan = ep;
    currentX = clamp(currentX, -ep, ep);
    targetX = clamp(targetX, -ep, ep);
  };

  const onImgLoad = (): void => recompute(); // src swaps during fades — re-geometry each load
  const onResize = (): void => recompute();

  if (img.complete && img.naturalWidth > 0) recompute();
  img.addEventListener('load', onImgLoad);
  container.addEventListener('mousemove', onMouseMove, { passive: true });
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('resize', onResize);
  img.classList.add('parallax-active');
  rafId = requestAnimationFrame(tick);

  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      cancelAnimationFrame(rafId);
      img.removeEventListener('load', onImgLoad);
      container.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('deviceorientation', onOrientation);
      window.removeEventListener('resize', onResize);
      img.classList.remove('parallax-active');
      // Back to the resting CSS centering (left: 50% / translateX(-50%)).
      img.style.left = '';
      img.style.transform = '';
    },
  };
}
