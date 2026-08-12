/**
 * @file orchestrator/src/server/locationImages.ts
 * @stamp 2026-08-12
 * @architectural-role IO Wrapper — the chat-background location-image layer from httpServer.ts
 * @description
 * endpoint.md §5/§6.4's chat background layer: the decoupled describe-then-render trigger
 * (fired from the response 'finish' event, never awaited in the request path), the chat's
 * active/previous location-image read (scene_id pointer + active-swipe fallback, §2.6-filtered),
 * the "restart bg discovery on return" cache-first pass, and §5.2's broken-link expiry recovery.
 * Shared by the chat routes, the completions route, and index.ts's boot wiring.
 *
 * @api-declaration
 * fireLocationImageGeneration(deps, userId, chatId, locationId, llm?) — fire-and-forget trigger
 * resolveChatLocationImage(db, userId, chatId) — current + previous background read
 * ensureActiveLocationImage(deps, userId, chatId) — cache-first restart trigger
 * handleLocationImageBroken(req, res, deps, userId, url) — POST /v1/locations/:id/image-broken
 *
 * @contract
 *   assertions:
 *     purity:          impure (writes locations/location_swipe_images; fires LLM + image renders)
 *     state_ownership: []
 *     external_io:     [Postgres (via db), LLM (describeLocationIfNeeded), image provider
 *                       (generateLocationImage)]
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { generateLocationImage } from '../orchestrator/generateLocationImage.js';
import { describeLocationIfNeeded } from '../orchestrator/describeLocation.js';
import { log } from '../io/logger.js';
import type { LlmProvider } from '../io/llm/types.js';
import type { PostgresClient } from '../io/postgres.js';
import { sendJson } from './httpUtils.js';
import type { HttpServerDeps } from './httpServer.js';

// endpoint.md §5's decoupled image-generation trigger: fires describe-then-render without
// awaiting either, invoked from the response 'finish' event so the reply the user is waiting on is
// already sent before a provider round-trip starts. The describer (describeLocation.ts — the
// room-description LLM call, VLZ Step 3) must run BEFORE the render: the render hash (endpoint.md
// §5.1.2) is over the synthesized prompt, which expands visual_description, so a description that
// landed after the render would flip the hash and waste a gen — the chain awaits the describer
// first (both fail-open inside themselves, so a failed describe falls through to a name-seed
// render, exactly today's behavior). The injected llm is the turn's gated provider where the
// caller has one (post-turn fire sites pass turnLlm — the same connection the story itself ran
// on, mirroring VLZ's describer defaulting to the main chat LLM); restart triggers
// (ensureActiveLocationImage, the swipe-route fire) pass none and fall back to deps.llm.
export function fireLocationImageGeneration(
  deps: HttpServerDeps,
  userId: string,
  chatId: string | undefined,
  locationId: string,
  llm: LlmProvider = deps.llm,
): void {
  void (async () => {
    await describeLocationIfNeeded(
      { db: deps.db, settings: deps.settings },
      llm,
      userId,
      chatId,
      locationId,
    );
    await generateLocationImage(
      { db: deps.db, settings: deps.settings, imageConnections: deps.imageConnections },
      userId,
      locationId,
      chatId,
    );
  })();
}

// endpoint.md §6.4's chat-background read: the eligible current location (via the scene_id cache
// pointer, segway.md §2.2, falling back to the active swipe's own anchored/associated location so
// a stale scene pointer on prev/next cycling can't blank the layer) plus the last settled
// location (chat_sessions.previous_scene_id — endpoint.md §5.1.8's last-turn location state, the
// revert target shown while the current render is pending or after a swipe). Scoped to the
// requesting user. The current location is returned even before its image has rendered
// (imageUrl null): the post-turn bg pass fires only after the reply is sent (endpoint.md §5), so
// a location change lands with no image for a beat, and the client keeps the previous background
// up until the pending render is ready to replace it (§5.1.8's "notify UI"). Null is reserved
// for "no eligible location at all". The previous location is eligibility-relaxed (a historical
// pointer, not model-facing — "some background is better than no background even if stale") and
// only returned when it actually has an image to show.
export async function resolveChatLocationImage(
  db: PostgresClient,
  userId: string,
  chatId: string,
): Promise<{ current: { locationId: string; name: string; definition: string | null; imageUrl: string | null } | null; previous: { locationId: string; name: string; definition: string | null; imageUrl: string } | null }> {
  return db.withUserScope(userId, async (session) => {
    // The chat's scene pointers — current and last-turn/previous — which everything below
    // resolves through.
    const [chatState] = await session.query<{ scene_id: string | null; previous_scene_id: string | null }>(
      'select scene_id, previous_scene_id from chat_sessions where chat_id = $1',
      [chatId],
    );

    let current: { locationId: string; name: string; definition: string | null; imageUrl: string | null } | null = null;
    if (chatState?.scene_id) {
      // Primary path: the scene_id cache pointer (segway.md §2.2) -> scenes.active_location_id
      // -> locations.image_url, §2.6-filtered. The filter makes this read as absent on a stale
      // pointer — e.g. prev/next cycling flipped the active swipe but not the scene — which the
      // fallback below catches.
      const [sceneRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string | null }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from scenes s
         join locations l on l.location_id = s.active_location_id and l.user_id = $1
         where s.scene_id = $2
           and (
             l.status is null or (
               l.status <> 'inactive' and exists (
                 select 1 from location_chat_links where location_id = l.location_id and chat_id = $3
               )
             )
           )
         limit 1`,
        [userId, chatState.scene_id, chatId],
      );
      current = sceneRow
        ? { locationId: sceneRow.location_id, name: sceneRow.name, definition: sceneRow.definition, imageUrl: sceneRow.image_url }
        : null;
    }
    if (!current) {
      // Fallback: the active swipe's own location — its anchored transient row, or its recorded
      // location_swipe_images association (the cycle-back case: the location row was since
      // re-anchored to a newer swipe, but this swipe's image is still valid for it — endpoint.md
      // §5.1.8's "save the association, stays inactive, reuse on return").
      const [swipeRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string | null }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from locations l
         where l.user_id = $1
           and (
             l.status is null or (
               l.status <> 'inactive' and exists (
                 select 1 from location_chat_links where location_id = l.location_id and chat_id = $2
               )
             ) or
             exists (select 1 from location_swipe_images a
                     where a.chat_id = $2 and a.location_id = l.location_id
                       and a.swipe_id in (
                         select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
                       ))
           )
         order by (l.status = 'transient') desc, l.updated_at desc
         limit 1`,
        [userId, chatId],
      );
      current = swipeRow
        ? { locationId: swipeRow.location_id, name: swipeRow.name, definition: swipeRow.definition, imageUrl: swipeRow.image_url }
        : null;
    }

    let previous: { locationId: string; name: string; definition: string | null; imageUrl: string } | null = null;
    if (chatState?.previous_scene_id) {
      // The last settled location — shown while the current render is pending or after a swipe.
      // definition rides along (describer.md's "Definition:" half) so the canvas caption stays
      // complete when the UI is showing the previous background, mirroring the current path.
      const [prevRow] = await session.query<{ location_id: string; name: string; definition: string | null; image_url: string }>(
        `select l.location_id, l.name, l.definition, l.image_url
         from scenes s
         join locations l on l.location_id = s.active_location_id and l.user_id = $1
         where s.scene_id = $2 and l.image_url is not null
         limit 1`,
        [userId, chatState.previous_scene_id],
      );
      previous = prevRow ? { locationId: prevRow.location_id, name: prevRow.name, definition: prevRow.definition, imageUrl: prevRow.image_url } : null;
    }

    return { current, previous };
  });
}

/** endpoint.md §5.1.8's "restart bg discovery on return": after a chat load or a swipe cycle
 *  that left the active location without a rendered image (a dropped or failed pass), fire the
 *  cache-first generation pass so discovery resumes. Cache-first + the renderInFlight guard make
 *  repeat triggers no-ops whenever the image already exists or a render is already running. */
