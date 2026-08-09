/**
 * @file orchestrator/src/orchestrator/locationAndPresenceScraper.ts
 * @stamp 2026-08-13
 * @architectural-role Orchestrator — Stage 2 of the post-turn pipeline (segway.md §4), with the
 *   pure parsing split out per bi_principles.md §8
 * @description
 * docs/vistalyze_integration/segway.md §4: the post-cleanup heuristic scraper. Stage 1 (the async
 * cleanup subloop, orchestrator/cleanupLoop.ts) may rewrite a turn's text
 * to open with the two-line header block defined in docs/vistalyze_integration/cleanup_prompt.md
 * §2.4:
 *
 *   [ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]
 *   Present: Character A, Character B
 *
 * Stage 2 deterministically scrapes that header (zero tokens — bi_principles.md §2's "the LLM
 * reasons, nothing else does" is about judgment, and this is not judgment: it reads a
 * machine-guaranteed block) and turns it into trusted scene state (bi_principles.md §4): the
 * location is resolved-or-created on `locations` (§4.2), the (chat, location) scene is
 * resolved-or-created with `chat_sessions.scene_id` stamped as the cache pointer (§4.2.4), the
 * `Present:` roster is resolved-or-auto-registered on `characters` (§4.4), and the scene's
 * `scene_presence` is replaced with exactly that roster.
 *
 * Lifecycle columns are the point of the spec, not decoration: every created row is
 * `status = 'transient'` anchored to the turn's active swipe, so orchestrator/chatMemorySync.ts's
 * existing sync tick can promote it to `permanent` when the turn exits the live window or demote
 * it to `inactive` (never delete) when an alternate swipe wins instead — and io/chatSessions.ts's
 * forkChat can resurrect it onto a forked branch. All lookups here are filtered to
 * segway.md §2.6-eligible rows only (permanent, or transient whose anchor is on this chat's
 * active swipe path, or — for characters — user-authored `status is null`), so a name match
 * can never resurrect a different timeline's same-named row.
 *
 * Fail-open (segway.md §1): this module never throws. A missing header, a missing swipe anchor,
 * or any DB failure logs and returns, leaving the turn untouched. Both call sites
 * (server/httpServer.ts's handleChatCompletions and regenerateSwipe) rely on that contract.
 *
 * @api-declaration
 * parseStoryHeader(text) -> StoryHeader | null — pure; the two-line header parse, no IO
 * scrapeTurnPresence(deps, userId, chatId, messageId, text, mode) -> Promise<string | undefined> —
 *   fail-open; parse, anchor the turn's active swipe, then extract location/scene/characters/
 *   presence, returning the resolved location id (the async image-gen trigger's target). mode is
 *   'extend' for a genuinely new turn (a location change advances chat_sessions.previous_scene_id)
 *   or 'replace' for a swipe regeneration (the replaced turn's location must NOT become the
 *   previous one — the revert target stays the last settled location, endpoint.md §5.1.8)
 *
 * @contract
 *   assertions:
 *     purity:          parseStoryHeader is pure; scrapeTurnPresence is impure (Postgres IO)
 *     state_ownership: [] (scene/location/presence rows live in Postgres; this module owns none)
 *     external_io:     [Postgres (via db.withUserScope), the injected ensureActiveSwipe callback
 *                       (chatSessions.ts owns chat_message_swipes writes)]
 *     never:           throws. Errors are logged and swallowed per segway.md §1's fail-open
 *                      contract; no prompt/header content is ever trusted further than the regex.
 */

import type { PostgresClient } from '../io/postgres.js';
import type { DbSession } from '../io/postgres.js';
import { log } from '../io/logger.js';
import { toImageGenSeed } from '../util/synthesizeImagePrompt.js';

/** The two-line header block (docs/vistalyze_integration/cleanup_prompt.md §2.4), parsed. */
export interface StoryHeader {
  timeOfDay: string;
  dateLine: string;
  location: string;
  /** The `Present:` roster, trimmed and de-duplicated in order. Empty when the roster line
   *  listed nobody (an empty `Present:` is authoritative: presence is replaced with nothing). */
  present: string[];
}

/**
 * `[ TimeOfDay | 🗓️ DayOfWeek, Month DD, YYYY Era | 📍 Location - Specific Area ]`
 * Both emoji prefixes are optional (the model may or may not emit them) and the field separators
 * tolerate surrounding whitespace. Non-greedy field capture so a `|` inside the location text
 * can't split it.
 */
const HEADER_LINE_RE = /^\[\s*([^|]+?)\s*\|\s*(?:🗓️\s*)?([^|]+?)\s*\|\s*(?:📍\s*)?(.+?)\s*\]$/;
const PRESENT_LINE_RE = /^Present:\s*(.*)$/i;

