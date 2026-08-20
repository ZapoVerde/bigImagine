/**
 * @file orchestrator/src/orchestrator/generateLocationImage.ts
 * @stamp 2026-08-20
 * @architectural-role Orchestrator — the location-image generation pass
 * @description
 * docs/plans/location-image-combinations.md's replacement for the old prompt-hash render cache
 * (migration 0076): background identity is now `location_id` plus an optional canonical
 * `time_of_day_key` (migration 0129), resolved through `location_image_combinations` — not the
 * synthesized prompt, provider, model, dims, steps, cfg, sampler, or seed. Those remain provenance
 * columns on the combination row, never cache identity: the same location + TOD reuses its stored
 * URL forever, regardless of what the prompt or the active provider looks like today.
 *
 * The cache lookup happens BEFORE the image connection is resolved or the prompt is synthesized —
 * a genuine behavioral improvement over the old flow, where the hash comparison needed the
 * provider's inputs first (the hash was *over* them). A cache hit here needs no active connection
 * at all.
 *
 * Every successful resolution (cache hit or fresh render) records the (chat, swipe, location) ->
 * combination association on `location_swipe_images` (migration 0076, widened by 0129 with
 * `combination_id`): the per-swipe record that makes cycling back to an old swipe resolve the
 * exact combination it used, without recomputing anything from the chat's current, possibly-newer
 * scene state.
 *
 * Two waste-prevention rules (unchanged from the pre-0129 implementation):
 *   1. Drop — the §2.6-style eligibility (BG_ELIGIBILITY_CLAUSE below) is re-checked immediately
 *      before the provider dispatch. If the turn was regenerated (a swipe landed) while this pass
 *      was starting up, the location is no longer eligible and the pending render is dropped
 *      without spending a provider round-trip; discovery restarts when that swipe becomes active
 *      again (the chat-load / cycle-back triggers).
 *   2. In-flight guard — keyed by combination identity (`location_id:todKey`), not just
 *      `location_id`: with TOD variants enabled, a kitchen/morning render must not block a
 *      concurrent kitchen/evening render. The database's partial unique indexes
 *      (location_image_combinations_base_uq / _tod_uq) remain the final race guard — an insert
 *      that loses the race returns the winning row instead of a duplicate, and logs the wasted
 *      provider spend.
 *
 * Fail-open, same contract as locationAndPresenceScraper.ts (bi_principles.md §11): every failure
 * mode — no active connection, a provider error, a bad row — logs and returns a structured result,
 * never throws. A generation failure is a missing image, not a broken turn: existing combinations
 * are untouched and the next trigger re-attempts.
 *
 * @api-declaration
 * normalizeLocationTimeOfDay(value) -> string | null — pure; trim + lowercase only, no semantic
 *   bucketing (docs/plans/location-image-combinations.md's "Canonical TOD Key")
 * generateLocationImage(deps, userId, locationId, chatId) -> Promise<LocationImageGenResult> —
 *   fail-open; { ok, cached?, imageUrl?, error? }. chatId is the calling chat, or undefined for a
 *   stateless call — see BG_ELIGIBILITY_CLAUSE.
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, settings read, provider network call)
 *     state_ownership: [module-level renderInFlight — nothing else mutates it]
 *     external_io:     [Postgres (via db.withUserScope), the injected imageConnections store,
 *                       the active image provider]
 *     never:           throws. Errors are logged and folded into the result per the fail-open
 *                      contract above.
 */

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
  /** True when an existing combination was reused — a cache hit, no provider call made. */
  cached?: boolean;
  imageUrl?: string;
  error?: string;
}

/** The only normalization the TOD key gets: trim + lowercase. No semantic bucketing — if the
 *  scene header says "late evening", the canonical key is "late evening" verbatim. Empty/blank
 *  input normalizes to null, same as "no TOD known" (falls back to the base combination). */
export function normalizeLocationTimeOfDay(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return key || null;
}

interface LocationRow {
  location_id: string;
  visual_description: string;
  environment: Record<string, unknown>;
  seed: number | null;
  /** This chat's anchor for the row, read off location_chat_links (db/migrations/0096) rather
   *  than a column on locations itself — null for a stateless call or a user-authored row. */
  anchor_swipe_id: string | null;
}

