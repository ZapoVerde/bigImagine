# Technical Specification: Vistalyze Image Generation Subsystem (Stateless CDN Architecture)

**Status**: Built, verified 2026-08-11 — cited by section throughout `generateLocationImage.ts`,
`synthesizeImagePrompt.ts`, `imageConnections.ts`, `adminServer.ts`, `ImageConnectionEditor.tsx`,
and `generateLocationImageTool.ts`.  
**Scope**: Admin-Managed Image Connections, Stateless Prompt Synthesis, Cache-First Background Generation, Remote CDN Image URL Storage, and Provider Adapters.  
**Governing Principles**: Project Principles §1 (Relational Store is Canonical), §6 (Replaceable Reasoning & IO Layer), §8 (Four Kinds of Code), §12 (Secrets Write-Only/Encrypted), §13 (Runtime Config in DB), §18 (Surfaced Prompts in Settings).

---

## 1. Overview & System Intent

This specification defines the mechanical image-generation layer for **Vistalyze** within BigImagine. It transforms visual location descriptions and environmental parameters (time of day, weather, mood, lighting) into background imagery for the chat view and Inspector Canvas.

### Architectural Commitments & Stateless Media Philosophy
1. **Stateless Media Storage**: BigImagine stores **no image files on local disk**. Generated images are pure, reconstructible derived state. The database stores only the direct, remote CDN Image URL returned by the generation provider.
2. **Zero Disk Overhead**: The system eliminates local image storage modules, Docker media volumes, and background file-reaping scripts entirely.
3. **Cache-First & On-Demand Re-rendering**: If a location's visual description and environment parameters have not changed, rendering is skipped and the existing Image URL is reused (zero cost). If a remote CDN link expires or breaks, the system treats it as a cache miss and re-renders a fresh image on demand for fractional cents.
4. **Admin-Managed Image Connections**: Image generation backends (Runware, fal.ai, Pollinations, ComfyUI, etc.) are managed as encrypted, admin-configurable rows in the Connections Tab.
5. **Configurable Prompt Templates**: Prompt synthesis uses a master template stored in orchestrator settings, giving the user complete control over how descriptions, atmosphere, and style prefixes combine for AI image models.

---

## 2. Data Model & Schema

### 2.1 The Image Connections Table
Created via Migration 0068 (0066 and 0067 are already taken by `0066_cleanup_preset_seed.sql` and
`0067_transient_location_and_people.sql`), this table stores admin-managed image generation backends:

* **ID**: Primary key UUID.
* **Name**: Unique human-readable label (for example, "Runware - Flux Dev" or "fal.ai - SDXL").
* **Kind**: Closed vocabulary text string indicating the provider adapter (for example, runware, fal-ai, pollinations, comfyui, sd-webui, or openai-images).
* **Model**: Model identifier string passed to the vendor API (for example, runware:100@1 or fal-ai/flux/dev).
* **API Key Ciphertext**: Write-only API key, encrypted at rest using the server field cipher. Nullable only for a local ComfyUI endpoint — every cloud provider (Runware, fal.ai, Pollinations, OpenAI) requires one; Pollinations stopped being keyless in 2025 (anonymous requests are watermarked and rate-limited).
* **Base URL**: Endpoint URL (required for local endpoints like ComfyUI or custom proxies; optional for cloud APIs with fixed default endpoints).
* **Width / Height**: The connection's explicit output resolution in pixels (integer defaults
  1344×768 — a 16:9 landscape, matching VLZ's own background renders). Every provider adapter
  sends these pixels; no aspect-ratio string is ever sent to a vendor API.
* **Sampling Steps**: Integer specifying default inference steps.
* **CFG Scale**: Numeric value specifying default guidance scale.
* **Sampler Name**: Text string specifying sampler algorithm.
* **Master Positive Style Prefix**: Optional text prepended to every generation prompt sent through this connection.
* **Master Negative Prompt**: Optional text defining negative prompt constraints sent through this connection.
* **Workflow Parameters**: Optional JSONB object holding provider-specific workflow graphs or node parameters (used by ComfyUI).
* **Is Active**: Boolean flag marking the global default active image connection. Enforced via a partial unique index so at most one image connection is active at a time.
* **Created At & Updated At**: Timestamps tracking record lifecycle.

