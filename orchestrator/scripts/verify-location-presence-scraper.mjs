// Proves the post-cleanup heuristic scraper (docs/vistalyze_integration/segway.md §4) against a
// fake Postgres pool — no server, no network, no LLM. The suite exercises:
//   - parseStoryHeader (pure): the two-line header block parses with/without the emoji prefixes,
//     leading blank lines are tolerated, a non-matching line 1 (or a missing Present: line)
//     returns null — the fail-open "skip extraction entirely" gate of §4.1;
//   - scrapeTurnPresence's happy path (§4.2/§4.4): location resolve-or-create, scene
//     resolve-or-create keyed by (chat_id, active_location_id) with chat_sessions.scene_id
//     stamped, Present-roster resolve-or-auto-register, scene_presence replaced;
//   - the §2.6 eligibility filter: a transient row anchored to a swipe outside this chat's active
//     path must NOT be matched (that would resurrect a different timeline's same-named row);
//   - the fail-open contract (§1): a DB failure, a missing anchor, or a missing header all
//     resolve without throwing and without touching the DB.

import { randomUUID } from 'node:crypto';
import { createPostgresClient } from '../dist/io/postgres.js';
import { parseStoryHeader, scrapeTurnPresence } from '../dist/orchestrator/locationAndPresenceScraper.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

