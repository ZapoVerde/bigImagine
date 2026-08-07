# Technical Specification: Chat Background FX & Image Connection Test-Step

**Status**: Designed
**Scope**: Parallax Background Pan, Background Fade-In Transition, and a Test-Step that
guarantees every image connection genuinely generates a test image on Test.
**Personal build**: This system is built for a single user. Only the three features below are in
scope. Deliberately out of scope (and not required for this build): location badges on messages,
the Workshop Library/Architect/Explorer, the picker/import modals, approval gates, and manual
environment editing — the automatic scraper pipeline (segway.md) plus these three surfaces cover
what a single user actually needs.
**Governing Principles**: Project Principles §1 (Relational Store is Canonical), §8 (Four Kinds
of Code), §11 (Log at Reasoning/IO Seams), §13 (Runtime Config in DB), §18 (Surfaced Prompts in
Settings).

---

## 1. Overview & System Intent

This spec extends `endpoint.md`'s image subsystem with the three pieces that make the chat
background feel finished:

1. **Parallax** — the location image pans gently opposite the mouse / device tilt, the same
   horizontal parallax the SillyTavern Vistalyze extension ships (`ui/parallax.js`), ported onto
   BigImagine's ChatView background layer.
2. **Fade-in** — the background "smoothly transitions" when the location image changes. This is a
   promise endpoint.md §5.1.8 already made but the current implementation breaks (the background
   `<img>` is keyed by URL in `ChatView.tsx`, so a location change is an instant cut, not a fade).
3. **Test-Step** — every image connection's Test button must *actually generate a test image*
   through that connection (endpoint.md §3.3), show the generated image, and show the exact
   synthesized prompt that produced it. The current `testImageConnection`
   (`orchestrator/src/server/adminServer.ts`) does fire the real adapter, but the probe prompt is
   a hardcoded bare string that skips the connection's master positive style prefix, and the
   frontend renders the result as a text line only — no image, no prompt.

All three are cheap and self-contained. They are deliberately the *only* polish surfaces in this
build; the rest of the ST extension's surface (badges, workshop, pickers) was judged unnecessary
for a single-user deployment.

---

## 2. Parallax Background Pan

### 2.1 Behavior