### 2.2 Orchestrator Settings
Settings entries added to the orchestrator settings store:
* **Master Image Prompt Template**: Text template defining how visual descriptions, environmental parameters, and style prefixes combine into the final positive prompt.
* **Active Image Connection Pointer**: References the active image connection ID.

### 2.3 Locations Table Integration
Reuses the existing locations schema from Migration 0045, with one column repurposed. `visual_description`,
`environment`, and `seed` are unchanged. `image_path` is **not** a URL column today — Migration 0045's own
comment scoped it for a local file path, on the explicit assumption that "Vistalyze's image pipeline isn't
built yet." Migration 0068 must rename it (`alter table locations rename column image_path to image_url`)
and drop that now-stale comment, rather than treating "Image URL" as something that already exists:
* **Visual Description**: Text column holding the physical description of the place.
* **Environment**: JSONB object holding time of day, weather, mood, and lighting parameters.
* **Seed**: Optional 64-bit integer seed for deterministic re-renders. **Fixed in practice**: every image-gen call (bg renders and the Connections test button) uses the shared `IMAGE_GEN_SEED = 12345` (`util/synthesizeImagePrompt.ts`) — same prompt ⇒ same image, so a re-render after row churn is pixel-identical to the cached one. `locations.seed` is a legacy/carry slot; the engine falls back to the fixed seed when it's null. Text LLM calls stay seed-less (provider-random) so reruns/swipes vary — only image gen is deterministic.
* **Image URL** (`image_path`, renamed by Migration 0068): Text column storing the direct, remote HTTPS CDN link returned by the provider (replaces local file paths).
* **Image Generated At**: Timestamp marking when the current image was successfully rendered.

---

## 3. Connections Tab & Provider Adapters

### 3.1 Connection Management
The frontend Connections Tab includes a dedicated **Image Generation Connections** management section:
* Admins can create, edit, test, delete, and set default image connections.
* API keys are write-only. Once saved, keys are never returned to the browser in plaintext or ciphertext.
* Deleting the currently active image connection is blocked until another connection is set as active.

### 3.2 Provider Adapter Registry (IO Wrapper Layer)
Each provider adapter accepts generation parameters and returns a single **Image URL text string**:

1. **Runware Adapter**:
   Connects to Runware via HTTP/WebSocket with prompt, negative prompt, model ID, dimensions, steps, CFG scale, and seed. Returns the direct Runware CDN image URL.
2. **fal.ai Adapter**:
   Submits generation jobs to fal.ai model endpoints (Flux, SDXL) and returns the direct fal.media CDN image URL.
3. **Pollinations Adapter**:
   Formats an instant URL request with prompt, width, height, model, seed, and negative-prompt parameters — and REQUIRES the connection's API key, which rides as the `token` query parameter (Pollinations' own extractFromRequest checks `?token=` first; the upstream ST SD-extension proxy sends the same key as an Authorization header). Returns the Pollinations image URL directly; the browser loads it with auth baked in, so the stateless-media commitment (§1.1) holds.
4. **ComfyUI Adapter**:
   Injects parameters into a local or remote ComfyUI workflow graph and returns the view URL from the ComfyUI server or local image host.
5. **OpenAI / DALL-E Adapter**:
   Submits image generation requests to OpenAI-compatible endpoints and returns the generated image URL.

### 3.3 Connection Diagnostics (Test Button)
Each saved image connection includes a "Test" button in the Connections Tab:
* Fires a single, low-cost diagnostic generation probe (for example, generating a test image of "a serene mountain landscape").
* Reports connection latency, the generated test Image URL, and success/failure details to the admin without saving the URL to any location record.

---

## 4. Prompt Synthesis Engine

A pure function module handles building the final positive and negative prompts sent to the image provider.

### 4.1 Input Variables
The synthesis engine accepts:
* Visual Description from the location record.
* Environment Object (time of day, weather, mood, lighting) from the location record.
* Master Positive Style Prefix from the active image connection.
* Master Negative Prompt from the active image connection.
* Master Image Prompt Template from orchestrator settings.

