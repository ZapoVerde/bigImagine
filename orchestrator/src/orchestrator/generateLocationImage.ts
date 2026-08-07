/**
 * @file orchestrator/src/orchestrator/generateLocationImage.ts
 * @stamp 2026-08-13
 * @architectural-role Orchestrator — the Vistalyze location-image generation pass (endpoint.md §5)
 * @description
 * The single implementation of docs/vistalyze_integration/endpoint.md §5.1's execution flow: the
 * cache-first, on-demand location-image generator. Given a location id, it checks the cache
 * contract (§5.1.2 — a location whose image_url exists and whose row hasn't been touched since it
 * rendered is a cache hit, zero cost), and on a miss resolves the active image connection,
 * synthesizes the prompt (util/synthesizeImagePrompt.ts, the pure function), dispatches through
 * io/imageGen/index.ts's factory, and writes the returned CDN URL + image_generated_at back to
 * the location row.
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
 * same clause as httpServer.ts's resolveChatLocationImage: an inactive (demoted alternate-timeline)
 * or foreign-chat transient location resolves as not-found rather than spending a real provider
 * call rendering an image for data that can never be displayed. The automatic post-cleanup trigger
 * always passes the chat whose turn just resolved the location, so it's never affected; the manual
 * regenerate_location_image tool is the path this actually guards, since a model can hand back a
 * stale id it's still holding from before a demotion.
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

import { log } from '../io/logger.js';
import type { ImageConnectionStore } from '../io/imageConnections.js';
import { createImageGenProvider } from '../io/imageGen/index.js';
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import type { PostgresClient } from '../io/postgres.js';
import { synthesizeImagePrompt } from '../util/synthesizeImagePrompt.js';

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
    seed: row.seed,
  };
}

function inputsMatchSnapshot(row: LocationRow): boolean {
  const snapshot = row.image_rendered_input as RenderInputSnapshot | null;
  if (!snapshot) return false;
  return (
    snapshot.visual_description === row.visual_description &&
    JSON.stringify(snapshot.environment ?? {}) === JSON.stringify(row.environment ?? {}) &&
    snapshot.seed === row.seed
  );
}

export async function generateLocationImage(
  deps: LocationImageGenDeps,
  userId: string,
  locationId: string,
  chatId: string | undefined,
): Promise<LocationImageGenResult> {
  try {
    // §2.6 eligibility, same clause as resolveChatLocationImage (httpServer.ts) and the get_*
    // tools: $3 is null for a stateless call, which makes the transient branch match nothing —
    // only permanent/user-authored rows resolve, the conservative reading.
    const location = await deps.db.withUserScope(userId, (session) =>
      session.query<LocationRow>(
        `select location_id, visual_description, environment, seed, image_url, image_generated_at, image_rendered_input
         from locations where location_id = $1 and user_id = $2 and (
           status = 'permanent' or status is null or
           (status = 'transient' and anchor_swipe_id in (
             select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
           ))
         )`,
        [locationId, userId, chatId ?? null],
      ),
    );
    const row = location[0];
    if (!row) {
      log.warn('generateLocationImage: location not found or ineligible, skipping', { locationId });
      return { ok: false, error: 'location_not_found' };
    }

    // §5.1.2 cache validation: an image URL whose *render inputs* are unchanged since it was
    // generated is a hit. Inputs are compared against the image_rendered_input snapshot recorded
    // at the last successful render — not against updated_at, because the post-cleanup scraper
    // bumps updated_at on every matched turn (its environment merge and transient re-anchor run
    // even when nothing visual changed), which would otherwise make this check always miss and
    // silently defeat the cache-first commitment (endpoint.md §1.3). A broken/expired CDN link
    // is handled upstream (§5.2 clears image_url, which turns this into a miss and re-renders).
    if (row.image_url && inputsMatchSnapshot(row)) {
      return { ok: true, cached: true, imageUrl: row.image_url };
    }

    // §5.1.3 resolve the active image connection (or chat/scene override — none exists yet, so
    // the global active connection is the only pointer, resolved live per bi_principles.md §13).
    const profile = await deps.imageConnections.resolveActive();
    if (!profile) {
      log.warn('generateLocationImage: no active image connection configured, skipping render', { locationId });
      return { ok: false, error: 'no_active_connection' };
    }

    // §5.1.4 prompt synthesis — the master template (image_prompt_template setting, '' = built-in
    // default per bi_principles.md §18) expanded against the location's description/environment.
    const template = (await deps.settings.get('image_prompt_template')) ?? '';
    const { positive, negative } = synthesizeImagePrompt({
      template,
      visualDescription: row.visual_description,
      environment: row.environment,
      stylePrefix: profile.masterPositiveStylePrefix ?? '',
      negativePrompt: profile.masterNegativePrompt ?? '',
    });

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
      seed: row.seed,
      steps: profile.samplingSteps,
      cfgScale: profile.cfgScale,
      samplerName: profile.samplerName,
      workflowParameters: profile.workflowParameters,
    });

    // §5.1.7 update the location row — the URL, the render timestamp, and the input snapshot that
    // makes it a cache hit next time. updated_at is intentionally *not* bumped here: the row's
    // content is unchanged by a render, and bumping it would be pointless now that cache
    // validation compares inputs against the snapshot, not the timestamp.
    const inputs = currentInputs(row);
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        `update locations set image_url = $2, image_generated_at = now(), image_rendered_input = $3::jsonb
         where location_id = $1 and user_id = $4`,
        [locationId, imageUrl, JSON.stringify(inputs), userId],
      ),
    );

    log.info('generateLocationImage: rendered location image', { locationId, kind: profile.kind });
    return { ok: true, imageUrl };
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed render must never take a turn down — it's a
    // missing/aged image, recoverable on the next trigger (cache miss re-attempts).
    log.error('generateLocationImage: generation failed, leaving existing image untouched', { locationId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