/**
 * Pure parse of segway.md §4.1: line 1 must be the bracketed header and line 2 the `Present:`
 * roster, in that order, as the first two non-blank lines of the text. Returns null on any
 * mismatch — the spec's fail-open contract says skip extraction entirely on a non-match, never
 * attempt a partial parse (a line-1 match with no roster line is also a non-match: §4.4 has
 * nothing to populate from without `Present:`).
 */
export function parseStoryHeader(text: string): StoryHeader | null {
  if (!text) return null;
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === '') i++;
  const line1 = lines[i]?.trim() ?? '';
  const line2 = lines[i + 1]?.trim() ?? '';
  const headerMatch = HEADER_LINE_RE.exec(line1);
  if (!headerMatch) return null;
  const presentMatch = PRESENT_LINE_RE.exec(line2);
  if (!presentMatch) return null;
  const present = [...new Set(presentMatch[1]!.split(',').map((s) => s.trim()).filter((s) => s.length > 0))];
  return { timeOfDay: headerMatch[1]!.trim(), dateLine: headerMatch[2]!.trim(), location: headerMatch[3]!.trim(), present };
}

/** The scraper's narrow dependency surface. ensureActiveSwipe lives in chatSessions.ts (the
 *  single owner of chat_message_swipes writes, per bi_principles.md §8) and is injected rather
 *  than re-implemented here. */
export interface TurnPresenceScrapeDeps {
  db: PostgresClient;
  /** Returns the message's active swipe id, creating the message's own swipe row if it has none
   *  yet (fresh assistant turns are persisted swipe-less; recordSwipe's regeneration always has
   *  one). Undefined when the message doesn't exist. */
  ensureActiveSwipe: (userId: string, chatId: string, messageId: string) => Promise<string | undefined>;
}

/**
 * Stage 2's single entry point, called by server/httpServer.ts after the turn's text is final
 * (post-cleanup) and the message is persisted. Fail-open end to end: any step logs and returns
 * undefined; a turn is never blocked or degraded by this (segway.md §1).
 *
 * Returns the resolved location id (segway.md §4.2) when extraction succeeded — server/httpServer.ts
 * uses it to fire the async location-image generation pass (endpoint.md §5, decoupled, never
 * awaited inline). undefined when extraction was skipped or failed.
 */
export async function scrapeTurnPresence(
  deps: TurnPresenceScrapeDeps,
  userId: string,
  chatId: string,
  messageId: string,
  text: string,
  mode: 'extend' | 'replace' = 'extend',
): Promise<string | undefined> {
  try {
    const header = parseStoryHeader(text);
    if (!header) {
      log.debug('post-cleanup scraper: no two-line header block, skipping extraction', { chatId });
      return undefined;
    }
    // The turn's anchor: every transient row this scrape creates must be attributable to the
    // exact swipe that produced the text, so the sync tick can promote/demote it later (§2.5).
    const swipeId = await deps.ensureActiveSwipe(userId, chatId, messageId);
    if (!swipeId) {
      log.warn('post-cleanup scraper: turn has no anchorable swipe, skipping extraction', { chatId, messageId });
      return undefined;
    }
    return await deps.db.withUserScope(userId, (session) => extractFromHeader(session, userId, chatId, swipeId, header, mode));
  } catch (err) {
    // bi_principles.md §11: log the seam — a silent failure here would quietly lose trusted
    // scene state, but it must never take the turn down with it.
    log.error('post-cleanup scraper: extraction failed, skipping (fail-open)', { chatId, messageId, err });
    return undefined;
  }
}

/** segway.md §2.6's eligibility predicate, shared by the location and character lookups below.
 *  A row is eligible iff it is permanent, OR it is a user-authored row outside the lifecycle
 *  (characters only — status null), OR it is transient with its anchor on this chat's active
 *  swipe path. Inactive rows are never eligible. */
const ELIGIBLE_TRANSIENT_CLAUSE = `(
  status = 'permanent'
  or status is null
  or (status = 'transient' and anchor_swipe_id in (
    select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
  ))
)`;

async function extractFromHeader(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  header: StoryHeader,
  mode: 'extend' | 'replace',
): Promise<string> {
  const locationId = await resolveLocation(session, userId, chatId, swipeId, header);
  const sceneId = await resolveScene(session, userId, chatId, locationId, mode);
  const characterIds = await resolvePresentCharacters(session, userId, chatId, swipeId, header.present);
  await replaceScenePresence(session, userId, sceneId, characterIds);
  log.info('post-cleanup scraper: extracted turn scene state', {
    chatId,
    locationId,
    sceneId,
    present: characterIds.length,
  });
  return locationId;
}

