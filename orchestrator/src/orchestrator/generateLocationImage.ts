/**
 * @file orchestrator/src/orchestrator/generateLocationImage.ts
 * @stamp 2026-08-13
 * @architectural-role Orchestrator — the Vistalyze location-image generation pass (endpoint.md §5)
 * @description
 * The single implementation of docs/vistalyze_integration/endpoint.md §5.1's execution flow: the
 * cache-first, on-demand location-image generator. Given a location id, it checks the cache
 * contract (§5.1.2) and on a miss resolves the active image connection, synthesizes the prompt
 * (util/synthesizeImagePrompt.ts, the pure function), dispatches through io/imageGen/index.ts's
 * factory, and writes the returned CDN URL + render timestamp + input snapshot + prompt hash back
 * to the location row.
 *
 * The cache key is the *render hash* (migration 0076): a sha256 over the actual synthesized
 * prompts plus every other output-affecting provider input (model, dims, steps, cfg, sampler,
 * workflow params, seed). The prompt folds in the template and the connection's style prefix, so
 * the hash IS the variant — same hash reuses the URL (zero provider cost), a changed hash (the
 * bg description varied, or eventually a mood/time slot, or a different connection) renders. The
 * pre-existing image_rendered_input snapshot comparison is kept as a one-time legacy path for
 * rows rendered before 0076 (their hash is null), so no existing image is wasted by the change.
 *
 * Every successful render (cache hit or fresh) also records the (chat, swipe, location) -> URL +
 * hash association on location_swipe_images (migration 0076): the per-swipe record that makes a
 * rendered background reusable instead of re-generated when that swipe becomes active again, and
 * that keeps an orphaned location (re-anchored to a newer swipe) renderable for the swipe that
 * actually used it.
 *
 * Two waste-prevention rules (endpoint.md §5.1.8 + the user's "don't waste a gen" contract):
 *   1. Drop — the §2.6 eligibility is re-checked immediately before the provider dispatch. If the
 *      turn was regenerated (a swipe landed) while this pass was starting up, the location is no
 *      longer eligible and the pending render is dropped without spending a provider round-trip;
 *      discovery restarts when that swipe becomes active again (the chat-load / cycle-back
 *      triggers). A swipe landing *during* the provider call is not a waste: the URL is recorded
 *      against the swipe it was for and reused on return.
 *   2. In-flight guard — the restart triggers (chat load, cycle-back) can overlap the post-turn
 *      fire; one provider call per location at a time, the second caller skips instead of
 *      double-spending through the cache-miss window.
 *
 * "Plain async function" is load-bearing (endpoint.md §6.2): this is the real implementation and
 * the only thing both the post-cleanup trigger and the plugin tool wrapper call. It is
 * deliberately *not* awaited inline by the request-handling path — server/httpServer.ts fires it
 * after the response is sent, decoupled like chatMemorySync.ts's tick — because a provider round
 * trip has no place blocking the reply the user is waiting on.
 *
 * Fail-open, same contract as locationAndPresenceScraper.ts (bi_principles.md §11): every
 * failure mode — no active connection, a provider error, a bad row — logs and returns a
 * structured result, never throws. A generation failure is a missing image, not a broken turn:
 * the cache row keeps its old URL (or stays null) and the next trigger re-attempts.
 *
 * Applies docs/vistalyze_integration/segway.md §2.6's eligibility filter to the location lookup —
 * the same clause as httpServer.ts's resolveChatLocationImage — extended with the
 * location_swipe_images association (an active swipe's recorded location is eligible even when
 * the row itself was since re-anchored). An inactive (demoted alternate-timeline) or
 * foreign-chat transient location resolves as not-found rather than spending a real provider
 * call rendering an image for data that can never be displayed. The automatic post-cleanup
 * trigger always passes the chat whose turn just resolved the location, so it's never affected;
 * the manual regenerate_location_image tool is the path this actually guards, since a model can
 * hand back a stale id it's still holding from before a demotion.
 *
 * @api-declaration
 * LocationImageGenDeps — db (PostgresClient), settings (OrchestratorSettingsStore), imageConnections
 * generateLocationImage(deps, userId, locationId, chatId) -> Promise<LocationImageGenResult> — fail-open;
 *   { ok, cached?, imageUrl?, error? }. chatId is the calling chat, or undefined for a stateless
 *   call — see the §2.6 eligibility note below.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, provider network call)
 *     state_ownership: []
 *     external_io:     [Postgres (via db.withUserScope for the location row, the injected
 *                       imageConnections store for the connection), the active image provider]
 *     never:           throws. Errors are logged and folded into the result per the fail-open
 *                      contract above.
 */