/** segway.md §2.6-style eligibility for the bg machinery, unchanged by the 0129 cache rewrite —
 *  it governs whether a location is renderable at all for this chat, not whether a combination
 *  should be reused, so it must stay identical in both call sites below (the initial lookup and
 *  the pre-provider recheck). User-authored rows (status null) are always eligible; auto-registered
 *  rows are eligible iff linked to this chat via location_chat_links and not inactive; a location
 *  is also eligible when the chat's currently active swipe has a recorded location_swipe_images
 *  association with it (an orphaned row, re-anchored to a newer swipe, still resolves for the
 *  swipe that actually used it). $3 is the chat id, or null for a stateless call, which makes both
 *  the link and association branches match nothing — only user-authored rows resolve. */
const BG_ELIGIBILITY_CLAUSE = `(
  status is null
  or (status <> 'inactive' and exists (
    select 1 from location_chat_links where location_id = locations.location_id and chat_id = $3
  ))
  or exists (select 1 from location_swipe_images a
             where a.chat_id = $3 and a.location_id = locations.location_id
               and a.swipe_id in (
                 select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
               ))
)`;

/** One render in flight per combination (location + TOD) — the restart triggers (chat load, swipe
 *  cycle-back, the post-turn fire) can overlap each other through the cache-miss window; the guard
 *  makes the second caller skip instead of double-spending a provider round-trip. Keyed by
 *  combination identity rather than just locationId so a kitchen/morning render never blocks a
 *  concurrent kitchen/evening one. Cleared in `finally`, so a failed pass can never wedge it. */
const renderInFlight = new Set<string>();

function inFlightKey(locationId: string, todKey: string | null): string {
  return `${locationId}:${todKey ?? '__base__'}`;
}

/** The per-swipe association that makes a resolved combination reusable instead of re-resolved
 *  (migration 0076, widened by 0129 with combination_id): cycling back to an old swipe reads its
 *  exact recorded combination rather than recomputing one from the chat's current scene state.
 *  Best-effort: a failure here must not fail the resolution — the combination row is the source of
 *  truth for display; the swipe association is a convenience index on top of it. */
async function recordSwipeImage(
  deps: LocationImageGenDeps,
  userId: string,
  chatId: string | undefined,
  swipeId: string | null,
  locationId: string,
  imageUrl: string,
  combinationId: string,
): Promise<void> {
  if (!chatId || !swipeId) return;
  try {
    await deps.db.withUserScope(userId, (session) =>
      session.query(
        `insert into location_swipe_images (chat_id, swipe_id, location_id, combination_id, image_url, image_generated_at)
         values ($1, $2, $3, $4, $5, now())
         on conflict (chat_id, swipe_id) do update set
           location_id = excluded.location_id,
           combination_id = excluded.combination_id,
           image_url = excluded.image_url,
           image_generated_at = excluded.image_generated_at`,
        [chatId, swipeId, locationId, combinationId, imageUrl],
      ),
    );
  } catch (err) {
    log.warn('generateLocationImage: failed to record swipe combination association, ignoring', { locationId, swipeId, err });
  }
}

