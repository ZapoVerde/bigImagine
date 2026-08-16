/**
 * @file orchestrator/src/orchestrator/locationAndPresenceScraper.ts
 * @stamp 2026-08-13
 * @architectural-role Orchestrator — Stage 2 of the post-turn pipeline (segway.md §4), with the
 *   pure parsing split out per bi_principles.md §8
 * @description
 * docs/plans/vistalyze_integration/segway.md §4: the post-cleanup heuristic scraper. Stage 1 (the async
 * cleanup subloop, orchestrator/cleanupLoop.ts) may rewrite a turn's text
 * to open with the two-line header block defined in docs/plans/vistalyze_integration/cleanup_prompt.md
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
 * `status = 'transient'`, linked to the owning chat via `location_chat_links`/
 * `character_chat_links` (db/migrations/0096) with `anchor_swipe_id` on the link row, so
 * orchestrator/chatMemorySync.ts's existing sync tick can promote it to `permanent` (settled,
 * still this chat's — `status` is a sync-progress marker only, never a cross-chat visibility
 * signal) when the turn exits the live window or demote it to `inactive` (never delete) when an
 * alternate swipe wins instead — and io/chatSessions.ts's forkChat can link it onto a forked
 * branch. All lookups here are filtered to eligible rows only (linked to *this* chat and not
 * `inactive`, or — user-authored — `status is null`), so a name match can never resurrect a
 * different chat's same-named row, and a row with no chat link left cascades away on its own
 * (the link table's cleanup trigger).
 *
 * Fail-open (segway.md §1): this module never throws. A missing header, a missing swipe anchor,
 * or any DB failure logs and returns, leaving the turn untouched. Both call sites
 * (server/httpServer.ts's handleChatCompletions and regenerateSwipe) rely on that contract.
 *
 * @api-declaration
 * parseStoryHeader(text) -> StoryHeader | null — pure; the two-line header parse, no IO
 * splitLocationName(name) -> { parent, sub } — pure; the " - " parent/sub split (location.md §3.1)
 * scrapeTurnPresence(deps, userId, chatId, messageId, text, mode) -> Promise<{ locationId: string; characterIds: string[] } | undefined> —
 *   fail-open; parse, anchor the turn's active swipe, then extract location/scene/characters/
 *   presence, returning the resolved location id and the resolved `Present:` roster's character
 *   ids (the async image-gen trigger's target and the cast-description fan-out's targets). mode is
 *   'extend' for a genuinely new turn (a location change advances chat_sessions.previous_scene_id)
 *   or 'replace' for a swipe regeneration (the replaced turn's location must NOT become the
 *   previous one — the revert target stays the last settled location, endpoint.md §5.1.8)
 * loadLocationBlock(deps, userId, chatId) -> Promise<LocationBlockResult> — fail-open; the
 *   known-locations <locations> block (location.md §5.2), shared by the 'location' marker slot
 *   and the {{known_locations}} header-repair token
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
import type { OrchestratorSettingsStore } from '../io/orchestratorSettings.js';
import { renderLocationBlock, type LocationBlockLists } from '../util/renderLocationBlock.js';

/** The two-line header block (docs/plans/vistalyze_integration/cleanup_prompt.md §2.4), parsed. */
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

/**
 * Pure split of a header location string into parent/place + sub/location — Triggeryze's parent
 * rule (location-tracker.json's Extract parent location): everything before the FIRST " - " is
 * the parent; the sub keeps the FULL string as its name (location.md §3.1 — locations.name stays
 * verbatim so every exact-name seam keeps working). No separator, a leading separator, or an
 * empty parent after trim => standalone (the whole name is its own parent).
 *   "The Tavern - Kitchen"            → { parent: "The Tavern", sub: "The Tavern - Kitchen" }
 *   "The Tavern - Kitchen - Cellar"   → { parent: "The Tavern", sub: "The Tavern - Kitchen - Cellar" }
 *   "The Smoking Pipe"                → { parent: "The Smoking Pipe", sub: null }
 */
export function splitLocationName(name: string): { parent: string; sub: string | null } {
  const idx = name.indexOf(' - ');
  if (idx <= 0) return { parent: name, sub: null };
  const parent = name.slice(0, idx).trim();
  if (parent === '' || parent === name) return { parent: name, sub: null };
  return { parent, sub: name };
}

