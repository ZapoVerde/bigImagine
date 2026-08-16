// Proves the post-cleanup heuristic scraper (docs/vistalyze_integration/segway.md §4) against a
// fake Postgres pool — no server, no network, no LLM. The suite exercises:
//   - parseStoryHeader (pure): the two-line header block parses with/without the emoji prefixes,
//     leading blank lines are tolerated, a non-matching line 1 (or a missing Present: line)
//     returns null — the fail-open "skip extraction entirely" gate of §4.1;
//   - scrapeTurnPresence's happy path (§4.2/§4.4): location resolve-or-create, scene
//     resolve-or-create keyed by (chat_id, active_location_id) with chat_sessions.scene_id
//     stamped, Present-roster resolve-or-auto-register, scene_presence replaced;
//   - db/migrations/0096 chat-scoping: a row linked to a DIFFERENT chat is never matched (a
//     name match can't resurrect another chat's same-named row), and a demoted (`inactive`) row
//     is never matched regardless of linkage — segway.md §2.6's invariant, re-scoped off the link
//     table instead of the old per-swipe active-path check (the plan's explicit simplification:
//     within the SAME chat, a row stays eligible across a swipe regeneration until the sync tick
//     actually demotes it — see the "revisit across a swipe regen" case below);
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

// --- Fake pool: in-memory locations / characters / location_chat_links / character_chat_links /
// scenes / scene_presence / chat_messages, covering exactly the queries
// locationAndPresenceScraper.ts issues. ---
function createFakePool() {
  const locations = []; // { location_id, user_id, name, visual_description, definition, environment, seed, image_url, image_rendered_input, image_render_hash, image_generated_at, status, parent_location_id }
  const characters = []; // { character_id, user_id, name, status }
  const locationChatLinks = []; // { location_id, chat_id, anchor_swipe_id } (migration 0096)
  const characterChatLinks = []; // { character_id, chat_id, anchor_swipe_id } (migration 0096)
  const scenes = []; // { scene_id, user_id, name, chat_id, active_location_id, last_active_at }
  const presence = []; // { scene_id, character_id, user_id }
  const chatMessages = []; // { message_id, chat_id, user_id, role, content, active_swipe_id }
  const chatSessions = new Map(); // chat_id -> { scene_id }
  let clock = 1000;
  const now = () => new Date((clock += 1000)).toISOString();

  // db/migrations/0096's eligibility predicate: user-authored (status null) is always eligible;
  // an auto-registered row is eligible only when linked to this chat and not demoted.
  const eligibleLocation = (l, chatId) =>
    l.status === null || (l.status !== 'inactive' && locationChatLinks.some((link) => link.location_id === l.location_id && link.chat_id === chatId));
  const eligibleCharacter = (c, chatId) =>
    c.status === null || (c.status !== 'inactive' && characterChatLinks.some((link) => link.character_id === c.character_id && link.chat_id === chatId));

  return {
    locations,
    characters,
    locationChatLinks,
    characterChatLinks,
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
          // same-named row rendered in THIS chat (joined through location_chat_links, so another
          // chat's row of the same name never leaks in).
          if (sql.includes('from locations l') && sql.includes('image_url is not null')) {
            const [userId, name, chatId] = params;
            const linkedIds = new Set(locationChatLinks.filter((l) => l.chat_id === chatId).map((l) => l.location_id));
            const matches = locations
              .filter((l) => l.user_id === userId && l.name === name && l.image_url != null && linkedIds.has(l.location_id))
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

          // §4.2 location match (eligible rows only).
          if (sql.startsWith('select location_id, status, parent_location_id from locations')) {
            const [userId, name, chatId] = params;
            const eligible = locations.filter((l) => l.user_id === userId && l.name === name && eligibleLocation(l, chatId));
            eligible.sort((a, b) => {
              if ((a.status === null) !== (b.status === null)) return a.status === null ? -1 : 1;
              if ((a.status === 'permanent') !== (b.status === 'permanent')) return a.status === 'permanent' ? -1 : 1;
              return a.location_id.localeCompare(b.location_id);
            });
            const row = eligible[0];
            return { rows: row ? [{ location_id: row.location_id, status: row.status, parent_location_id: row.parent_location_id ?? null }] : [] };
          }
          // Re-anchor: a matched transient location's link follows the turn using it now.
          if (sql.startsWith('update location_chat_links set anchor_swipe_id')) {
            const [swipeId, locationId, chatId] = params;
            const link = locationChatLinks.find((l) => l.location_id === locationId && l.chat_id === chatId);
            if (link) link.anchor_swipe_id = swipeId;
            return { rows: [] };
          }
          if (sql.startsWith('update locations set environment')) {
            const [locationId, userId, environmentJson, effectiveParentId] = params;
            const row = locations.find((l) => l.location_id === locationId && l.user_id === userId);
            if (row) {
              row.environment = { ...row.environment, ...JSON.parse(environmentJson) };
              if (row.parent_location_id == null && effectiveParentId != null) row.parent_location_id = effectiveParentId;
            }
            return { rows: [] };
          }
          if (sql.startsWith('insert into locations')) {
            const [userId, name, visualDescription, definition, environmentJson, seed, imageUrl, renderedInput, renderHash, parentLocationId] = params;
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
              parent_location_id: parentLocationId ?? null,
            };
            locations.push(row);
            return { rows: [{ location_id: row.location_id }] };
          }
          if (sql.startsWith('insert into location_chat_links')) {
            const [locationId, chatId, swipeId] = params;
            locationChatLinks.push({ location_id: locationId, chat_id: chatId, anchor_swipe_id: swipeId });
            return { rows: [] };
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

          // §4.4 character match (eligible rows only) / re-anchor / auto-register.
          if (sql.startsWith('select character_id, status from characters')) {
            const [userId, name, chatId] = params;
            const eligible = characters.filter((c) => c.user_id === userId && c.name === name && eligibleCharacter(c, chatId));
            eligible.sort((a, b) => {
              if ((a.status === null) !== (b.status === null)) return a.status === null ? -1 : 1;
              if ((a.status === 'permanent') !== (b.status === 'permanent')) return a.status === 'permanent' ? -1 : 1;
              return a.character_id.localeCompare(b.character_id);
            });
            const row = eligible[0];
            return { rows: row ? [{ character_id: row.character_id, status: row.status }] : [] };
          }
          // rp-cast-infrastructure-plan.md A1: the mint-path persona carry-forward — the most
          // recent same-named row with a real persona (any status, any chat), copied onto the
          // new transient row so a character who appeared before keeps their persona.
          if (sql.startsWith('select persona, avatar_path from characters')) {
            const [userId, name] = params;
            const withPersona = characters
              .filter((c) => c.user_id === userId && c.name === name && (c.persona ?? '') !== '')
              .sort((a, b) => b.created_at.localeCompare(a.created_at));
            const row = withPersona[0];
            return { rows: row ? [{ persona: row.persona, avatar_path: row.avatar_path ?? null }] : [] };
          }
          if (sql.startsWith('update character_chat_links set anchor_swipe_id')) {
            const [swipeId, characterId, chatId] = params;
            const link = characterChatLinks.find((c) => c.character_id === characterId && c.chat_id === chatId);
            if (link) link.anchor_swipe_id = swipeId;
            return { rows: [] };
          }
          if (sql.startsWith('insert into characters')) {
            const [userId, name, persona, avatarPath] = params;
            const row = { character_id: randomUUID(), user_id: userId, name, persona: persona ?? '', avatar_path: avatarPath ?? null, status: 'transient', created_at: now() };
            characters.push(row);
            return { rows: [{ character_id: row.character_id }] };
          }
          if (sql.startsWith('insert into character_chat_links')) {
            const [characterId, chatId, swipeId] = params;
            characterChatLinks.push({ character_id: characterId, chat_id: chatId, anchor_swipe_id: swipeId });
            return { rows: [] };
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
const OTHER_CHAT = '55555555-5555-5555-5555-555555555555';
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
  assert(pool.locations[0].status === 'transient', 'the created location is transient');
  const locLink = pool.locationChatLinks.find((l) => l.location_id === pool.locations[0].location_id);
  assert(locLink?.chat_id === CHAT && locLink?.anchor_swipe_id === SWIPE, 'the created location is linked to this chat, anchored to this turn\'s active swipe (migration 0096)');
  assert(pool.locations[0].visual_description === 'The Drunken Kraken - Main Hall', 'visual_description is seeded from the extracted name (§4.2.3)');
  assert(pool.locations[0].environment.time_of_day === 'Late Evening', 'environment is seeded from the extracted time/date');
  assert(pool.locations[0].seed === 12345, 'a newly minted location carries the shared fixed image-gen seed');

  assert(pool.scenes.length === 1 && pool.scenes[0].chat_id === CHAT && pool.scenes[0].active_location_id === pool.locations[0].location_id, 'a scene keyed by (chat_id, active_location_id) is created');
  assert(pool.chatSessions.get(CHAT).scene_id === pool.scenes[0].scene_id, 'chat_sessions.scene_id is stamped with the resolved scene (§2.2 cache pointer)');

  assert(pool.characters.length === 2, 'two characters are auto-registered from Present: (Mair de-duplicated)');
  assert(pool.characters.every((c) => c.status === 'transient'), 'auto-registered characters are transient');
  assert(
    pool.characters.every((c) => pool.characterChatLinks.some((l) => l.character_id === c.character_id && l.chat_id === CHAT && l.anchor_swipe_id === SWIPE)),
    'every auto-registered character is linked to this chat, anchored to this turn\'s swipe',
  );
  assert(pool.presence.length === 2, 'scene_presence holds exactly the resolved roster');

  assert(ensure.calls.length === 1 && ensure.calls[0].messageId === MSG, 'the turn\'s message is the swipe anchor');
}

// --- scrapeTurnPresence: A1 persona carry-forward ------------------------------------------------
// rp-cast-infrastructure-plan.md A1: a minted character row carries the most recent same-named
// prior row's persona/avatar_path forward (any status, any chat — a persona is identity, not
// timeline state), so a character who appeared before gets their real persona back, and the
// describer's skip rule (describeCharacter.ts) sees the carried persona as already-described.
{
  const pool = poolWithActiveSwipe(createFakePool());
  const prior = {
    character_id: randomUUID(),
    user_id: USER,
    name: 'Seraphina',
    persona: 'A sharp-eyed harbormaster with a salt-cured coat.',
    avatar_path: '/avatars/seraphina.png',
    created_at: '2026-01-02T00:00:00.000Z',
    status: 'inactive', // demoted alternate timeline — still carries persona (not chat-scoped)
  };
  pool.characters.push(prior);
  // A different chat's row of the same name, newer but persona-less — must NOT win the carry.
  pool.characters.push({
    character_id: randomUUID(),
    user_id: USER,
    name: 'Seraphina',
    persona: '',
    avatar_path: null,
    created_at: '2026-01-03T00:00:00.000Z',
    status: 'transient',
  });

  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  const minted = pool.characters.find(
    (c) => c.name === 'Seraphina' && pool.characterChatLinks.some((l) => l.character_id === c.character_id && l.chat_id === CHAT),
  );
  assert(!!minted, 'Seraphina is freshly auto-registered (the prior rows are not eligible for THIS chat)');
  assert(minted.persona === 'A sharp-eyed harbormaster with a salt-cured coat.', 'the minted row carries the prior same-named row\'s persona (A1 carry-forward)');
  assert(minted.avatar_path === '/avatars/seraphina.png', 'the minted row carries the prior row\'s avatar_path');
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
    status: null, // user-authored (create_location writes status = null; always cross-chat eligible)
  };
  const mair = {
    character_id: 'bbbbbbbb-0000-0000-0000-000000000002',
    user_id: USER,
    name: 'Mair',
    persona: '',
    avatar_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    status: null, // user-authored character
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

  assert(pool.locations.length === 1 && pool.locations[0].environment.weather === 'clear', 'a user-authored location is matched, not duplicated');
  assert(pool.locations[0].environment.time_of_day === 'Late Evening', 'a matched location\'s environment is refreshed from the header');
  assert(pool.scenes.length === 1, 'the existing (chat, location) scene is reused, not duplicated');
  assert(pool.characters.length === 2, 'the user-authored character is matched; only Seraphina is auto-registered');
  assert(
    pool.presence.some((p) => p.character_id === mair.character_id) && pool.presence.length === 2,
    'the matched user-authored character is in the replaced presence roster',
  );
  assert(pool.locationChatLinks.length === 0, 'a user-authored (status null) location never gets a chat link row');
}

// --- db/migrations/0096: a row linked to a DIFFERENT chat must NOT match ------------------------
// (chat-scoping's core invariant: a name match can never resurrect another chat's same-named row.)
{
  const pool = poolWithActiveSwipe(createFakePool());
  const foreignLoc = { location_id: randomUUID(), user_id: USER, name: 'The Drunken Kraken - Main Hall', visual_description: 'a different chat\'s tavern', environment: {}, status: 'transient' };
  pool.locations.push(foreignLoc);
  pool.locationChatLinks.push({ location_id: foreignLoc.location_id, chat_id: OTHER_CHAT, anchor_swipe_id: randomUUID() });
  const foreignChar = { character_id: randomUUID(), user_id: USER, name: 'Mair', persona: '', avatar_path: null, created_at: '2026-01-01T00:00:00.000Z', status: 'transient' };
  pool.characters.push(foreignChar);
  pool.characterChatLinks.push({ character_id: foreignChar.character_id, chat_id: OTHER_CHAT, anchor_swipe_id: randomUUID() });

  const db = createPostgresClient(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: fakeEnsureActiveSwipe(pool).fn }, USER, CHAT, MSG, HEADER);
  assert(pool.locations.length === 2, 'a location linked only to a different chat is not matched — a fresh row is minted for this chat instead of resurrecting it');
  assert(pool.characters.length === 3, 'a character linked only to a different chat is not matched either — Mair and Seraphina are both freshly registered here');
}

// --- db/migrations/0096: a demoted (`inactive`) row must NOT match, even when linked to THIS chat --
// segway.md §2.6's invariant, re-scoped: an alternate-timeline row the sync tick already demoted
// must never be resurrected back into the model, regardless of link-table membership.
{
  const pool = poolWithActiveSwipe(createFakePool());
  const deadLoc = { location_id: randomUUID(), user_id: USER, name: 'The Drunken Kraken - Main Hall', visual_description: 'demoted alternate timeline', environment: {}, status: 'inactive' };
  pool.locations.push(deadLoc);
  pool.locationChatLinks.push({ location_id: deadLoc.location_id, chat_id: CHAT, anchor_swipe_id: randomUUID() });
  const db = createPostgresClient(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: fakeEnsureActiveSwipe(pool).fn }, USER, CHAT, MSG, HEADER);
  assert(pool.locations.length === 2, 'an inactive location is never matched, even when linked to this exact chat — a fresh row is minted instead');
}

// --- §4.2.5 same-place carry: a rerun-superseded row's rendered image is inherited -----------
// The rerun of the turn that anchored a row supersedes its swipe -> in the OLD per-swipe model
// this made the row ineligible; under the link-table model (migration 0096) the row stays linked
// to this chat and WOULD normally still match. This case instead demotes the row to `inactive`
// first (what the sync tick actually does once a swipe is truly superseded), so the mint-with-carry
// path is exercised the way it now really triggers.
{
  const pool = poolWithActiveSwipe(createFakePool());
  const superseded = {
    location_id: 'eeeeeeee-0000-0000-0000-000000000005',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'The Drunken Kraken - Main Hall',
    environment: {},
    status: 'inactive', // demoted by the sync tick once its anchoring swipe lost the live window
    seed: 12345,
    image_url: 'https://cdn.example.com/kraken.png',
    image_rendered_input: { visual_description: 'The Drunken Kraken - Main Hall', environment: {}, seed: 12345 },
    image_render_hash: 'hash-kraken',
    image_generated_at: '2026-08-08T10:00:00.000Z',
  };
  pool.locations.push(superseded);
  pool.locationChatLinks.push({ location_id: superseded.location_id, chat_id: CHAT, anchor_swipe_id: randomUUID() });
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 2, 'the inactive row is not matched — a fresh row is minted (timeline semantics unchanged)');
  const fresh = pool.locations.find((l) => l.location_id !== 'eeeeeeee-0000-0000-0000-000000000005');
  assert(fresh.image_url === 'https://cdn.example.com/kraken.png', 'the fresh row inherits the prior same-named row\'s image_url (§4.2.5 carry, still scoped through this chat\'s link)');
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
  const superseded = {
    location_id: 'ffffffff-0000-0000-0000-000000000006',
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.',
    definition: 'A rowdy dockside tavern and the crew\'s usual meeting spot.',
    environment: {},
    status: 'inactive',
    seed: 12345,
    image_url: 'https://cdn.example.com/kraken.png',
    image_rendered_input: { visual_description: 'A wide taproom with low oak beams…', environment: {}, seed: 12345 },
    image_render_hash: 'hash-kraken-described',
    image_generated_at: '2026-08-08T10:00:00.000Z',
  };
  pool.locations.push(superseded);
  pool.locationChatLinks.push({ location_id: superseded.location_id, chat_id: CHAT, anchor_swipe_id: randomUUID() });
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  const fresh = pool.locations.find((l) => l.location_id !== 'ffffffff-0000-0000-0000-000000000006');
  assert(fresh.visual_description === 'A wide taproom with low oak beams, a great hearth, and lanterns casting warm light across scarred tables.', 'a described prior\'s visual_description is carried onto the fresh row (hash-match keeps the §5.1.2 cache hit)');
  assert(fresh.definition === 'A rowdy dockside tavern and the crew\'s usual meeting spot.', 'a described prior\'s definition is carried onto the fresh row');
  assert(fresh.image_render_hash === 'hash-kraken-described', 'the carried description matches the carried hash — the render stays a cache hit');
}