### 4.2 Template Macro Expansion
The Master Image Prompt Template is evaluated using macro interpolation. The template supports:
* The visual description of the space.
* The time of day.
* The weather conditions.
* The emotional mood or lighting atmosphere.
* The connection's master positive style prefix.

**The default template deliberately excludes the time of day** (and weather/mood/lighting — the scraper never fills them today, so they'd expand empty anyway): the physical description is the room alone, so the same room always produces the same prompt, the same render hash (endpoint.md §5.1 step 2), and — with the shared fixed seed — the same image. The macros remain available to a user who overrides the template and wants time-conditioned imagery.

The result is a clean, single-string positive prompt tailored for diffusion and Flux models.

---

## 5. Execution Pipeline, Caching & Link Expiry

Image generation is executed through an asynchronous background pass (`generateLocationImage.ts`, §6.2) triggered during the post-cleanup heuristic pass or manual location edits (via `generateLocationImageTool.ts`, §6.3). "Asynchronous" is load-bearing: the post-cleanup trigger must not be awaited inline in the request-handling path (`httpServer.ts`'s `regenerateSwipe`/`handleChatCompletions`, which already awaits `scrapeTurnPresence` synchronously) — a provider round-trip has no place blocking the reply the user is waiting on. It should be fired off after the response is sent, the same way `chatMemorySync.ts`'s tick runs decoupled from any single request.

### 5.1 Execution Flow

1. **Location Trigger**: A location change or environment update is detected during the post-cleanup heuristic pass. On the first LLM turn of a new RP chat, the scene header (the pass's only input) is repaired synchronously first — one small LLM call via `ensureFirstTurnHeader.ts`, only when the raw reply lacks a conforming header — so the very first turn resolves a location and fires the pass instead of waiting for the async cleanup subloop to add the header after the reply was already scraped (the subloop then finds nothing to repair: zero second LLM cost). Fail-open: a failed repair stores/sends the raw reply unchanged. **Same-place carry (segway.md §4.2 step 3)**: when a rerun supersedes the turn that anchored a row, the scraper's next mint of the same room inherits the prior row's `seed`/`image_url`/`image_rendered_input`/`image_render_hash` — and, when the prior row was actually described, its `visual_description`/`definition` too (the carried hash covers the *described* prompt, so the description must ride along or the cache check below misses) — the pass then sees a hash hit below instead of re-rendering a pixel-identical background. **Room description (describer.md)**: the decoupled fire chains the describer LLM pass *before* the render — one call for a never-described row (visual_description empty or still the name seed) that writes the reply's `Visuals:` half into `visual_description` and its `Definition:` half into `locations.definition`. The render hash is over the prompt, which expands `visual_description`, so describing first yields one clean render with the real description; a description landing after a render would flip the hash and waste a gen. Already-described rows (enriched by a prior pass or authored via `create_location`) are skipped — re-visits and restart triggers cost nothing.
2. **Cache Validation Check** (re-keyed to the prompt render hash, migration 0076):
   * The engine synthesizes the actual prompt first (template + location description/environment + connection style prefix + negative prompt) and hashes it together with every other output-affecting provider input (model, dims, steps, cfg, sampler, workflow params, seed) into a single `image_render_hash`.
   * **Cache Hit**: If Image URL is present AND the row's stored hash equals the freshly computed one, rendering is skipped entirely. The existing Image URL is retained (zero cost). The hash — not the raw inputs — is the variant: the same prompt reuses the URL, a changed prompt (a varied bg description, a different connection, or a user template that includes time-of-day) renders. The seed in the hash is the shared fixed seed (see §1's Seed bullet), so it never varies the hash by itself.
   * **Cache Miss**: If parameters changed, Image URL is missing/null, or the row predates 0076 (hash null — one-time legacy snapshot comparison), proceed to generation.
3. **Resolve Image Connection**: The engine fetches the active image connection (or chat/scene override) and decrypts its API key.
4. **Prompt Synthesis**: Expands the Master Image Prompt Template using the location's description and environment parameters.
5. **Execute Provider Adapter**: Calls the provider adapter (Runware, fal.ai, etc.) with the synthesized positive prompt, negative prompt, and model parameters. Immediately before the call, the §2.6 eligibility is re-checked: if the turn was regenerated while this pass was starting up (a swipe landed), the pending render is dropped without spending the provider call — a round-trip for a discarded timeline is a wasted gen. Discovery restarts when that swipe becomes active again (the chat-load / cycle-back triggers below).
6. **Receive Image URL**: The adapter returns the remote CDN Image URL string.
7. **Update Database**: The locations table is updated with the new Image URL, the current Image Generated At timestamp, the input snapshot, and the prompt render hash. The (chat, swipe, location) -> URL + hash association is recorded on `location_swipe_images` too (migration 0076): a rendered background is per-swipe — it stays valid for the swipe that used it even after the location row is re-anchored to a newer swipe, and prev/next cycling back to that swipe reuses the URL instead of re-generating.
8. **Notify UI**: The client receives the updated location Image URL and smoothly transitions the chat view background image. Because the pass runs decoupled from the turn, a location change lands with no image for a beat: `GET /v1/chats/:id/location-image` returns the eligible current location with `imageUrl: null` until the render lands, plus the last settled location (`previous` — the last-turn location state on `chat_sessions.previous_scene_id`, maintained by the scraper: only an *extending* turn advances it, a swipe regeneration never does, so it survives a chain of swipes). The Chat View shows the current image when it has one, otherwise the previous one — the background is persistent, never blanked on send ("some background is better than no background even if stale"); only a chat that never had a location shows nothing. A pending render keeps a bounded poll running until the replacement lands.
   * **Revert-on-swipe**: regenerating the last turn (Rerun / 'next' past the newest variant) invalidates its background when that turn established the current location (a freshly generated image) — the view instantly reverts to the `previous` location and keeps it while the new turn settles, then swaps in the replacement; a failed swipe restores the swiped-from background. Plain prev/next cycling between stored variants never reverts.
   * **Restart on return**: a chat (re)open or a prev/next cycle re-fires the cache-first pass when the active location has no rendered image (a pass dropped by a swipe, or a failed render) — `ensureActiveLocationImage`. Cache-first plus an in-process in-flight guard make repeat triggers no-ops, and the active-swipe read (anchored location or `location_swipe_images` association) fixes the stale-scene-pointer blank on cycle-back.

### 5.2 Automatic Expiry Recovery (Broken Link Fallback)
Because remote CDN URLs may eventually expire after days or weeks:
1. **Client Image Error Catch**: If the browser's Chat View encounters an HTTP error (such as a 404 or expired link) while attempting to load the background Image URL, it notifies the server.
2. **Clear Stale Link**: The server sets Image URL to null for that location record.
3. **On-Demand Re-render**: On the next turn or location visit, the cache check sees Image URL is null, treats it as a cache miss, and re-renders a fresh image URL in 1–2 seconds.

---

## 6. Required File Changes & Module Responsibilities

### 6.1 Database Migrations
* **`db/migrations/0068_image_connections.sql`**: Creates the image connections table, partial unique index for active status, adds image settings keys to orchestrator settings, and renames `locations.image_path` to `image_url` (see §2.3).
* **`db/migrations/0076_location_swipe_images.sql`**: Adds `locations.image_render_hash` (the prompt-hash cache key, §5.1 step 2), `chat_sessions.previous_scene_id` (the last-turn location state, §5.1 step 8), and the `location_swipe_images` per-swipe association table (chat + swipe -> location + URL + render hash, RLS-scoped through the swipe's message).
* **`db/migrations/0078_location_describer.sql`**: Adds `locations.definition` (the describer's logical-definition output, describer.md §4) and the two room-describer settings keys (`location_describer_prompt`, `location_describer_history_pairs`) to orchestrator_settings' CHECK (widened wholesale).

### 6.2 Orchestrator Core & IO
* **`orchestrator/src/io/imageConnections.ts`**: CRUD store for image connections, with write-only key encryption and active connection resolution.
* **`orchestrator/src/io/imageGen/index.ts`**: Provider adapter factory and dispatch layer.
* **`orchestrator/src/io/imageGen/runware.ts`**: Runware API adapter returning CDN Image URLs.
* **`orchestrator/src/io/imageGen/falAi.ts`**: fal.ai API adapter returning CDN Image URLs.
* **`orchestrator/src/io/imageGen/pollinations.ts`**: Pollinations API adapter returning image URLs — requires the connection key (carried as the `token` URL param; not keyless since 2025).
* **`orchestrator/src/io/imageGen/comfyUi.ts`**: ComfyUI API adapter returning local/server image URLs.
* **`orchestrator/src/orchestrator/generateLocationImage.ts`**: Plain async function — prompt-hash cache validation, prompt synthesis, adapter dispatch, Image URL + render hash update, the per-swipe association record, the pre-provider eligibility re-check (drop rule), and the in-flight guard. This is the real implementation and the only thing the post-cleanup pass calls; see §5.1.
* **`orchestrator/src/util/synthesizeImagePrompt.ts`**: Pure function macro expansion engine for image prompts.
* **`orchestrator/src/orchestrator/ensureFirstTurnHeader.ts`** *(new)*: synchronous scene-header repair for the first LLM turn of a new RP chat — reuses the cleanup subloop's own machinery (planCleanup/buildRepairPrompt/applyRepairSteps + the editable `cleanup_header_regex/prompt` settings), one LLM call, fail-open to the raw reply (§5.1 step 1).
* **`orchestrator/src/orchestrator/locationAndPresenceScraper.ts`**: `scrapeTurnPresence` gained an extend/replace mode — an extending turn's location change advances `chat_sessions.previous_scene_id` (the last-turn location state, §5.1 step 8); a swipe regeneration ('replace') never does. The §4.2.5 same-place carry also clones a described prior row's `visual_description`/`definition` (hash-match keeps the §5.1.2 cache hit, describer.md §2).
* **`orchestrator/src/orchestrator/describeLocation.ts`** *(new)*: the room-description LLM pass (describer.md) — one call for a never-described row, Definition/Visuals markers parsed and written to `definition`/`visual_description`, fail-open, in-flight guard, settings-surfaced prompt.
* **`orchestrator/src/io/chatSessions.ts`**: `forkChat()`'s location-resurrection clone carries `seed`, `image_url`, `image_generated_at`, `image_rendered_input`, `image_render_hash`, and now `definition` forward onto the cloned row (no fresh render on fork), and now resurrects every copied active swipe's locations (not just the fork point's) plus re-keys the `location_swipe_images` associations onto the branch's own chat/swipe/location ids — so all pre-fork bgs transfer and cycle-back reuses recorded URLs (segway.md §2.7).

### 6.3 Plugins & Server Routes
* **`plugins/locations/src/generateLocationImageTool.ts`**: Thin `RegisteredTool` wrapper around `generateLocationImage.ts` (§6.2), for manual/model-triggered regeneration only (e.g. "manual location edits" per §5.1). The automatic post-cleanup-pass trigger calls `generateLocationImage.ts` directly — it must not route through LLM tool-dispatch, both because that machinery doesn't apply to a deterministic background pass and because it would reintroduce a token cost the whole point of Stage 2 is to avoid (segway.md §4). This mirrors the existing split between `locationAndPresenceScraper.ts` (orchestrator-owned logic) and its plugin tool wrappers.
* **`orchestrator/src/server/adminServer.ts`**: Admin routes for image connection CRUD, testing, activation, and image settings management.

### 6.4 Frontend Surfaces
* **`frontend/src/views/ConnectionsView.tsx`**: Expanded UI for managing image generation connections alongside LLM connections.
* **`frontend/src/views/SettingsView.tsx`**: Configuration UI for editing the Master Image Prompt Template.
* **`frontend/src/views/ChatView.tsx`**: Renders `scenes.active_location_id`'s remote Image URL as the background layer of the chat view — the current image when it has one, else the last settled one (never blank, §5.1 step 8), with the bounded poll for pending renders and the revert-on-swipe behavior.
* **`frontend/src/api/client.ts`**: `getChatLocationImage` returns `{ current, previous }` — the current eligible location (imageUrl null while its render is pending) and the last settled location (only when it has an image to show).
* **`frontend/src/components/canvas/CanvasPanel.tsx`**: Displays active location image preview, environment controls, and manual re-render trigger.