import { createHash } from 'node:crypto';
import { log } from '../io/logger.js';
import type { ImageConnectionStore } from '../io/imageConnections.js';
import { createImageGenProvider } from '../io/imageGen/index.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { synthesizeImagePrompt, toImageGenSeed } from '../util/synthesizeImagePrompt.js';

export interface LocationImageGenDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
  imageConnections: ImageConnectionStore;
}

export interface LocationImageGenResult {
  ok: boolean;
  /** True when the existing image was kept — a cache hit, no provider call made. */
  cached?: boolean;
  imageUrl?: string;
  error?: string;
}

interface LocationRow {
  location_id: string;
  visual_description: string;
  environment: Record<string, unknown>;
  seed: number | null;
  image_url: string | null;
  image_generated_at: string | null;
  image_rendered_input: Record<string, unknown> | null;
  image_render_hash: string | null;
  anchor_swipe_id: string | null;
  status: string | null;
}

/** The render inputs endpoint.md §5.1 compares for cache validation — the same three fields the
 *  snapshot column records and the provider consumes. JSON-equal means "unchanged since render". */
interface RenderInputSnapshot {
  visual_description: string;
  environment: Record<string, unknown>;
  seed: number | null;
}

function currentInputs(row: LocationRow): RenderInputSnapshot {
  return {
    visual_description: row.visual_description,
    environment: row.environment,
    // The effective seed — legacy rows have locations.seed null, but every render now runs on
    // the shared fixed seed, and the snapshot must record what was actually sent to the provider.
    // toImageGenSeed also coerces the bigint-as-string node-postgres hands back for a non-null
    // locations.seed, so the snapshot and the wire payload always carry a real number.
    seed: toImageGenSeed(row.seed),
  };
}

function inputsMatchSnapshot(row: LocationRow): boolean {
  const snapshot = row.image_rendered_input as RenderInputSnapshot | null;
  if (!snapshot) return false;
  return (
    snapshot.visual_description === row.visual_description &&
    JSON.stringify(snapshot.environment ?? {}) === JSON.stringify(row.environment ?? {}) &&
    toImageGenSeed(snapshot.seed) === toImageGenSeed(row.seed)
  );
}

/** segway.md §2.6 eligibility for the bg machinery (endpoint.md §5 + migration 0076): the
 *  standard clause plus "the chat's active swipe has a recorded location_swipe_images
 *  association with this location" — an orphaned row (re-anchored to a newer swipe) still
 *  resolves for the swipe that actually used it, so cycle-back reuse and the restart triggers
 *  stay consistent with the per-swipe association. $3 is the chat id, or null for a stateless
 *  call — which makes both the anchor branch and the association branch match nothing (only
 *  permanent/user-authored rows resolve, the conservative reading). */
const BG_ELIGIBILITY_CLAUSE = `(
  status = 'permanent'
  or status is null
  or (status = 'transient' and anchor_swipe_id in (
    select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
  ))
  or exists (select 1 from location_swipe_images a
             where a.chat_id = $3 and a.location_id = locations.location_id
               and a.swipe_id in (
                 select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
               ))
)`;

/** One render in flight per location — the restart triggers (chat load, swipe cycle-back, the
 *  post-turn fire) can overlap each other through the cache-miss window; the guard makes the
 *  second caller skip instead of double-spending a provider round-trip. Cleared in `finally`,
 *  so a failed pass can never wedge the location. */
const renderInFlight = new Set<string>();

/** The output-affecting inputs the render cache is keyed on (endpoint.md §5.1.2): the actual
 *  synthesized prompts plus every provider parameter that changes the bytes. The prompt folds in
 *  the template and the connection's style, so "the prompt is the variant" — same hash reuses
 *  the URL, a changed hash (bg description, a mood/time slot, a different connection) renders. */