// --- Fake pool: in-memory locations / characters / scenes / scene_presence / chat_messages,
// covering exactly the queries locationAndPresenceScraper.ts issues. ---
function createFakePool() {
  const locations = []; // { location_id, user_id, name, visual_description, environment, status, anchor_chat_id, anchor_swipe_id }
  const characters = []; // { character_id, user_id, name, status, anchor_chat_id, anchor_swipe_id }
  const scenes = []; // { scene_id, user_id, name, chat_id, active_location_id, last_active_at }
  const presence = []; // { scene_id, character_id, user_id }
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, active_swipe_id }
  const chatSessions = new Map(); // chat_id -> { scene_id }
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  return {
    locations,
    characters,
    scenes,
    presence,
    chatMessages,
    chatSessions,
    now,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // §4.2.5 same-place carry: the mint-path clone-source read — the most recent
          // same-named row rendered in THIS chat (anchor_chat_id-scoped so another chat's row
          // of the same name never leaks in).
          if (sql.includes('from locations') && sql.includes('image_url is not null')) {
            const [userId, name, chatId] = params;
            const matches = locations
              .filter(
                (l) =>
                  l.user_id === userId &&
                  l.name === name &&
                  l.anchor_chat_id === chatId &&
                  l.image_url !== null &&
                  l.image_url !== undefined,
              )
              .sort((a, b) => String(b.image_generated_at ?? '').localeCompare(String(a.image_generated_at ?? '')));
            return {
              rows: matches.length
                ? [
                    {
                      image_url: matches[0].image_url,
                      image_rendered_input: matches[0].image_rendered_input ?? null,
                      image_render_hash: matches[0].image_render_hash ?? null,
                      seed: matches[0].seed ?? null,
                      visual_description: matches[0].visual_description ?? null,
                      definition: matches[0].definition ?? null,
                    },
                  ]
                : [],
            };
          }

          // §4.2 location lookup (eligible rows only) / update / create. The eligibility
          // subquery embeds `select active_swipe_id from chat_messages …` inside the outer
          // `select … from locations … where user_id = $1 and name = $2`, so the matchers are
          // anchored to the outer table + the `and name =` predicate, never a bare includes().
          if (sql.includes('from locations') && sql.includes('and name =')) {
            const [userId, name, chatId] = params;
            const activeSwipeIds = new Set(
              chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id),
            );
            const row = locations.find(
              (l) =>
                l.user_id === userId &&
                l.name === name &&
                (l.status === 'permanent' ||
                  (l.status === 'transient' && activeSwipeIds.has(l.anchor_swipe_id))),
            );
            return { rows: row ? [{ location_id: row.location_id, status: row.status }] : [] };
          }
          if (sql.includes('update locations set environment')) {
            const [locationId, userId, environmentJson] = params;
            const row = locations.find((l) => l.location_id === locationId && l.user_id === userId);
            if (row) {
              row.environment = { ...row.environment, ...JSON.parse(environmentJson) };
              // re-anchor: a matched transient row follows the turn that's using it now. The
              // transient branch carries the swipe as param 4; both branches may carry a
              // backfilled parent link as the last param (SQL uses coalesce, so a null link
              // never clobbers — mirrored here by only writing strings).
              if (row.status === 'transient' && typeof params[3] === 'string') row.anchor_swipe_id = params[3];
              const last = params[params.length - 1];
              if (typeof last === 'string') row.parent_location_id = last;
            }
            return { rows: [] };
          }
          if (sql.startsWith('insert into locations')) {
            const [userId, name, visualDescription, definition, environmentJson, seed, imageUrl, renderedInput, renderHash, chatId, swipeId, parentLocationId] = params;
            const row = {
              location_id: randomUUID(),
              user_id: userId,
              name,
              visual_description: visualDescription,
              definition,
              environment: JSON.parse(environmentJson),
              seed,
              image_url: imageUrl,
              image_rendered_input: renderedInput,
              image_render_hash: renderHash,
              status: 'transient',
              anchor_chat_id: chatId,
              anchor_swipe_id: swipeId,
              parent_location_id: parentLocationId ?? null,
            };
            locations.push(row);
            return { rows: [{ location_id: row.location_id }] };
          }

          // §4.2.4 scene resolve-or-create + name read + stamp.
          if (sql.includes('from scenes where chat_id') && sql.includes('active_location_id')) {
            const [chatId, locationId, userId] = params;
            const row = scenes.find((s) => s.chat_id === chatId && s.active_location_id === locationId && s.user_id === userId);
            return { rows: row ? [{ scene_id: row.scene_id }] : [] };
          }
          if (sql.startsWith('update scenes set last_active_at')) {
            const row = scenes.find((s) => s.scene_id === params[0]);
            if (row) row.last_active_at = now();
            return { rows: [] };
          }
          if (sql.includes('select name from locations where location_id')) {
            const row = locations.find((l) => l.location_id === params[0] && l.user_id === params[1]);
            return { rows: row ? [{ name: row.name }] : [] };
          }
          if (sql.startsWith('insert into scenes')) {
            const [userId, name, chatId, locationId] = params;
            const row = { scene_id: randomUUID(), user_id: userId, name, chat_id: chatId, active_location_id: locationId, last_active_at: now() };
            scenes.push(row);
            return { rows: [{ scene_id: row.scene_id }] };
          }
          // resolveScene's chat-state read (endpoint.md §5.1.8): the current scene pointer
          // before the stamp — the extend-mode stamp advances previous_scene_id from it.
          if (sql.startsWith('select scene_id from chat_sessions where chat_id')) {
            return { rows: [chatSessions.get(params[0]) ?? { scene_id: null }] };
          }
          if (sql.startsWith('update chat_sessions set scene_id')) {
            // extend mode (3 params: sceneId, previousSceneId, chatId) vs. replace/reuse
            // (2 params: sceneId, chatId).
            const isExtend = params.length === 3;
            const [sceneId, second, third] = params;
            const chatId = isExtend ? third : second;
            const row = chatSessions.get(chatId) ?? { scene_id: null };
            if (isExtend && row.scene_id !== sceneId) row.previous_scene_id = row.scene_id;
            row.scene_id = sceneId;
            chatSessions.set(chatId, row);
            return { rows: [] };
          }

          // §4.4 character lookup (eligible rows only) / auto-register.
          if (sql.includes('from characters') && sql.includes('and name =')) {
            const [userId, name, chatId] = params;
            const activeSwipeIds = new Set(
              chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id),
            );
            const row = characters.find(
              (c) =>
                c.user_id === userId &&
                c.name === name &&
                (c.status === null ||
                  c.status === 'permanent' ||
                  (c.status === 'transient' && activeSwipeIds.has(c.anchor_swipe_id))),
            );
            return { rows: row ? [{ character_id: row.character_id, status: row.status }] : [] };
          }
          if (sql.startsWith('update characters set anchor_swipe_id')) {
            const [characterId, anchorSwipeId] = params;
            const row = characters.find((c) => c.character_id === characterId);
            if (row && row.status === 'transient') row.anchor_swipe_id = anchorSwipeId;
            return { rows: [] };
          }
          if (sql.startsWith('insert into characters')) {
            const [userId, name, chatId, swipeId] = params;
            const row = { character_id: randomUUID(), user_id: userId, name, status: 'transient', anchor_chat_id: chatId, anchor_swipe_id: swipeId };
            characters.push(row);
            return { rows: [{ character_id: row.character_id }] };
          }

          // §4.4.3 scene_presence replace.
          if (sql.startsWith('delete from scene_presence')) {
            for (let i = presence.length - 1; i >= 0; i--) {
              if (presence[i].scene_id === params[0]) presence.splice(i, 1);
            }
            return { rows: [] };
          }
          if (sql.startsWith('insert into scene_presence')) {
            const [sceneId, characterId, userId] = params;
            if (!presence.some((p) => p.scene_id === sceneId && p.character_id === characterId)) {
              presence.push({ scene_id: sceneId, character_id: characterId, user_id: userId });
            }
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const USER = '11111111-1111-1111-1111-111111111111';
const CHAT = '22222222-2222-2222-2222-222222222222';
const MSG = '33333333-3333-3333-3333-333333333333';
const SWIPE = '44444444-4444-4444-4444-444444444444';

function poolWithActiveSwipe(pool) {
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: SWIPE });
  pool.chatSessions.set(CHAT, { scene_id: null });
  return pool;
}