/** segway.md §4.2: resolve-or-create the location. A matched row's environment is refreshed
 *  (jsonb merge, so any richer weather/mood a future Vistalyze pass wrote survives); a new row
 *  is transient, anchored to this turn's swipe, with visual_description seeded from the
 *  extracted name and environment from the extracted time/date. A matched *transient* row is
 *  re-anchored to this turn's swipe too — continued use of the same place across turns is the
 *  active-timeline signal, so the row must follow the current turn's swipe, not stay pinned to
 *  the turn that first created it (which the sync tick may otherwise demote as an alternate
 *  timeline even though the live story still stands in it). Permanent/user-authored rows keep
 *  their identity untouched.
 *
 *  The no-match mint path carries the rendered image fingerprint (§4.2.5, endpoint.md §5.1.2's
 *  "same place reuses its image" rule): a rerun/regeneration of the turn that anchored a row
 *  supersedes that row's swipe, making the row ineligible for a later revisit — the same room
 *  would otherwise mint a fresh row and re-render a pixel-identical bg (identical name and, with
 *  the shared fixed seed, an identical provider output). Instead the new row clones the most
 *  recent same-named row's seed/image_url/image_rendered_input/image_render_hash (scoped to this
 *  chat, so another chat's row of the same name never leaks in), which makes the follow-up
 *  generation pass a §5.1.2 cache hit: zero provider cost, and the visible bg never changes for
 *  the same room. A genuinely new place (no prior image) mints blank and renders as before. */
async function resolveLocation(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  header: StoryHeader,
): Promise<string> {
  const environment = JSON.stringify({ time_of_day: header.timeOfDay, date: header.dateLine });
  const matched = await session.query<{ location_id: string; status: string | null }>(
    `select location_id, status from locations
     where user_id = $1 and name = $2 and ${ELIGIBLE_TRANSIENT_CLAUSE}
     order by (status is null) desc, (status = 'permanent') desc, location_id`,
    [userId, header.location, chatId],
  );
  if (matched[0]) {
    // Re-anchor a transient match to the turn that's using it now (see the doc above); leave
    // permanent/user-authored rows alone.
    await session.query(
      matched[0].status === 'transient'
        ? `update locations set environment = environment || $3::jsonb, anchor_swipe_id = $4, updated_at = now()
           where location_id = $1 and user_id = $2`
        : `update locations set environment = environment || $3::jsonb, updated_at = now()
           where location_id = $1 and user_id = $2`,
      matched[0].status === 'transient'
        ? [matched[0].location_id, userId, environment, swipeId]
        : [matched[0].location_id, userId, environment],
    );
    return matched[0].location_id;
  }

  // §4.2.5 same-place carry — the row-churn reuse described in the docstring above. Also clones
  // the prior row's visual_description/definition when it was actually described (non-name): the
  // carried image hash was computed over the described prompt, so the new row must hold the same
  // description or the §5.1.2 cache check misses and the render fires with a name-only prompt
  // (worse image + wasted gen). The describer's own skip rule (describeLocation.ts) sees the
  // carried description as "already described" — no second LLM call for the same room.
  const [prior] = await session.query<{
    image_url: string | null;
    image_rendered_input: unknown;
    image_render_hash: string | null;
    seed: number | null;
    visual_description: string | null;
    definition: string | null;
  }>(
    `select image_url, image_rendered_input, image_render_hash, seed, visual_description, definition
     from locations
     where user_id = $1 and name = $2 and anchor_chat_id = $3 and image_url is not null
     order by image_generated_at desc nulls last
     limit 1`,
    [userId, header.location, chatId],
  );
  // The minted description: the prior row's real description when it has one (non-empty and not
  // just the name), else the name-seed this mint would otherwise write — a genuinely new place
  // still seeds from its name and the describer enriches it after.
  const carriedDescription =
    prior?.visual_description && prior.visual_description.trim() !== '' && prior.visual_description !== header.location
      ? prior.visual_description
      : header.location;

  const [created] = await session.query<{ location_id: string }>(
    `insert into locations (user_id, name, visual_description, definition, environment, seed, image_url, image_rendered_input, image_render_hash, status, anchor_chat_id, anchor_swipe_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, 'transient', $10, $11)
     returning location_id`,
    [
      userId,
      header.location,
      carriedDescription,
      prior?.definition ?? null,
      environment,
      toImageGenSeed(prior?.seed),
      prior?.image_url ?? null,
      prior?.image_rendered_input ?? null,
      prior?.image_render_hash ?? null,
      chatId,
      swipeId,
    ],
  );
  return created!.location_id;
}