export async function generateLocationImage(
  deps: LocationImageGenDeps,
  userId: string,
  locationId: string,
  chatId: string | undefined,
): Promise<LocationImageGenResult> {
  try {
    // Eligibility only — no render hash, no prompt/provider inputs. Combination identity needs
    // none of that.
    const [row] = await deps.db.withUserScope(userId, (session) =>
      session.query<LocationRow>(
        `select location_id, visual_description, environment, seed,
                (select anchor_swipe_id from location_chat_links
                 where location_id = locations.location_id and chat_id = $3) as anchor_swipe_id
         from locations where location_id = $1 and user_id = $2 and ${BG_ELIGIBILITY_CLAUSE}`,
        [locationId, userId, chatId ?? null],
      ),
    );
    if (!row) {
      log.warn('generateLocationImage: location not found or ineligible, skipping', { locationId });
      return { ok: false, error: 'location_not_found' };
    }

    // TOD policy: off means todKey is always null regardless of the current scene's TOD, so the
    // base combination is the only one that ever exists. On means the scraper's parsed
    // environment.time_of_day, normalized, or null when it's missing/blank — generation is never
    // failed over an unresolved TOD.
    const todVariantsEnabled = (await deps.settings.get('background_tod_variants_enabled')) === 'true';
    const todKey = todVariantsEnabled ? normalizeLocationTimeOfDay(row.environment.time_of_day) : null;

    // `is not distinct from` is load-bearing: a plain `=` never matches when todKey is null, but
    // the base combination's time_of_day_key IS null, so the lookup would never hit.
    const findCombination = () =>
      deps.db.withUserScope(userId, (session) =>
        session.query<{ combination_id: string; image_url: string }>(
          `select combination_id, image_url from location_image_combinations
           where location_id = $1 and time_of_day_key is not distinct from $2
           limit 1`,
          [locationId, todKey],
        ),
      );

    // Cache lookup BEFORE resolving the provider or synthesizing anything — a cached combination
    // doesn't care whether the active image connection has since changed.
    const cached = await findCombination();
    if (cached[0]) {
      await recordSwipeImage(deps, userId, chatId, row.anchor_swipe_id, locationId, cached[0].image_url, cached[0].combination_id);
      return { ok: true, cached: true, imageUrl: cached[0].image_url };
    }

    const flightKey = inFlightKey(locationId, todKey);
    if (renderInFlight.has(flightKey)) {
      log.debug('generateLocationImage: render already in flight, skipping duplicate', { locationId, todKey });
      return { ok: false, error: 'render_in_flight' };
    }
    renderInFlight.add(flightKey);
    try {
      // Recheck immediately after entering the in-flight section — closes the normal race window
      // between the first lookup above and this caller winning the guard.
      const raced = await findCombination();
      if (raced[0]) {
        await recordSwipeImage(deps, userId, chatId, row.anchor_swipe_id, locationId, raced[0].image_url, raced[0].combination_id);
        return { ok: true, cached: true, imageUrl: raced[0].image_url };
      }

      // Waste-prevention — the "swipe before we request a bg" drop rule: the turn may have been
      // regenerated while this pass was starting up, and a provider round-trip for a discarded
      // timeline is a wasted gen. Discovery restarts when that swipe becomes active again.
      const [eligible] = await deps.db.withUserScope(userId, (session) =>
        session.query<{ location_id: string }>(
          `select location_id from locations where location_id = $1 and user_id = $2 and ${BG_ELIGIBILITY_CLAUSE}`,
          [locationId, userId, chatId ?? null],
        ),
      );
      if (!eligible) {
        log.info('generateLocationImage: location superseded by a swipe, dropping pending render', { locationId });
        return { ok: false, error: 'superseded' };
      }

      // Only now resolve the provider and synthesize the prompt — the combination genuinely
      // doesn't exist yet. The prompt may still fold in time/date/environment; that's independent
      // of cache identity. With TOD variants off, the first render wins permanently even though a
      // later visit could produce a somewhat different prompt — intentional.
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
      const imageUrl = await createImageGenProvider(profile).generate({
        prompt: positive,
        negativePrompt: negative,
        model: profile.model,
        apiKey: profile.apiKey,
        baseUrl: profile.baseUrl,
        width: profile.width,
        height: profile.height,
        seed: toImageGenSeed(row.seed),
        steps: profile.samplingSteps,
        cfgScale: profile.cfgScale,
        samplerName: profile.samplerName,
        workflowParameters: profile.workflowParameters,
      });

      // The partial unique indexes (0129) are the final race guard: on conflict do nothing means
      // a losing insert returns no row, and the winning combination is fetched and used instead —
      // never overwritten. The lost race itself is the thing worth logging (a wasted provider
      // spend), not an error condition for the caller.
      const [inserted] = await deps.db.withUserScope(userId, (session) =>
        session.query<{ combination_id: string; image_url: string }>(
          `insert into location_image_combinations
             (location_id, time_of_day_key, image_url, rendered_prompt, provider_kind, provider_model, seed)
           values ($1, $2, $3, $4, $5, $6, $7)
           on conflict do nothing
           returning combination_id, image_url`,
          [locationId, todKey, imageUrl, positive, profile.kind, profile.model ?? null, toImageGenSeed(row.seed)],
        ),
      );
      let combination = inserted;
      if (!combination) {
        const [winner] = await findCombination();
        if (!winner) throw new Error('combination insert raced without a winner');
        combination = winner;
        log.warn('generateLocationImage: duplicate provider spend, another caller won the combination race', { locationId, todKey });
      }

      await recordSwipeImage(deps, userId, chatId, row.anchor_swipe_id, locationId, combination.image_url, combination.combination_id);
      log.info('generateLocationImage: rendered location image', { locationId, todKey, kind: profile.kind });
      return { ok: true, imageUrl: combination.image_url };
    } finally {
      renderInFlight.delete(flightKey);
    }
  } catch (err) {
    // bi_principles.md §11: log the seam. A failed render must never take a turn down — it's a
    // missing image, recoverable on the next trigger (cache miss re-attempts).
    log.error('generateLocationImage: generation failed, leaving existing combinations untouched', { locationId, err });
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