// ensureActiveSwipe mirrors chatSessions.ts's contract: return the message's active swipe, or
// create one and return it. Records calls so the anchor is assertable.
function fakeEnsureActiveSwipe(pool) {
  const calls = [];
  return {
    calls,
    async fn(userId, chatId, messageId) {
      calls.push({ userId, chatId, messageId });
      const msg = pool.chatMessages.find((m) => m.message_id === messageId && m.chat_id === chatId);
      if (!msg) return undefined;
      if (msg.active_swipe_id) return msg.active_swipe_id;
      msg.active_swipe_id = randomUUID();
      return msg.active_swipe_id;
    },
  };
}

const HEADER = `[ Late Evening | 🗓️ Wednesday, June 15, 2026 AD | 📍 The Drunken Kraken - Main Hall ]
Present: Mair, Seraphina, Mair`;

// --- parseStoryHeader: pure parse cases --------------------------------------------------------
{
  const parsed = parseStoryHeader(HEADER);
  assert(parsed !== null, 'the two-line header block parses');
  assert(parsed.location === 'The Drunken Kraken - Main Hall', 'the location field is captured');
  assert(parsed.timeOfDay === 'Late Evening', 'the time-of-day field is captured');
  assert(parsed.dateLine === 'Wednesday, June 15, 2026 AD', 'the date/era field is captured');
  assert(parsed.present.length === 2 && parsed.present[0] === 'Mair' && parsed.present[1] === 'Seraphina', 'Present is split, trimmed, and de-duplicated');
}

{
  const parsed = parseStoryHeader(`[ Morning | Thursday, July 1, 2026 AD | Deck 6 ]\nPresent: Mair`);
  assert(parsed !== null && parsed.location === 'Deck 6' && parsed.present.length === 1, 'the header parses without the emoji prefixes');
}

{
  const parsed = parseStoryHeader('\n\n[ Morning | Thursday, July 1, 2026 AD | Deck 6 ]\nPresent: Mair\n\nShe turned around.');
  assert(parsed !== null && parsed.location === 'Deck 6', 'leading blank lines are tolerated before the header');
}