/** segway.md §4.2.4: resolve-or-reuse the scene by its (chat_id, active_location_id) identity,
 *  then stamp chat_sessions.scene_id with it — the cache pointer other readers use for a cheap
 *  current-scene read (segway.md §2.2). No special-case fork handling needed here: a forked
 *  chat resolves-or-creates its own scenes through this same path.
 *
 *  The "last-turn location state" (endpoint.md §5.1.8) is maintained on the same stamp: when an
 *  *extending* turn moves the chat to a different scene, the scene that was current a moment ago
 *  becomes chat_sessions.previous_scene_id — the revert target the chat-background UI shows while
 *  the new location's render is pending or after a swipe. A 'replace' turn (swipe regeneration)
 *  never advances it: the replaced turn's location is discarded, not a previous state, so the
 *  revert target keeps pointing at the last settled location across a chain of swipes. */
async function resolveScene(
  session: DbSession,
  userId: string,
  chatId: string,
  locationId: string,
  mode: 'extend' | 'replace',
): Promise<string> {
  const existing = await session.query<{ scene_id: string }>(
    `select scene_id from scenes where chat_id = $1 and active_location_id = $2 and user_id = $3`,
    [chatId, locationId, userId],
  );
  let sceneId: string;
  if (existing[0]) {
    sceneId = existing[0].scene_id;
    await session.query('update scenes set last_active_at = now() where scene_id = $1', [sceneId]);
  } else {
    const [locationName] = await session.query<{ name: string }>(
      'select name from locations where location_id = $1 and user_id = $2',
      [locationId, userId],
    );
    const [created] = await session.query<{ scene_id: string }>(
      `insert into scenes (user_id, name, chat_id, active_location_id) values ($1, $2, $3, $4)
       returning scene_id`,
      [userId, locationName?.name ?? 'Scene', chatId, locationId],
    );
    sceneId = created!.scene_id;
  }
  const [before] = await session.query<{ scene_id: string | null }>(
    'select scene_id from chat_sessions where chat_id = $1',
    [chatId],
  );
  if (mode === 'extend' && before?.scene_id !== sceneId) {
    await session.query('update chat_sessions set scene_id = $1, previous_scene_id = $2 where chat_id = $3', [
      sceneId,
      before?.scene_id ?? null,
      chatId,
    ]);
  } else {
    await session.query('update chat_sessions set scene_id = $1 where chat_id = $2', [sceneId, chatId]);
  }
  return sceneId;
}

/** segway.md §4.4: resolve-or-auto-register each `Present:` name. A user-authored character
 *  (status null) or an eligible transient/permanent one is matched by exact name (matches are
 *  ordered user-authored first, then permanent, then transient, with a stable id tiebreak, so a
 *  same-named roster resolves deterministically); a matched transient character is re-anchored
 *  to this turn's swipe, same "continued presence follows the live timeline" rule as locations.
 *  Anything else becomes a placeholder identity — transient, anchored to this turn, every other
 *  field at its default (a user can flesh it out from the Characters view later). */
async function resolvePresentCharacters(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  names: string[],
): Promise<string[]> {
  const characterIds: string[] = [];
  for (const name of names) {
    const matched = await session.query<{ character_id: string; status: string | null }>(
      `select character_id, status from characters
       where user_id = $1 and name = $2 and ${ELIGIBLE_TRANSIENT_CLAUSE}
       order by (status is null) desc, (status = 'permanent') desc, character_id`,
      [userId, name, chatId],
    );
    if (matched[0]) {
      characterIds.push(matched[0].character_id);
      if (matched[0].status === 'transient') {
        // character_id is a global PK, but name the user_id anyway so the scoping is
        // self-evident (RLS backstops either way).
        await session.query('update characters set anchor_swipe_id = $2, updated_at = now() where character_id = $1 and user_id = $3', [
          matched[0].character_id,
          swipeId,
          userId,
        ]);
      }
      continue;
    }
    const [created] = await session.query<{ character_id: string }>(
      `insert into characters (user_id, name, status, anchor_chat_id, anchor_swipe_id)
       values ($1, $2, 'transient', $3, $4)
       returning character_id`,
      [userId, name, chatId, swipeId],
    );
    characterIds.push(created!.character_id);
  }
  return characterIds;
}

/** segway.md §4.4.3: `Present:` is authoritative for who's here now — replace the scene's
 *  presence with exactly the resolved roster. A character absent this turn is removed from
 *  presence (never deleted, just no longer marked present). Runs in the same transaction as the
 *  rest of extraction, so a failure mid-way rolls the whole scrape back. */
async function replaceScenePresence(session: DbSession, userId: string, sceneId: string, characterIds: string[]): Promise<void> {
  await session.query('delete from scene_presence where scene_id = $1', [sceneId]);
  for (const characterId of characterIds) {
    await session.query(
      `insert into scene_presence (scene_id, character_id, user_id) values ($1, $2, $3)
       on conflict (scene_id, character_id) do nothing`,
      [sceneId, characterId, userId],
    );
  }
}