/** The scraper's narrow dependency surface. ensureActiveSwipe lives in chatSessions.ts (the
 *  single owner of chat_message_swipes writes, per bi_principles.md §8) and is injected rather
 *  than re-implemented here. settings supplies the location_split_enabled switch (location.md
 *  §2.4) — read live, no restart, same as every other household setting. */
export interface TurnPresenceScrapeDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
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
 * Returns the resolved location id (segway.md §4.2) and the resolved `Present:` roster's
 * character ids when extraction succeeded — server/httpServer.ts uses the location id to fire
 * the async location-image generation pass (endpoint.md §5, decoupled, never awaited inline)
 * and the character ids to fan out the fire-and-forget character describer
 * (describeCharacter.ts, A2 of rp-cast-infrastructure-plan.md). undefined when extraction was
 * skipped or failed.
 */
export async function scrapeTurnPresence(
  deps: TurnPresenceScrapeDeps,
  userId: string,
  chatId: string,
  messageId: string,
  text: string,
  mode: 'extend' | 'replace' = 'extend',
): Promise<{ locationId: string; characterIds: string[] } | undefined> {
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
    // The parent/sub split switch (location.md §2.4), read live per scrape. Off = today's flat
    // behavior: the full header string resolves-or-creates one row with no parent link.
    const splitEnabled = (await deps.settings.get('location_split_enabled')) !== 'false';
    return await deps.db.withUserScope(userId, (session) =>
      extractFromHeader(session, userId, chatId, swipeId, header, mode, splitEnabled),
    );
  } catch (err) {
    // bi_principles.md §11: log the seam — a silent failure here would quietly lose trusted
    // scene state, but it must never take the turn down with it.
    log.error('post-cleanup scraper: extraction failed, skipping (fail-open)', { chatId, messageId, err });
    return undefined;
  }
}

/** db/migrations/0096's chat-scoping eligibility predicate, shared by the location and character
 *  lookups below. A row is eligible iff it is user-authored (status null — always cross-chat
 *  visible, never linked at all) OR it is linked to *this* chat and not demoted to inactive.
 *  status no longer carries any cross-chat meaning (transient vs. permanent is purely "still in
 *  the live editing window" vs. "settled through the sync tick") — only the link table decides
 *  which chat(s) a row belongs to.
 *
 *  Parametric on the chat_id placeholder and the id column/link table (locations vs. characters):
 *  every call site's params array puts chat_id at a different position, and a hardcoded position
 *  previously caused one caller (loadLocationBlock's parentRows query) to bind a param that
 *  appeared nowhere in its own SQL text — Postgres can't infer a type for a placeholder that's
 *  never referenced, which raised 42P18 ("could not determine data type of parameter"). Naming
 *  the placeholder here makes each call site's params array the only source of truth for its own
 *  parameter count. idColumn/linkTable are left unqualified against the outer query's single
 *  locations/characters table — every call site here either queries that table alone or joins it
 *  under a name no other joined table shares, so no aliasing is needed. */
const eligibleClause = (idColumn: 'location_id' | 'character_id', linkTable: 'location_chat_links' | 'character_chat_links', chatIdPlaceholder: string) => `(
  status is null
  or (status <> 'inactive' and exists (
    select 1 from ${linkTable} where ${idColumn} = ${linkTable}.${idColumn} and ${linkTable}.chat_id = ${chatIdPlaceholder}
  ))
)`;

async function extractFromHeader(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  header: StoryHeader,
  mode: 'extend' | 'replace',
  splitEnabled: boolean,
): Promise<{ locationId: string; characterIds: string[] }> {
  const locationId = await resolveLocation(session, userId, chatId, swipeId, header, splitEnabled);
  const sceneId = await resolveScene(session, userId, chatId, locationId, mode);
  const characterIds = await resolvePresentCharacters(session, userId, chatId, swipeId, header.present);
  await replaceScenePresence(session, userId, sceneId, characterIds);
  log.info('post-cleanup scraper: extracted turn scene state', {
    chatId,
    locationId,
    sceneId,
    present: characterIds.length,
  });
  return { locationId, characterIds };
}