{
  assert(parseStoryHeader('She met his gaze and refused to flinch.') === null, 'a headerless turn returns null — extraction is skipped entirely');
  assert(parseStoryHeader('[ Morning | Thursday, July 1, 2026 AD | Deck 6 ]') === null, 'a header without a Present: line returns null — no partial parse');
  assert(parseStoryHeader('[ Morning | Thursday, July 1, 2026 AD | Deck 6 ]\nPresent:') !== null, 'an empty Present: roster is authoritative (presence replaced with nothing)');
}

// location_split_enabled (location.md §2.4), read live per scrape. This suite keeps exercising
// the FLAT (downgrade) path — off — so its original row-count/presence assertions hold
// unchanged; the split (parent/sub) path is covered by verify-location-tracker.mjs.
const FAKE_SETTINGS = { get: async () => 'false' };

// --- scrapeTurnPresence: happy path, first visit -------------------------------------------------
{
  const pool = poolWithActiveSwipe(createFakePool());
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 1, 'a new location row is created');
  assert(
    pool.locations[0].status === 'transient' &&
      pool.locations[0].anchor_chat_id === CHAT &&
      pool.locations[0].anchor_swipe_id === SWIPE,
    'the created location is transient, anchored to this turn\'s active swipe',
  );
  assert(pool.locations[0].visual_description === 'The Drunken Kraken - Main Hall', 'visual_description is seeded from the extracted name (§4.2.3)');
  assert(pool.locations[0].environment.time_of_day === 'Late Evening', 'environment is seeded from the extracted time/date');
  assert(pool.locations[0].seed === 12345, 'a newly minted location carries the shared fixed image-gen seed');

  assert(pool.scenes.length === 1 && pool.scenes[0].chat_id === CHAT && pool.scenes[0].active_location_id === pool.locations[0].location_id, 'a scene keyed by (chat_id, active_location_id) is created');
  assert(pool.chatSessions.get(CHAT).scene_id === pool.scenes[0].scene_id, 'chat_sessions.scene_id is stamped with the resolved scene (§2.2 cache pointer)');

  assert(pool.characters.length === 2, 'two characters are auto-registered from Present: (Mair de-duplicated)');
  assert(pool.characters.every((c) => c.status === 'transient' && c.anchor_chat_id === CHAT && c.anchor_swipe_id === SWIPE), 'auto-registered characters are transient and anchored');
  assert(pool.presence.length === 2, 'scene_presence holds exactly the resolved roster');

  assert(ensure.calls.length === 1 && ensure.calls[0].messageId === MSG, 'the turn\'s message is the swipe anchor');
}

// --- scrapeTurnPresence: revisit reuses eligible rows ---------------------------------------------
{
  const pool = poolWithActiveSwipe(createFakePool());
  const tavern = {
    location_id: 'aaaaaaaa-0000-0000-0000-000000000001',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'A dim, smoky tavern.',
    environment: { weather: 'clear' },
    status: 'permanent', // user-created (create_location writes permanent)
    anchor_chat_id: null,
    anchor_swipe_id: null,
  };
  const mair = {
    character_id: 'bbbbbbbb-0000-0000-0000-000000000002',
    user_id: USER,
    name: 'Mair',
    status: null, // user-authored character
    anchor_chat_id: null,
    anchor_swipe_id: null,
  };
  pool.locations.push(tavern);
  pool.characters.push(mair);
  pool.scenes.push({
    scene_id: 'cccccccc-0000-0000-0000-000000000003',
    user_id: USER,
    name: tavern.name,
    chat_id: CHAT,
    active_location_id: tavern.location_id,
    last_active_at: '2026-01-01T00:00:00.000Z',
  });
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 1 && pool.locations[0].environment.weather === 'clear', 'a permanent location is matched, not duplicated');
  assert(pool.locations[0].environment.time_of_day === 'Late Evening', 'a matched location\'s environment is refreshed from the header');
  assert(pool.scenes.length === 1, 'the existing (chat, location) scene is reused, not duplicated');
  assert(pool.characters.length === 2, 'the user-authored character is matched; only Seraphina is auto-registered');
  assert(
    pool.presence.some((p) => p.character_id === mair.character_id) && pool.presence.length === 2,
    'the matched user-authored character is in the replaced presence roster',
  );
}