The ChatView background image (`ChatView.tsx`'s `.chat-location-background` element) pans
horizontally opposite the pointer, and on mobile, opposite device tilt — ported from
`SillyTavern-Vistalyze/ui/parallax.js` (see `st-extensions/SillyTavern-Vistalyze/`).

* Pan range: **capped at 200px** in each direction (the ST cap, `ui/parallax.js:53-59`).
* Motion: requestAnimationFrame lerp toward the target position — the image eases, it never
  snaps (`ui/parallax.js:63-75`).
* Inputs:
  * Mouse: `mousemove` on the chat view container, normalized to -1..1 (left edge = -1),
    `ui/parallax.js:175-177`.
  * Tilt: `deviceorientation` beta/gamma when the device reports orientation, `ui/parallax.js:79-86`.
* The image must be oversized to cover the pan (width: `calc(100% + 400px)`, or `left: -200px`
  with width 100% + 400px margin) so panning never reveals the container edge.
* The background already has `pointer-events: none` (`ChatView.css:39`) — the listener goes on
  the chat container, not the image.
* **Teardown**: on chat switch / unmount, cancel the rAF loop and remove both listeners
  (`ui/parallax.js:204-222`). A stale loop must not outlive its ChatView.

### 2.2 Settings

Per bi_principles §13 (runtime config in DB), the toggle is a settings-store key, not a
frontend constant:

* **`chat_background_parallax`**: boolean, **default `false`** (matches ST's
  `parallaxEnabled=false`, `settings/data.js:49`).
* New user-scoped `GET /v1/chat-background-settings` → `{ parallaxEnabled }` (ChatView reads it
  at mount and after each settings save), plus admin-gated `POST /v1/admin/chat-background-settings`
  — same shape as the existing `household_timezone` pair (`GET /v1/timezone` /
  `POST /v1/admin/timezone` precedent).
* Surfaced in SettingsView as a "Chat Background" fieldset toggle (bi_principles §13).

### 2.3 File Shape

* **`frontend/src/components/chat/backgroundParallax.ts`** *(new, UI code)*: a small imperative
  module owning the rAF loop, lerp state, and listener lifecycle — `attachBackgroundParallax(container, img)`
  returning a `dispose()` handle. One purpose, well under the 300-line budget (bi_principles §10).
* **`ChatView.tsx`**: call `attachBackgroundParallax` when `locationImage` is set and the setting
  is on; dispose on chat change / image change / unmount.
* No orchestrator involvement beyond the settings key — this is pure frontend, per bi_principles §8.

---

## 3. Background Fade-In Transition

### 3.1 Behavior

When the location image changes (`locationImage.imageUrl` changes, which today remounts the
keyed `<img>`), the background fades instead of cutting — the same rhythm ST ships
(`style.css:12-20`):

1. Add a **fade-out** class to the current image (0.3s ease-in-out).
2. After the fade-out (300ms), swap `src` to the new URL and swap to a **fade-in** class
   (0.6s ease-in-out).

ST's fade is a single layer with class toggling and a 300ms teardown delay (`background.js:88-105,
139-146`) — not a true two-image crossfade. Port it exactly that way: one `<img>`, class-toggled.
The transition only runs on URL *change*; the initial mount of a chat with an existing image
should not play a fade-out of nothing (fade-in on first paint is fine).

### 3.2 CSS

* `.chat-location-background.vistalyze-fade-out` → `opacity: 0; transition: opacity 0.3s ease-in-out`
* `.chat-location-background.vistalyze-fade-in` → `opacity: 0.15; transition: opacity 0.6s ease-in-out`
  (0.15 is the existing resting opacity, `ChatView.css:38`)
* The fade and parallax compose: parallax transforms the element, fade animates its opacity —
  no conflict.

### 3.3 File Shape

* **`ChatView.tsx`**: hold the fade state (old URL + phase) alongside `locationImage`; a small
  `useEffect` on `imageUrl` runs the 0.3s fade-out, then swaps and fades in.
* **`ChatView.css`**: the two classes above.

---

## 4. Test-Step: Image Connections Must Generate on Test

### 4.1 The Guarantee

**Every image connection's Test button MUST produce a real generated test image through that
connection's own adapter — no dry runs, no "config looks OK" checks.** This is endpoint.md §3.3
made load-bearing:

* `runware`, `fal-ai`, `comfyui`, `openai-images`: a genuine provider call
  (`createImageGenProvider(profile).generate(...)`) with the connection's model, explicit
  width/height pixels, steps, CFG, sampler, key, and base URL. A bad key or unreachable endpoint
  surfaces as `{ ok: false, error }` with measured latency — never a throw, never a silent success.
* `pollinations`: the adapter's `generate()` is URL construction (the URL *is* the render
  request, `io/imageGen/pollinations.ts`). It is NOT keyless — the connection's token rides as
  the `token` query param (Pollinations requires a key since 2025), and the adapter throws a
  clear error without one. This still counts: Test returns a working image URL. The result is
  instant; latency ≈ 0.

The existing `testImageConnection` (`orchestrator/src/server/adminServer.ts:476-503`) already
meets 4.1's call-side. What follows closes its two gaps.

### 4.2 Synthesized Probe (close gap #1: the style prefix is skipped)

Today the probe is the hardcoded string `'a serene mountain landscape'` with no connection
influence. A Test that ignores the connection's master positive style prefix cannot tell you what
the connection will actually render. The probe must go through the real synthesis engine
(`synthesizeImagePrompt.ts`), exactly like `generateLocationImage.ts` does:

* **Visual description** (fixed sample): `a serene mountain landscape at golden hour, soft mist
  over the valley` — the same sample ST's test-step populates (`settings/stepTestModal.js`).
* **Environment** (fixed sample): `{ time_of_day: 'golden hour', weather: 'clear', mood:
  'serene', lighting: 'soft golden light' }`.
* **Template**: the `image_prompt_template` orchestrator setting (same read
  `generateLocationImage.ts` uses).
* **Style prefix / negative**: the connection's `masterPositiveStylePrefix` /
  `masterNegativePrompt`.
* **Output**: the positive prompt is synthesized from these, sent to the adapter, and returned
  in the result so the admin sees *what was sent*.

`ImageConnectionTestResult` gains `prompt: string` (the exact positive prompt sent to the
provider).

### 4.3 The Test-Step Modal (close gap #2: the image is never shown)

The frontend currently renders the result as one text line (`Rendered a probe image in Xms —
<url>`, `ImageConnectionEditor.tsx:432-452`). A Test that generates an image the admin cannot
see is half a feature. Replace the text line with a **test-step result panel**:

* The generated test image, rendered via `<img src={testResult.imageUrl}>`.
* The synthesized prompt in a `<code>`/`<pre>` block (bi_principles §18 — prompts are surfaced,
  never hidden), plus latency and the direct CDN link.
* Keep the failure path: `Probe failed after Xms: <error>`.
* The image may be a CDN URL that renders immediately; no cache-busting needed for a one-shot
  test (unlike the background's overwrite case).

### 4.4 File Shape

* **`orchestrator/src/server/adminServer.ts`**: rewrite `testImageConnection`'s prompt assembly
  to synthesize via `synthesizeImagePrompt` with the fixed samples above + the connection's
  prefix/negative + the `image_prompt_template` setting; include the sent prompt in the result.
  The function signature gains the settings store (or the template value).
* **`frontend/src/api/types.ts`**: `ImageConnectionTestResult.prompt?: string`.
* **`frontend/src/components/connections/ImageConnectionEditor.tsx`**: test-step result panel
  (image + prompt + latency + link).

---

## 5. Required File Changes

### 5.1 Database
* **`db/migrations/0069_chat_background_settings.sql`**: add `chat_background_parallax` to the
  `orchestrator_settings` key CHECK (widen the 0068 list) + grant to `bigimagine_app`.
  *(Confirm 0069 is free before writing — 0068 was the last migration.)*

### 5.2 Orchestrator Core & IO
* **`orchestrator/src/io/orchestratorSettings.ts`**: add `'chat_background_parallax'` to
  `SETTING_NAMES`.
* **`orchestrator/src/server/httpServer.ts`**: `GET /v1/chat-background-settings` (user-scoped,
  reads live like `household_timezone`) + `POST /v1/admin/chat-background-settings` (admin-gated,
  no restart — read live at ChatView mount).
* **`orchestrator/src/server/adminServer.ts`**: `getChatBackgroundSettings(store)` (default
  `false` when unset), `parseSetChatBackgroundSettingsBody(raw)`, `setChatBackgroundSettings`;
  plus the §4.2 `testImageConnection` rewrite (synthesized probe + `prompt` in result).

### 5.3 Frontend
* **`frontend/src/api/types.ts`**: `ChatBackgroundSettings { parallaxEnabled: boolean }`;
  extend `ImageConnectionTestResult` with `prompt?: string`.
* **`frontend/src/api/client.ts`**: `getChatBackgroundSettings(apiKey)`,
  `adminSetChatBackgroundSettings(adminKey, value)`.
* **`frontend/src/components/chat/backgroundParallax.ts`** *(new)*: §2.3's attach/dispose module.
* **`frontend/src/views/ChatView.tsx`**: parallax attach/dispose (§2.3); fade state machine (§3.3);
  read `parallaxEnabled` at mount and re-read after settings saves.
* **`frontend/src/views/ChatView.css`**: `.vistalyze-fade-out` / `.vistalyze-fade-in` (§3.2).
* **`frontend/src/views/SettingsView.tsx`**: "Chat Background" fieldset with the parallax toggle
  (§2.2).
* **`frontend/src/components/connections/ImageConnectionEditor.tsx`**: test-step result panel
  (§4.3).

### 5.4 Verification
* **`orchestrator/scripts/verify-server.mjs`**: route tests for `GET /v1/chat-background-settings`
  (default false, round-trip) and the admin POST (bad body → 400).
* **`orchestrator/scripts/verify-image-connections.mjs`**: assert `testImageConnection` now sends
  a *synthesized* probe — the returned `prompt` contains the style prefix when the connection
  sets one, and the result carries `imageUrl` (pollinations) or `ok:false` with a real error for
  a bad key.

---

## 6. Acceptance Criteria

1. With `chat_background_parallax` on, moving the mouse across the chat view pans the background
   smoothly (lerped, ≤200px each way); on a chat switch the listeners/rAF are gone (no console
   errors, no panning in the wrong chat).
2. Changing a location's image fades the background out (0.3s) and the new one in (0.6s) — no
   instant cut. First paint on chat load does not play a fade-out.
3. Every image connection kind's Test button returns a **real generated test image URL** (or a
   truthful failure with latency); the panel shows the image, the synthesized prompt, latency,
   and the link. The probe prompt visibly includes the connection's master positive style prefix.
4. Full `npm run verify` stays green.