// --- Re-anchor: a transient row reused by a later turn follows the live timeline's swipe -------
// Under the link-table model this is a same-chat revisit: the row stays linked (and eligible)
// across a swipe regen, but the match still re-anchors the link's anchor_swipe_id to the turn
// using it now, so the sync tick's later promote/demote settles it against the right message.
{
  const pool = createFakePool();
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
  };
  pool.locations.push(tavern);
  pool.locationChatLinks.push({ location_id: tavern.location_id, chat_id: CHAT, anchor_swipe_id: sa });
  const mair = {
    character_id: randomUUID(),
    user_id: USER,
    name: 'Mair',
    persona: '',
    avatar_path: null,
    created_at: '2026-01-01T00:00:00.000Z',
    status: 'transient',
  };
  pool.characters.push(mair);
  pool.characterChatLinks.push({ character_id: mair.character_id, chat_id: CHAT, anchor_swipe_id: sa });

  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings: FAKE_SETTINGS, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 1, 'the transient row is matched — no duplicate is created on reuse, even across a swipe regen');
  assert(pool.locationChatLinks.find((l) => l.location_id === tavern.location_id).anchor_swipe_id === sb, 'the matched transient location\'s link is re-anchored to the turn that is using it now');
  assert(pool.characters.length === 2, 'the transient character is matched — only Seraphina is newly registered');
  assert(pool.characterChatLinks.find((c) => c.character_id === mair.character_id).anchor_swipe_id === sb, 'the matched transient character\'s link is re-anchored to the current turn\'s swipe too');
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
  const subRow = {
    location_id: randomUUID(),
    user_id: USER,
    name: 'The Drunken Kraken - Main Hall',
    visual_description: 'Smoky.',
    environment: {},
    status: 'transient',
    parent_location_id: null, // pre-split mint: no link
  };
  pool.locations.push(subRow);
  pool.locationChatLinks.push({ location_id: subRow.location_id, chat_id: CHAT, anchor_swipe_id: 'swipe-old' });
  const settings = { get: async (k) => (k === 'location_split_enabled' ? 'true' : 'false') };
  const db = createPostgresClient(pool);
  const ensure = fakeEnsureActiveSwipe(pool);
  await scrapeTurnPresence({ db, settings, ensureActiveSwipe: ensure.fn }, USER, CHAT, MSG, HEADER);

  assert(pool.locations.length === 2, 'the pre-split sub is matched (no duplicate) and the parent row is backfilled into existence');
  const sub = pool.locations.find((l) => l.name === 'The Drunken Kraken - Main Hall');
  const parent = pool.locations.find((l) => l.name === 'The Drunken Kraken');
  assert(!!parent, 'the parent row name is the derived portion before the first " - "');
  assert(sub.parent_location_id === parent.location_id, 'the matched sub row is linked to the resolved-or-created parent row');
  assert(pool.locationChatLinks.find((l) => l.location_id === sub.location_id).anchor_swipe_id === sb, 'the matched transient sub\'s link is still re-anchored to the current turn\'s swipe');
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
    status: null, // user-authored — always eligible, no link needed
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