// --- §2.6: a transient row anchored to a foreign/alternate swipe must NOT match -------------------
{
  const pool = poolWithActiveSwipe(createFakePool());
  pool.locations.push({
    location_id: 'dddddddd-0000-0000-0000-000000000004',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'alternate-timeline tavern',
    environment: {},
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: '99999999-9999-9999-9999-999999999999', // not on this chat's active path
  });
  const db = createPostgresClient(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: fakeEnsureActiveSwipe(pool).fn }, USER, CHAT, MSG, HEADER);
  assert(pool.locations.length === 2, 'an ineligible (inactive/alternate-swipe) location is not matched — a fresh transient row is created instead of resurrecting it');
}

// --- §4.2.5 same-place carry: a rerun-superseded row's rendered image is inherited -----------
// The rerun of the turn that anchored a row supersedes its swipe -> the row is ineligible on
// the next scrape of the same room. Without the carry this mints a blank row and re-renders a
// pixel-identical bg; with it the fresh row inherits image_url + render hash, so the follow-up
// generation pass is a §5.1.2 cache hit (zero provider cost, bg never changes for the room).
{
  const pool = poolWithActiveSwipe(createFakePool());
  pool.locations.push({
    location_id: 'eeeeeeee-0000-0000-0000-000000000005',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'The Drunken Kraken - Main Hall',
    environment: {},
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: '99999999-9999-9999-9999-999999999999', // superseded by a rerun — ineligible
    seed: 12345,
    image_url: 'https://cdn.example.com/kraken.png',
    image_rendered_input: { visual_description: 'The Drunken Kraken - Main Hall', environment: {}, seed: 12345 },
    image_render_hash: 'hash-kraken',
    image_generated_at: '2026-08-08T10:00:00.000Z',
  });
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 2, 'the superseded row is not matched — a fresh row is minted (timeline semantics unchanged)');
  const fresh = pool.locations.find((l) => l.location_id !== 'eeeeeeee-0000-0000-0000-000000000005');
  assert(fresh.image_url === 'https://cdn.example.com/kraken.png', 'the fresh row inherits the prior same-named row\'s image_url (§4.2.5 carry)');
  assert(fresh.image_render_hash === 'hash-kraken', 'the fresh row inherits the render hash — the follow-up generation pass is a §5.1.2 cache hit');
  assert(fresh.seed === 12345, 'the fresh row inherits the seed');
  assert(fresh.visual_description === 'The Drunken Kraken - Main Hall', 'visual_description is still seeded from the extracted name');
  assert(fresh.definition === null, 'a name-seeded prior carries no definition');
}

// --- §4.2.5 carry with a described prior: the description/definition ride along -------------
// Once the describer (describeLocation.ts) has enriched a row, the carried hash covers the
// *described* prompt — the fresh mint must carry the description too or the §5.1.2 cache check
// misses and the render fires a name-only prompt (worse image + wasted gen). The describer's own
// skip rule sees the carried description as "already described" — no second LLM call for the room.
{
  const pool = poolWithActiveSwipe(createFakePool());
  pool.locations.push({
    location_id: 'ffffffff-0000-0000-0000-000000000006',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.',
    definition: 'A rowdy dockside tavern and the crew\'s usual meeting spot.',
    environment: {},
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: '99999999-9999-9999-9999-999999999999', // superseded by a rerun — ineligible
    seed: 12345,
    image_url: 'https://cdn.example.com/kraken.png',
    image_rendered_input: { visual_description: 'A wide taproom with low oak beams…', environment: {}, seed: 12345 },
    image_render_hash: 'hash-kraken-described',
    image_generated_at: '2026-08-08T10:00:00.000Z',
  });
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  const fresh = pool.locations.find((l) => l.location_id !== 'ffffffff-0000-0000-0000-000000000006');
  assert(fresh.visual_description === 'A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.', 'a described prior\'s visual_description is carried onto the fresh row (hash-match keeps the §5.1.2 cache hit)');
  assert(fresh.definition === 'A rowdy dockside tavern and the crew\'s usual meeting spot.', 'a described prior\'s definition is carried onto the fresh row');
  assert(fresh.image_render_hash === 'hash-kraken-described', 'the carried description matches the carried hash — the render stays a cache hit');
}