export async function ensureActiveLocationImage(deps: HttpServerDeps, userId: string, chatId: string): Promise<void> {
  try {
    const state = await resolveChatLocationImage(deps.db, userId, chatId);
    if (state.current && !state.current.imageUrl) {
      fireLocationImageGeneration(deps, userId, chatId, state.current.locationId);
    }
  } catch (err) {
    log.warn('ensureActiveLocationImage: resolution failed, skipping trigger', { chatId, err });
  }
}

// endpoint.md §5.2's broken-link expiry recovery: the browser's Chat View hit an HTTP error (404/
// expired CDN link) loading a location's background image and notifies the server, which clears
// image_url so the next visit's cache check sees a miss and re-renders a fresh URL. Only the URL
// is cleared — the location row, its description, and its environment are untouched, and
// image_generated_at is left alone (the cleared URL alone is what flips §5.1.2's cache check to
// a miss; the timestamp is stale-but-harmless and the re-render overwrites it).
export async function handleLocationImageBroken(_req: IncomingMessage, res: ServerResponse, deps: HttpServerDeps, userId: string, url: URL): Promise<void> {
  const rest = url.pathname.slice('/v1/locations/'.length); // '<id>/image-broken'
  const segments = rest.split('/').filter(Boolean);
  if (segments.length !== 2 || segments[1] !== 'image-broken') {
    sendJson(res, 404, { error: 'not found' });
    return;
  }
  const locationId = decodeURIComponent(segments[0]!);
  await deps.db.withUserScope(userId, async (session) => {
    await session.query('update locations set image_url = null where location_id = $1 and user_id = $2', [locationId, userId]);
    // endpoint.md §5.1.8: a per-swipe association must not resurrect the expired link on a
    // cycle-back — clear its URL too. The association row stays (the location identity is still
    // real); the next pass re-renders and re-records it.
    await session.query('update location_swipe_images set image_url = null where location_id = $1', [locationId]);
  });
  log.info('location image cleared after a client-side load failure (endpoint.md §5.2)', { locationId });
  sendJson(res, 200, { cleared: true });
}