/** segway.md §4.2 + location.md §3.2: resolve-or-create the location, parent first. The header
 *  string is split (location.md §3.1): when it names a sub ("The Tavern - Kitchen"), the parent
 *  row ("The Tavern") is resolved-or-created first — via the same resolveOrCreateLocationRow
 *  path as everything else (bi_principles.md §8: one code path) — and the sub row is minted with
 *  parent_location_id pointing at it. Both rows are transient on this turn's swipe, so the sync
 *  tick promotes/demotes them together and a swipe replace demotes both (location.md §2.2).
 *  Fail-open: a parent-row failure degrades to the sub minted standalone — never drop the turn's
 *  location over a grouping row. When the split is disabled (location_split_enabled = 'false')
 *  the header string resolves flat, exactly as before the tracker. */
async function resolveLocation(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  header: StoryHeader,
  splitEnabled: boolean,
): Promise<string> {
  const environment = JSON.stringify({ time_of_day: header.timeOfDay, date: header.dateLine });
  const { parent, sub } = splitLocationName(header.location);
  let parentLocationId: string | null = null;
  if (splitEnabled && sub) {
    try {
      parentLocationId = await resolveOrCreateLocationRow(session, userId, chatId, swipeId, parent, environment, null, splitEnabled);
    } catch (err) {
      log.warn('post-cleanup scraper: parent location resolve failed, minting sub standalone (fail-open)', { chatId, parent, err });
    }
  }
  return resolveOrCreateLocationRow(session, userId, chatId, swipeId, header.location, environment, parentLocationId, splitEnabled);
}