function renderInputHash(input: {
  positive: string;
  negative: string;
  kind: string;
  model: string | null;
  width: number | null;
  height: number | null;
  steps: number | null;
  cfgScale: number | null;
  samplerName: string | null;
  workflowParameters: Record<string, unknown> | null;
  seed: number | null;
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** endpoint.md §5.1.8 + migration 0076: record which location the chat's swipe used and the URL
 *  it rendered — the per-swipe association that makes the image reusable (cycle-back reuses the
 *  URL instead of re-generating) and that keeps an orphaned location renderable for its own
 *  swipe. Keyed by (chat_id, swipe_id), one location per swipe. Best-effort: a failure here must
 *  not fail the render — the image on the location row is the source of truth for display. */
async function recordSwipeImage(
  deps: LocationImageGenDeps,
  userId: string,
  chatId: string | undefined,
  swipeId: string | null,
  locationId: string,
  imageUrl: string,
  renderHash: string,
): Promise<void> {
  if (!chatId || !swipeId) return;
  try {
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        `insert into location_swipe_images (chat_id, swipe_id, location_id, image_url, render_hash, image_generated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (chat_id, swipe_id) do update set
           location_id = excluded.location_id,
           image_url = excluded.image_url,
           render_hash = excluded.render_hash,
           image_generated_at = excluded.image_generated_at`,
        [chatId, swipeId, locationId, imageUrl, renderHash],
      ),
    );
  } catch (err) {
    log.warn('generateLocationImage: failed to record swipe image association, ignoring', { locationId, swipeId, err });
  }
}