// --- Re-anchor: a transient row reused by a later turn follows the live timeline's swipe -------
{
  const pool = createFakePool();
  // Two active turns: turn 5's swipe SA (still in the live window), and the current turn's
  // swipe SB. The transient "Tavern" row is anchored to SA — eligible, because SA is still on
  // this chat's active swipe path — but this scrape runs on SB, so the match must re-anchor it.
  const sa = randomUUID();
  const sb = randomUUID();
  pool.chatMessages.push({ message_id: 'msg-5', chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: sa });
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: sb });
  pool.chatSessions.set(CHAT, { scene_id: null });
  const tavern = {
    location_id: randomUUID(),
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'Smoky.',
    environment: {},
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: sa,
  };
  pool.locations.push(tavern);
  const mair = {
    character_id: randomUUID(),
    user_id: USER,
    name: 'Mair',
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: sa,
  };
  pool.characters.push(mair);

  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 1, 'the transient row is matched — no duplicate is created on reuse');
  assert(pool.locations[0].anchor_swipe_id === sb, 'the matched transient location is re-anchored to the turn that is using it now');
  assert(pool.characters.length === 2, 'the transient character is matched — only Seraphina is newly registered');
  assert(pool.characters[0].anchor_swipe_id === sb, 'the matched transient character is re-anchored to the current turn\'s swipe too');
  assert(pool.scenes.length === 1, 'one scene is resolved for the reused location');
}

// --- Parent-link backfill: a row minted while the split was OFF gets linked on the matched path ----
// (review 2026-08-10) Once location_split_enabled turns on, a pre-split sub row (parent_location_id
// null) must be backfilled on the next match — otherwise it shows in BOTH the parents and subs
// lists of the <locations> block (name-like fallback) and reads parentName: null in the admin
// roster. The parent row is resolved-or-created through the same path as the mint.
{
  const pool = createFakePool();
  const sb = randomUUID();
  pool.chatMessages.push({ message_id: 'msg-5', chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: 'swipe-old' });
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: sb });
  pool.chatSessions.set(CHAT, { scene_id: null });
  pool.locations.push({
    location_id: randomUUID(),
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'Smoky.',
    environment: {},
    status: 'transient',
    anchor_chat_id: CHAT,
    anchor_swipe_id: 'swipe-old',
    parent_location_id: null, // pre-split mint: no link
  });
  const settings = { get: async (k) => (k === 'location_split_enabled' ? 'true' : 'false') };
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 2, 'the pre-split sub is matched (no duplicate) and the parent row is backfilled into existence');
  const sub = pool.locations.find((l) => l.name === 'The Drunken Kraken - Main Hall');
  const parent = pool.locations.find((l) => l.name === 'The Drunken Kraken');
  assert(!!parent, 'the parent row name is the derived portion before the first " - "');
  assert(sub.parent_location_id === parent.location_id, 'the matched sub row is linked to the resolved-or-created parent row');
  assert(sub.anchor_swipe_id === sb, 'the matched transient sub is still re-anchored to the current turn\'s swipe');
}