/** The resolve-or-create core shared by sub and parent rows (segway.md §4.2). A matched row's
 *  environment is refreshed (jsonb merge, so any richer weather/mood a future Vistalyze pass
 *  wrote survives); a new row is transient, anchored to this turn's swipe, with visual_description
 *  seeded from the extracted name and environment from the extracted time/date. A matched
 *  *transient* row is re-anchored to this turn's swipe too — continued use of the same place
 *  across turns is the active-timeline signal, so the row must follow the current turn's swipe,
 *  not stay pinned to the turn that first created it (which the sync tick may otherwise demote as
 *  an alternate timeline even though the live story still stands in it). Permanent/user-authored
 *  rows keep their identity untouched.
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
async function resolveOrCreateLocationRow(
  session: DbSession,
  userId: string,
  chatId: string,
  swipeId: string,
  name: string,
  environment: string,
  parentLocationId: string | null,
  splitEnabled: boolean,
): Promise<string> {
  const matched = await session.query<{ location_id: string; status: string | null; parent_location_id: string | null }>(
    `select location_id, status, parent_location_id from locations
     where user_id = $1 and name = $2 and ${eligibleClause('location_id', 'location_chat_links', '$3')}
     order by (status is null) desc, (status = 'permanent') desc, location_id`,
    [userId, name, chatId],
  );
  if (matched[0]) {
    // Backfill the parent link when the split is enabled and this row predates it (minted while
    // the split was off -> parent_location_id null): without this the row would show up in BOTH
    // the parents and subs lists of the <locations> block (name-like fallback) and read
    // parentName: null in the admin roster. Same resolve-or-create path as the mint; fail-open
    // to leaving the row standalone. coalesce keeps an existing link untouched.
    let effectiveParentId = parentLocationId;
    if (splitEnabled && !effectiveParentId) {
      const { parent, sub } = splitLocationName(name);
      if (sub) {
        try {
          effectiveParentId = await resolveOrCreateLocationRow(session, userId, chatId, swipeId, parent, environment, null, splitEnabled);
        } catch (err) {
          log.warn('post-cleanup scraper: parent link backfill failed, row stays standalone (fail-open)', { chatId, parent, err });
        }
      }
    }
    // Re-anchor a transient match's link to the turn that's using it now (see the doc above);
    // leave permanent/user-authored rows alone. The match is always linked to this exact chat_id
    // already (that's what made it eligible above), so this always affects exactly one link row.
    if (matched[0].status === 'transient') {
      await session.query('update location_chat_links set anchor_swipe_id = $1 where location_id = $2 and chat_id = $3', [
        swipeId,
        matched[0].location_id,
        chatId,
      ]);
    }
    await session.query(
      `update locations set environment = environment || $3::jsonb, parent_location_id = coalesce(parent_location_id, $4), updated_at = now()
       where location_id = $1 and user_id = $2`,
      [matched[0].location_id, userId, environment, effectiveParentId],
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
    `select l.image_url, l.image_rendered_input, l.image_render_hash, l.seed, l.visual_description, l.definition
     from locations l
     join location_chat_links lcl on lcl.location_id = l.location_id and lcl.chat_id = $3
     where l.user_id = $1 and l.name = $2 and l.image_url is not null
     order by l.image_generated_at desc nulls last
     limit 1`,
    [userId, name, chatId],
  );
  // The minted description: the prior row's real description when it has one (non-empty and not
  // just the name), else the name-seed this mint would otherwise write — a genuinely new place
  // still seeds from its name and the describer enriches it after.
  const carriedDescription =
    prior?.visual_description && prior.visual_description.trim() !== '' && prior.visual_description !== name
      ? prior.visual_description
      : name;

  const [created] = await session.query<{ location_id: string }>(
    `insert into locations (user_id, name, visual_description, definition, environment, seed, image_url, image_rendered_input, image_render_hash, status, parent_location_id)
     values ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::jsonb, $9, 'transient', $10)
     returning location_id`,
    [
      userId,
      name,
      carriedDescription,
      prior?.definition ?? null,
      environment,
      toImageGenSeed(prior?.seed),
      prior?.image_url ?? null,
      prior?.image_rendered_input ?? null,
      prior?.image_render_hash ?? null,
      parentLocationId,
    ],
  );
  await session.query('insert into location_chat_links (location_id, chat_id, anchor_swipe_id) values ($1, $2, $3)', [
    created!.location_id,
    chatId,
    swipeId,
  ]);
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
 *  Anything else becomes a placeholder identity — transient, anchored to this turn — but carrying
 *  the most recent same-named prior row's real `persona`/`avatar_path` forward when one exists
 *  (A1 of rp-cast-infrastructure-plan.md: the same-phase parity location parity as
 *  resolveOrCreateLocationRow's same-place carry — a character who appeared before, anywhere,
 *  gets their real persona back instead of a blank stub). The carry is deliberately not
 *  chat-scoped (any prior row, any status): a persona is identity, not timeline state. */
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
       where user_id = $1 and name = $2 and ${eligibleClause('character_id', 'character_chat_links', '$3')}
       order by (status is null) desc, (status = 'permanent') desc, character_id`,
      [userId, name, chatId],
    );
    if (matched[0]) {
      characterIds.push(matched[0].character_id);
      if (matched[0].status === 'transient') {
        // The match is always linked to this exact chat_id already (that's what made it
        // eligible above), so this always affects exactly one link row.
        await session.query('update character_chat_links set anchor_swipe_id = $1 where character_id = $2 and chat_id = $3', [
          swipeId,
          matched[0].character_id,
          chatId,
        ]);
      }
      continue;
    }
    // A1 carry-forward: the most recent same-named row with a real persona (any status, any
    // chat — a persona is identity, not timeline state). The describer's skip rule
    // (describeCharacter.ts) sees a carried persona as "already described" — no duplicate LLM
    // call for a character who was fleshed out before.
    const [prior] = await session.query<{ persona: string; avatar_path: string | null }>(
      `select persona, avatar_path from characters
       where user_id = $1 and name = $2 and persona <> ''
       order by created_at desc, character_id
       limit 1`,
      [userId, name],
    );
    const [created] = await session.query<{ character_id: string }>(
      `insert into characters (user_id, name, persona, avatar_path, status)
       values ($1, $2, $3, $4, 'transient') returning character_id`,
      [userId, name, prior?.persona ?? '', prior?.avatar_path ?? null],
    );
    await session.query('insert into character_chat_links (character_id, chat_id, anchor_swipe_id) values ($1, $2, $3)', [
      created!.character_id,
      chatId,
      swipeId,
    ]);
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
  // presence_order (0107) preserves the Present: roster's left-to-right order through storage:
  // characterIds arrives here already ordered by resolvePresentCharacters' for-of over the
  // Present: names, so each character's index in it is the order getScenesTool.ts must read
  // back out (studio-character-bridge-plan.md Part E).
  for (let i = 0; i < characterIds.length; i++) {
    await session.query(
      `insert into scene_presence (scene_id, character_id, user_id, presence_order) values ($1, $2, $3, $4)
       on conflict (scene_id, character_id) do nothing`,
      [sceneId, characterIds[i], userId, i],
    );
  }
}

// ---------------------------------------------------------------------------
// The known-locations block (location.md §5) — shared by the 'location' marker slot
// (httpServer.ts's buildNarratorStackItems) and the {{known_locations}} header-repair token
// (cleanupHeuristics.ts's buildRepairPrompt, loaded by the async callers)
// ---------------------------------------------------------------------------

export interface LocationBlockDeps {
  db: PostgresClient;
  settings: OrchestratorSettingsStore;
}

/** The rendered block plus the current parent (for the block's sub-section header). */
export interface LocationBlockResult {
  /** The fully rendered <locations> block, or '' when disabled / no eligible locations / error. */
  block: string;
  /** The split parent of the current scene's active location, or null. */
  currentParent: string | null;
}

/** location.md §5.2 — the shared loader both injection seams use. Fail-open (location.md §1.3):
 *  any error, missing scene, or empty list returns { block: '', currentParent: null } — the
 *  caller's empty-block rule then emits nothing, and a turn is never blocked over context.
 *
 *  Lists are eligibility-filtered (eligibleClause, scoped to this chat's location_chat_links)
 *  so an inactive/alternate-timeline row never pollutes the block.
 *  Parents = eligible rows with parent_location_id null (parent rows AND standalone locations)
 *  plus the current parent by derivation when its row is missing/ineligible — the current parent
 *  must always be listed; it is the block's anchor. Subs = eligible rows of the current parent
 *  by parent_location_id, with a name-prefix fallback so rows minted while the split was
 *  disabled still group. */
export async function loadLocationBlock(
  deps: LocationBlockDeps,
  userId: string,
  chatId: string,
): Promise<LocationBlockResult> {
  try {
    if ((await deps.settings.get('location_injection_enabled')) === 'false') {
      return { block: '', currentParent: null };
    }
    const template = await deps.settings.get('location_injection_prompt');
    return await deps.db.withUserScope(userId, async (session) => {
      // The current scene's active location via the chat_sessions.scene_id cache pointer
      // (segway.md §2.2), eligibility-filtered like every model-facing read (a stale pointer
      // reads absent, and the block then degrades to parents-only).
      const [sceneRow] = await session.query<{ location_id: string; name: string }>(
        `select l.location_id, l.name
         from chat_sessions cs
         join scenes s on s.scene_id = cs.scene_id
         join locations l on l.location_id = s.active_location_id and l.user_id = $1
         where cs.chat_id = $2
           and ${eligibleClause('location_id', 'location_chat_links', '$3')}
         limit 1`,
        [userId, chatId, chatId],
      );
      const currentName = sceneRow?.name ?? null;
      const currentParent = currentName ? splitLocationName(currentName).parent : null;

      // The parent row for the subs query (by name — the current location row is the sub when a
      // room is named; the parent is a separate row).
      let parentRowId: string | null = null;
      if (currentParent) {
        const [parentRow] = await session.query<{ location_id: string }>(
          'select location_id from locations where user_id = $1 and name = $2 limit 1',
          [userId, currentParent],
        );
        parentRowId = parentRow?.location_id ?? null;
      }

      const [parentRows, subRows] = await Promise.all([
        session.query<{ name: string }>(
          `select name from locations
           where user_id = $1 and parent_location_id is null
             and ${eligibleClause('location_id', 'location_chat_links', '$2')}
           order by name`,
          [userId, chatId],
        ),
        currentParent
          ? session.query<{ name: string }>(
              `select name from locations
               where user_id = $1
                 and (parent_location_id = $2 or name like $4)
                 and ${eligibleClause('location_id', 'location_chat_links', '$3')}
               order by name`,
              [userId, parentRowId, chatId, `${currentParent} - %`],
            )
          : Promise.resolve([]),
      ]);

      const parents = [...new Set([...parentRows.map((r) => r.name), ...(currentParent && !parentRows.some((r) => r.name === currentParent) ? [currentParent] : [])])];
      const subs = [...new Set(subRows.map((r) => r.name))];
      const block = renderLocationBlock(template, { parents, subs, currentParent } satisfies LocationBlockLists);
      return { block, currentParent };
    });
  } catch (err) {
    // Fail-open: the block is context, never a gate (location.md §1.3, bi_principles.md §11).
    log.warn('loadLocationBlock: failed, emitting no block (fail-open)', { chatId, err });
    return { block: '', currentParent: null };
  }
}