export async function generateLocationImage(
  deps: LocationImageGenDeps,
  userId: string,
  locationId: string,
  chatId: string | undefined,
): Promise<LocationImageGenResult> {
  try {
    // §2.6 eligibility, same clause as resolveChatLocationImage (httpServer.ts) and the get_*
    // tools, extended with the location_swipe_images association: $3 is null for a stateless
    // call, which makes the transient + association branches match nothing — only
    // permanent/user-authored rows resolve, the conservative reading.
    const location = await deps.db.withUserScope(userId, (session) =>
      session.query<LocationRow>(
        `select location_id, visual_description, environment, seed, image_url, image_generated_at,
                image_rendered_input, image_render_hash, anchor_swipe_id, status
         from locations where location_id = $1 and user_id = $2 and ${BG_ELIGIBILITY_CLAUSE}`,
        [locationId, userId, chatId ?? null],
      ),
    );
    const row = location[0];
    if (!row) {
      log.warn('generateLocationImage: location not found or ineligible, skipping', { locationId });
      return { ok: false, error: 'location_not_found' };
    }

    // §5.1.3-4 resolve the active image connection and synthesize the prompt FIRST — the render
    // hash (the §5.1.2 cache key) is over the actual provider inputs, so it needs them. When no
    // connection is configured there is nothing to compare or render; the row keeps its old URL.
    const profile = await deps.imageConnections.resolveActive();
    if (!profile) {
      log.warn('generateLocationImage: no active image connection configured, skipping render', { locationId });
      return { ok: false, error: 'no_active_connection' };
    }
    const template = (await deps.settings.get('image_prompt_template')) ?? '';
    const { positive, negative } = synthesizeImagePrompt({
      template,
      visualDescription: row.visual_description,
      environment: row.environment,
      stylePrefix: profile.masterPositiveStylePrefix ?? '',
      negativePrompt: profile.masterNegativePrompt ?? '',
    });
    const renderHash = renderInputHash({
      positive,
      negative,
      kind: profile.kind,
      model: profile.model ?? null,
      width: profile.width ?? null,
      height: profile.height ?? null,
      steps: profile.samplingSteps ?? null,
      cfgScale: profile.cfgScale ?? null,
      samplerName: profile.samplerName ?? null,
      workflowParameters: profile.workflowParameters ?? null,
      seed: toImageGenSeed(row.seed),
    });

    // §5.1.2 cache validation, re-keyed to the prompt hash: an image URL whose render hash
    // matches the current inputs is a hit, zero provider cost — the "same prompt reuses the old
    // URL" rule. The image_rendered_input snapshot comparison is the one-time legacy path for
    // rows rendered before 0076 (hash null) so existing images are never wasted by the change;
    // a legacy hit backfills the hash so the next check fast-paths. A broken/expired CDN link
    // is handled upstream (§5.2 clears image_url, which turns this into a miss and re-renders).
    if (row.image_url && (row.image_render_hash === renderHash || (row.image_render_hash === null && inputsMatchSnapshot(row)))) {
      if (row.image_render_hash !== renderHash) {
        await deps.db
          .withUserScope(userId, (session) => session.query('update locations set image_render_hash = $2 where location_id = $1', [locationId, renderHash]))
          .catch((err) => log.warn('generateLocationImage: failed to backfill render hash, ignoring', { locationId, err }));
      }
      await recordSwipeImage(deps, userId, chatId, row.anchor_swipe_id, locationId, row.image_url, renderHash);
      return { ok: true, cached: true, imageUrl: row.image_url };
    }

    // Waste-prevention: one provider call per location at a time. The restart triggers (chat
    // load, cycle-back) can overlap the post-turn fire; a duplicate through the cache-miss
    // window would be a wasted gen.
    if (renderInFlight.has(locationId)) {
      log.debug('generateLocationImage: render already in flight, skipping duplicate', { locationId });
      return { ok: false, error: 'render_in_flight' };
    }
    renderInFlight.add(locationId);
    try {
      // Waste-prevention — the "swipe before we request a bg" drop rule: the turn may have been
      // regenerated while this pass was starting up, and a provider round-trip for a discarded
      // timeline is a wasted gen. Re-check the same eligibility immediately before the
      // expensive call (cheap: one indexed read). Discovery restarts when that swipe becomes
      // active again (chat-load / cycle-back triggers).
      const stillEligible = await deps.db.withUserScope(userId, (session) =>
        session.query<{ location_id: string }>(
          `select location_id from locations where location_id = $1 and user_id = $2 and ${BG_ELIGIBILITY_CLAUSE}`,
          [locationId, userId, chatId ?? null],
        ),
      );
      if (!stillEligible[0]) {
        log.info('generateLocationImage: location superseded by a swipe, dropping pending render', { locationId });
        return { ok: false, error: 'superseded' };
      }

      // §5.1.5-6 execute the provider adapter; the URL comes back, image bytes never touch this
      // process (endpoint.md §1.1 stateless media). Dimensions are the connection's own explicit
      // output pixels (image_connections.width/height).
      const imageUrl = await createImageGenProvider(profile).generate({
        prompt: positive,
        negativePrompt: negative,
        model: profile.model,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        width: profile.width,
        height: profile.height,
        seed: toImageGenSeed(row.seed),  // number, not the bigint-as-string pg returns
        steps: profile.samplingSteps,
        cfgScale: profile.cfgScale,
        samplerName: profile.samplerName,
        workflowParameters: profile.workflowParameters,
      });

      // §5.1.7 update the location row — the URL, the render timestamp, the input snapshot, and
      // the prompt hash that makes it a cache hit next time. updated_at is intentionally *not*
      // bumped here: the row's content is unchanged by a render, and bumping it would be
      // pointless now that cache validation compares the hash, not the timestamp.
      const inputs = currentInputs(row);
      await deps.db.withUserScope(userId, (session) =>
        session.query(
          `update locations set image_url = $2, image_generated_at = now(), image_rendered_input = $3::jsonb, image_render_hash = $4
           where location_id = $1 and user_id = $5`,
          [locationId, imageUrl, JSON.stringify(inputs), renderHash, userId],
        ),
      );
      await recordSwipeImage(deps, userId, chatId, row.anchor_swipe_id, locationId, imageUrl, renderHash);

      log.info('generateLocationImage: rendered location image', { locationId, kind: profile.kind });
      return { ok: true, imageUrl };
    } finally {
      renderInFlight.delete(locationId);
    }
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed render must never take a turn down — it's a
    // missing/aged image, recoverable on the next trigger (cache miss re-attempts).
    log.error('generateLocationImage: generation failed, leaving existing image untouched', { locationId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