// --- endpoint.md §5.1.8: previous_scene_id advances on extending turns, never on swipe regen ---
// The last-turn location state: an extending turn whose location changes makes the old scene the
// chat's previous_scene_id (the revert target for the chat background); a swipe regeneration
// ('replace' mode) never advances it, so the target survives a chain of swipes.
{
  const pool = createFakePool();
  const sb = randomUUID();
  pool.chatMessages.push({ message_id: 'msg-5', chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: 'swipe-tavern' });
  pool.chatMessages.push({ message_id: MSG, chat_id: CHAT, user_id: USER, role: 'assistant', content: 'x', active_swipe_id: sb });
  pool.chatSessions.set(CHAT, { scene_id: 'scene-tavern' });
  const tavern = {
    location_id: 'loc-tavern',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'Smoky.',
    environment: {},
    status: 'permanent',
    anchor_chat_id: null,
    anchor_swipe_id: null,
  };
  pool.locations.push(tavern);
  pool.scenes.push({
    scene_id: 'scene-tavern',
    user_id: USER,
    name: tavern.name,
    chat_id: CHAT,
    active_location_id: tavern.location_id,
    last_active_at: '2026-01-01T00:00:00.000Z',
  });

  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);

  // Extending turn: the story moves to a new location -> previous_scene_id = the old scene.
  const harborHeader = `[ Morning | Thursday, July 1, 2026 AD | The Harbor - Docks ]
Present: Seraphina`;
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, harborHeader, 'extend');
  const afterExtendSceneId = pool.chatSessions.get(CHAT).scene_id;
  assert(afterExtendSceneId !== 'scene-tavern' && pool.scenes.some((s) => s.scene_id === afterExtendSceneId), 'an extending turn stamps the new scene');
  assert(pool.chatSessions.get(CHAT).previous_scene_id === 'scene-tavern', 'an extending turn that changes location advances previous_scene_id to the old scene (endpoint.md §5.1.8)');

  // Replace (swipe regeneration): even a location change must not advance previous_scene_id —
  // the revert target stays the last settled location across a chain of swipes.
  const cliffsHeader = `[ Noon | Thursday, July 1, 2026 AD | The Cliffs - Lookout ]
Present: Seraphina`;
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, cliffsHeader, 'replace');
  const afterReplaceSceneId = pool.chatSessions.get(CHAT).scene_id;
  assert(afterReplaceSceneId !== afterExtendSceneId, 'a swipe regeneration still stamps the regenerated turn\'s scene');
  assert(pool.chatSessions.get(CHAT).previous_scene_id === 'scene-tavern', 'a swipe regeneration never advances previous_scene_id — the revert target survives the swipe chain (§5.1.8)');
}

// --- Fail-open 1: DB failure never throws --------------------------------------------------------
{
  const pool = poolWithActiveSwipe(createFakePool());
  const db = {
    async withUserScope() {
      throw new Error('db connection refused');
    },
  };
  const ensure = fakeEnsureActiveSwipe(pool);
  let threw = false;
  try {
    await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);
  } catch {
    threw = true;
  }
  assert(!threw, 'a DB failure during extraction is swallowed — the turn is never blocked (§1 fail-open)');
}

// --- Fail-open 2: no header -> no DB work at all --------------------------------------------------
{
  const pool = poolWithActiveSwipe(createFakePool());
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, 'She met his gaze and refused to flinch.');
  assert(pool.locations.length === 0 && pool.characters.length === 0 && pool.scenes.length === 0, 'a headerless turn writes nothing');
  assert(ensure.calls.length === 0, 'no swipe anchor is requested for a headerless turn');
}

// --- Fail-open 3: missing anchor -> skip -----------------------------------------------------------
{
  const pool = createFakePool(); // no chat message at all
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);
  assert(pool.locations.length === 0, 'a turn with no anchorable message writes nothing and does not crash');
}

if (process.exitCode) {
  console.error('\nlocation/presence scraper verification FAILED');
  process.exit(1);
}
console.log('\nlocation/presence scraper verification passed');
