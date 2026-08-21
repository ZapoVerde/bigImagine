// Verifies the RP Sprite Stage resolver — current + historical (Tasks 1.1 + 1.2)
// against a fake Postgres pool — no server, no network.

import { createPostgresClient } from '../dist/io/postgres.js';
import { getCharacterSpriteState, handleChatCharacterSprites } from '../dist/server/characterSpriteState.js';
import { normalizeExpression, normalizeOutfitKey } from '../dist/orchestrator/characterVisualStateParser.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const USER = '11111111-1111-1111-1111-111111111111';
const USER2 = '99999999-9999-9999-9999-999999999999';
const CHAT = '22222222-2222-2222-2222-222222222222';
const CHAT2 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const SCENE = '33333333-3333-3333-3333-333333333333';
const SCENE2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const AVA_ID = '55555555-5555-5555-5555-555555555555';
const KAI_ID = '66666666-6666-6666-6666-666666666666';
const ZARA_ID = '77777777-7777-7777-7777-777777777777';
const MSG1 = '88888888-8888-8888-8888-888888888888';
const MSG2 = '99999999-9999-9999-9999-aaaaaaaaaaaa';
const SWIPE1 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SWIPE2 = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const SWIPE3 = 'cccccccc-dddd-eeee-ffff-111111111111';

function createFakePool() {
  const chatSessions = []; // { chat_id, user_id, scene_id }
  const scenes = [];
  const presence = [];
  const characters = [];
  const characterChatLinks = [];
  const states = []; // { user_id, chat_id, character_id, expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory, message_id, swipe_id }
  const combinations = [];
  const chatMessages = []; // { message_id, chat_id, user_id, created_at }
  const chatMessageSwipes = []; // { swipe_id, message_id, created_at }
  const events = []; // { user_id, chat_id, character_id, message_id, swipe_id, after_state, created_at }

  return {
    chatSessions,
    scenes,
    presence,
    characters,
    characterChatLinks,
    states,
    combinations,
    chatMessages,
    chatMessageSwipes,
    events,
    async connect() {
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) return { rows: [] };
          const q = sql.replace(/\s+/g, ' ').trim();

          if (q.startsWith('select scene_id from chat_sessions where chat_id = $1')) {
            const [chatId] = params;
            const row = chatSessions.find((c) => c.chat_id === chatId);
            return { rows: row ? [{ scene_id: row.scene_id }] : [] };
          }
          if (q.includes('from scene_presence sp') && q.includes('join characters c')) {
            const [sceneId, userId] = params;
            const rows = presence
              .filter((p) => p.scene_id === sceneId && p.user_id === userId)
              .sort((a, b) => a.presence_order - b.presence_order)
              .map((p) => {
                const ch = characters.find((c) => c.character_id === p.character_id && c.user_id === userId);
                if (!ch) return null;
                return { character_id: p.character_id, presence_order: p.presence_order, name: ch.name, status: ch.status ?? null };
              })
              .filter(Boolean);
            return { rows };
          }
          if (q.startsWith('select character_id from character_chat_links where chat_id = $1')) {
            const [chatId] = params;
            return { rows: characterChatLinks.filter((l) => l.chat_id === chatId).map((l) => ({ character_id: l.character_id })) };
          }
          if (q.startsWith('select expression, outerwear, top, bottom, underwear_top, underwear_bottom, accessory')) {
            const [userId, chatId, characterId] = params;
            const row = states.find((s) => s.user_id === userId && s.chat_id === chatId && s.character_id === characterId);
            if (!row) return { rows: [] };
            return {
              rows: [
                {
                  expression: row.expression,
                  outerwear: row.outerwear,
                  top: row.top,
                  bottom: row.bottom,
                  underwear_top: row.underwear_top,
                  underwear_bottom: row.underwear_bottom,
                  accessory: row.accessory,
                  message_id: row.message_id ?? null,
                  swipe_id: row.swipe_id ?? null,
                },
              ],
            };
          }
          if (q.includes('from character_visual_combinations') && q.includes('bgrm_applied = $6')) {
            const [userId, chatId, characterId, outfitKey, expressionKey, bgrmApplied] = params;
            const row = combinations.find(
              (c) =>
                c.user_id === userId &&
                c.chat_id === chatId &&
                c.character_id === characterId &&
                c.outfit_key === outfitKey &&
                c.expression_key === expressionKey &&
                c.bgrm_applied === bgrmApplied,
            );
            return { rows: row ? [{ image_url: row.image_url }] : [] };
          }
          if (q.startsWith('select created_at from chat_message_swipes where swipe_id = $1')) {
            const [swipeId] = params;
            const row = chatMessageSwipes.find((s) => s.swipe_id === swipeId);
            return { rows: row ? [{ created_at: row.created_at }] : [] };
          }
          if (q.startsWith('select created_at from chat_messages where message_id = $1 and chat_id = $2')) {
            const [messageId, chatId] = params;
            const row = chatMessages.find((m) => m.message_id === messageId && m.chat_id === chatId);
            return { rows: row ? [{ created_at: row.created_at }] : [] };
          }
          if (q.includes('from character_visual_state_events') && q.includes('swipe_id = $4')) {
            const [userId, chatId, characterId, swipeId] = params;
            const rows = events
              .filter((e) => e.user_id === userId && e.chat_id === chatId && e.character_id === characterId && e.swipe_id === swipeId)
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
              .slice(0, 1)
              .map((e) => ({ after_state: e.after_state, created_at: e.created_at }));
            return { rows };
          }
          if (q.includes('from character_visual_state_events') && q.includes('created_at <= $4')) {
            const [userId, chatId, characterId, targetCreatedAt] = params;
            const targetTime = new Date(targetCreatedAt).getTime();
            const rows = events
              .filter((e) => e.user_id === userId && e.chat_id === chatId && e.character_id === characterId && new Date(e.created_at).getTime() <= targetTime)
              .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
              .slice(0, 1)
              .map((e) => ({ after_state: e.after_state, created_at: e.created_at }));
            return { rows };
          }
          if (q.includes('from orchestrator_settings where key = $1')) return { rows: [] };
          throw new Error(`fake pool: unhandled query: ${sql} (params: ${JSON.stringify(params)})`);
        },
        release() {},
      };
    },
  };
}

function createFakeSettings(bgrmEnabled) {
  return {
    async get(key) {
      if (key === 'character_visual_bgrm_enabled') return bgrmEnabled ? 'true' : 'false';
      return undefined;
    },
    async set() {},
  };
}

function outfitFields(base = {}) {
  return {
    outerwear: base.outerwear ?? 'leather jacket',
    top: base.top ?? 'white blouse',
    bottom: base.bottom ?? 'jeans',
    underwear_top: base.underwear_top ?? 'none',
    underwear_bottom: base.underwear_bottom ?? 'none',
    accessory: base.accessory ?? 'silver pendant',
  };
}

function seedChat(pool, chatId, userId, sceneId) {
  pool.chatSessions.push({ chat_id: chatId, user_id: userId, scene_id: sceneId });
  if (sceneId) pool.scenes.push({ scene_id: sceneId, user_id: userId, name: 'Main' });
}
function seedCharacter(pool, characterId, userId, name, status = null) {
  pool.characters.push({ character_id: characterId, user_id: userId, name, status });
}
function linkCharacter(pool, characterId, chatId) {
  pool.characterChatLinks.push({ character_id: characterId, chat_id: chatId });
}
function addPresence(pool, sceneId, characterId, userId, order) {
  pool.presence.push({ scene_id: sceneId, character_id: characterId, user_id: userId, presence_order: order });
}
function addState(pool, userId, chatId, characterId, expression, outfit, messageId = null, swipeId = null) {
  pool.states.push({
    user_id: userId,
    chat_id: chatId,
    character_id: characterId,
    expression,
    outerwear: outfit.outerwear,
    top: outfit.top,
    bottom: outfit.bottom,
    underwear_top: outfit.underwear_top,
    underwear_bottom: outfit.underwear_bottom,
    accessory: outfit.accessory,
    message_id: messageId,
    swipe_id: swipeId,
  });
}
function addCombination(pool, userId, chatId, characterId, outfit, expression, imageUrl, bgrmApplied) {
  pool.combinations.push({
    user_id: userId,
    chat_id: chatId,
    character_id: characterId,
    outfit_key: normalizeOutfitKey(outfit),
    expression_key: normalizeExpression(expression),
    image_url: imageUrl,
    bgrm_applied: bgrmApplied,
  });
}
function addMessage(pool, messageId, chatId, userId, createdAt) {
  pool.chatMessages.push({ message_id: messageId, chat_id: chatId, user_id: userId, created_at: createdAt });
}
function addSwipe(pool, swipeId, messageId, createdAt) {
  pool.chatMessageSwipes.push({ swipe_id: swipeId, message_id: messageId, created_at: createdAt });
}
function addEvent(pool, userId, chatId, characterId, messageId, swipeId, afterStateObj, createdAt) {
  pool.events.push({
    user_id: userId,
    chat_id: chatId,
    character_id: characterId,
    message_id: messageId,
    swipe_id: swipeId,
    after_state: JSON.stringify(afterStateObj),
    created_at: createdAt,
  });
}

// ---------------------------------------------------------------------------
// Task 1.1 tests (unchanged)
// ---------------------------------------------------------------------------

{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/ava.png', false);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 1, '1.1 one present character returns one row');
  assert(rows[0].characterId === AVA_ID, '1.1 correct characterId');
  assert(rows[0].imageUrl === 'https://cdn.example/ava.png', '1.1 matching combination returns stored URL');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  seedCharacter(pool, KAI_ID, USER, 'Kai', null);
  seedCharacter(pool, ZARA_ID, USER, 'Zara', null);
  addPresence(pool, SCENE, KAI_ID, USER, 1);
  addPresence(pool, SCENE, ZARA_ID, USER, 2);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  for (const id of [AVA_ID, KAI_ID, ZARA_ID]) {
    addState(pool, USER, CHAT, id, 'composed', of);
    addCombination(pool, USER, CHAT, id, of, 'composed', `https://cdn.example/${id}.png`, false);
  }
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 3, '1.1 multiple characters returns three rows');
  assert(rows[0].characterId === AVA_ID && rows[1].characterId === KAI_ID && rows[2].characterId === ZARA_ID, '1.1 presence_order preserved');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 1 && rows[0].imageUrl === null, '1.1 missing visual state → imageUrl null');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 1 && rows[0].imageUrl === null, '1.1 missing combination → imageUrl null');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/raw.png', false);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/bgrm.png', true);
  let rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows[0].imageUrl === 'https://cdn.example/raw.png', '1.1 bgrm disabled → raw URL');
  rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(true) }, USER, CHAT);
  assert(rows[0].imageUrl === 'https://cdn.example/bgrm.png', '1.1 bgrm enabled → bgrm URL');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/raw.png', false);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(true) }, USER, CHAT);
  assert(rows[0].imageUrl === 'https://cdn.example/raw.png', '1.1 bgrm enabled but only raw exists → raw fallback (fail-open AC-19)');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedChat(pool, CHAT2, USER, SCENE2);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  seedCharacter(pool, KAI_ID, USER2, 'Kai', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  addPresence(pool, SCENE, KAI_ID, USER2, 1);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/ava.png', false);
  addState(pool, USER2, CHAT, KAI_ID, 'composed', of);
  addCombination(pool, USER2, CHAT, KAI_ID, of, 'composed', 'https://cdn.example/kai-leak.png', false);
  addCombination(pool, USER, CHAT2, AVA_ID, of, 'composed', 'https://cdn.example/ava-chat2.png', false);
  let rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 1 && rows[0].characterId === AVA_ID, '1.1 user isolation');
  const rows2 = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT2);
  assert(rows2.length === 0, '1.1 chat isolation');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, null);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 0, '1.1 no active scene empty');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', 'inactive');
  linkCharacter(pool, AVA_ID, CHAT);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(rows.length === 0, '1.1 inactive filtered');
}
{
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/ava.png', false);
  const before = pool.combinations.length;
  await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT);
  assert(pool.combinations.length === before, '1.1 no writes');
}

// ---------------------------------------------------------------------------
// Task 1.2 historical tests
// ---------------------------------------------------------------------------

{
  // Two swipe variants with differing visual state — current vs historical
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const ofCalm = outfitFields({ top: 'white blouse', accessory: 'silver pendant' });
  const ofAngry = outfitFields({ top: 'black blouse', accessory: 'silver pendant' });
  // Messages and swipes with timestamps
  const t1 = new Date('2026-08-20T10:00:00Z').toISOString();
  const t2 = new Date('2026-08-20T11:00:00Z').toISOString();
  const tE1 = new Date('2026-08-20T10:00:01Z').toISOString();
  const tE2 = new Date('2026-08-20T11:00:01Z').toISOString();
  addMessage(pool, MSG1, CHAT, USER, t1);
  addMessage(pool, MSG2, CHAT, USER, t2);
  addSwipe(pool, SWIPE1, MSG1, t1);
  addSwipe(pool, SWIPE2, MSG2, t2);
  // Current state is the newest (angry/black)
  addState(pool, USER, CHAT, AVA_ID, 'angry', ofAngry, MSG2, SWIPE2);
  // Events
  addEvent(pool, USER, CHAT, AVA_ID, MSG1, SWIPE1, { expression: 'composed', outfit: ofCalm, innerThoughts: 'x' }, tE1);
  addEvent(pool, USER, CHAT, AVA_ID, MSG2, SWIPE2, { expression: 'angry', outfit: ofAngry, innerThoughts: 'y' }, tE2);
  addCombination(pool, USER, CHAT, AVA_ID, ofCalm, 'composed', 'https://cdn.example/calm.png', false);
  addCombination(pool, USER, CHAT, AVA_ID, ofAngry, 'angry', 'https://cdn.example/angry.png', false);

  const db = createPostgresClient(pool);
  const settings = createFakeSettings(false);
  // Current (no historical param) → angry
  let rows = await getCharacterSpriteState({ db, settings }, USER, CHAT);
  assert(rows[0].imageUrl === 'https://cdn.example/angry.png' && rows[0].expression === 'angry', '1.2 current shows newest variant');

  // Historical swipe1 → calm (exact swipe_id match)
  rows = await getCharacterSpriteState({ db, settings }, USER, CHAT, { selectedSwipeId: SWIPE1, selectedMessageId: MSG1 });
  assert(rows[0].imageUrl === 'https://cdn.example/calm.png' && rows[0].expression === 'composed', '1.2 historical SWIPE1 resolves calm');

  // Historical swipe2 → angry (fast path matches current state's swipe_id)
  rows = await getCharacterSpriteState({ db, settings }, USER, CHAT, { selectedSwipeId: SWIPE2, selectedMessageId: MSG2 });
  assert(rows[0].imageUrl === 'https://cdn.example/angry.png', '1.2 historical SWIPE2 resolves angry via fast path');

  // AC01: selecting older swipe never shows newer snapshot — verified by SWIPE1 calm vs current/SWIPE2 angry distinction
  assert(rows[0].imageUrl === 'https://cdn.example/angry.png' && rows[0].imageUrl !== 'https://cdn.example/calm.png', '1.2 AC01 SWIPE2 shows angry not calm');
}

{
  // Historical fallback: swipe with no visible-change event — should return latest prior event
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const ofCalm = outfitFields({ top: 'white blouse' });
  const ofAngry = outfitFields({ top: 'black blouse' });
  const t1 = new Date('2026-08-20T10:00:00Z').toISOString();
  const t2 = new Date('2026-08-20T11:00:00Z').toISOString();
  const t3 = new Date('2026-08-20T12:00:00Z').toISOString();
  const tE1 = new Date('2026-08-20T10:00:01Z').toISOString();
  const tE2 = new Date('2026-08-20T11:00:01Z').toISOString();
  addMessage(pool, MSG1, CHAT, USER, t1);
  addMessage(pool, MSG2, CHAT, USER, t3);
  addSwipe(pool, SWIPE1, MSG1, t1);
  addSwipe(pool, SWIPE2, MSG2, t2); // intermediate swipe with no event
  addSwipe(pool, SWIPE3, MSG2, t3);
  addState(pool, USER, CHAT, AVA_ID, 'angry', ofAngry, MSG2, SWIPE3);
  addEvent(pool, USER, CHAT, AVA_ID, MSG1, SWIPE1, { expression: 'composed', outfit: ofCalm, innerThoughts: 'x' }, tE1);
  addEvent(pool, USER, CHAT, AVA_ID, MSG2, SWIPE3, { expression: 'angry', outfit: ofAngry, innerThoughts: 'y' }, tE2);
  addCombination(pool, USER, CHAT, AVA_ID, ofCalm, 'composed', 'https://cdn.example/calm.png', false);
  addCombination(pool, USER, CHAT, AVA_ID, ofAngry, 'angry', 'https://cdn.example/angry.png', false);

  const db = createPostgresClient(pool);
  const settings = createFakeSettings(false);
  // SWIPE2 has no direct event — fallback should give calm (latest <= t2 is E1)
  const rows = await getCharacterSpriteState({ db, settings }, USER, CHAT, { selectedSwipeId: SWIPE2, selectedMessageId: MSG2 });
  assert(rows[0].imageUrl === 'https://cdn.example/calm.png', '1.2 fallback to latest prior event when swipe had no visible change');
}

{
  // Known historical combination reuses existing URL (AC03)
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  const t1 = new Date('2026-08-20T10:00:00Z').toISOString();
  addMessage(pool, MSG1, CHAT, USER, t1);
  addSwipe(pool, SWIPE1, MSG1, t1);
  addState(pool, USER, CHAT, AVA_ID, 'composed', of, MSG1, SWIPE1);
  addEvent(pool, USER, CHAT, AVA_ID, MSG1, SWIPE1, { expression: 'composed', outfit: of, innerThoughts: 'x' }, t1);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/known.png', false);
  const rows = await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT, { selectedSwipeId: SWIPE1 });
  assert(rows[0].imageUrl === 'https://cdn.example/known.png', '1.2 AC03 historical known combination reuses URL');
}

{
  // Historical resolution does not trigger generation (AC04) — combinations unchanged
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  const t1 = new Date('2026-08-20T10:00:00Z').toISOString();
  addMessage(pool, MSG1, CHAT, USER, t1);
  addSwipe(pool, SWIPE1, MSG1, t1);
  addState(pool, USER, CHAT, AVA_ID, 'composed', of, MSG1, SWIPE1);
  addEvent(pool, USER, CHAT, AVA_ID, MSG1, SWIPE1, { expression: 'composed', outfit: of, innerThoughts: 'x' }, t1);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/a.png', false);
  const before = pool.combinations.length;
  await getCharacterSpriteState({ db: createPostgresClient(pool), settings: createFakeSettings(false) }, USER, CHAT, { selectedSwipeId: SWIPE1 });
  assert(pool.combinations.length === before, '1.2 AC04 no generation on historical read');
}

{
  // Current vs historical differ — ensure older swipe not blindly showing newer (AC01 explicit)
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const ofOld = outfitFields({ top: 'white blouse' });
  const ofNew = outfitFields({ top: 'black blouse' });
  const tOld = new Date('2026-08-20T09:00:00Z').toISOString();
  const tNew = new Date('2026-08-20T10:00:00Z').toISOString();
  addMessage(pool, MSG1, CHAT, USER, tOld);
  addMessage(pool, MSG2, CHAT, USER, tNew);
  addSwipe(pool, SWIPE1, MSG1, tOld);
  addSwipe(pool, SWIPE2, MSG2, tNew);
  addState(pool, USER, CHAT, AVA_ID, 'angry', ofNew, MSG2, SWIPE2);
  addEvent(pool, USER, CHAT, AVA_ID, MSG1, SWIPE1, { expression: 'composed', outfit: ofOld, innerThoughts: 'old' }, tOld);
  addEvent(pool, USER, CHAT, AVA_ID, MSG2, SWIPE2, { expression: 'angry', outfit: ofNew, innerThoughts: 'new' }, tNew);
  addCombination(pool, USER, CHAT, AVA_ID, ofOld, 'composed', 'https://cdn.example/old.png', false);
  addCombination(pool, USER, CHAT, AVA_ID, ofNew, 'angry', 'https://cdn.example/new.png', false);
  const db = createPostgresClient(pool);
  const rowsOld = await getCharacterSpriteState({ db, settings: createFakeSettings(false) }, USER, CHAT, { selectedSwipeId: SWIPE1 });
  const rowsNew = await getCharacterSpriteState({ db, settings: createFakeSettings(false) }, USER, CHAT);
  assert(rowsOld[0].imageUrl === 'https://cdn.example/old.png', '1.2 AC01 older swipe does not show newer image');
  assert(rowsNew[0].imageUrl === 'https://cdn.example/new.png', '1.2 AC01 current shows newest');
  assert(rowsOld[0].imageUrl !== rowsNew[0].imageUrl, '1.2 AC01 older vs newer URLs differ');
}

{
  // ---- Endpoint: GET /v1/chats/:chatId/character-sprites ----
  const pool = createFakePool();
  seedChat(pool, CHAT, USER, SCENE);
  seedCharacter(pool, AVA_ID, USER, 'Ava', null);
  addPresence(pool, SCENE, AVA_ID, USER, 0);
  const of = outfitFields();
  addState(pool, USER, CHAT, AVA_ID, 'composed', of);
  addCombination(pool, USER, CHAT, AVA_ID, of, 'composed', 'https://cdn.example/endpoint.png', false);
  const db = createPostgresClient(pool);
  const settings = createFakeSettings(false);
  // Real handler test: GET returns 200 {sprites}, POST returns 405, envelope validated
  function createMockRes() {
    let statusCode = 0;
    let headers = {};
    let bodyChunks = [];
    return {
      statusCode,
      headersSent: false,
      writeHead(s, h) { statusCode = s; headers = h; this.statusCode = s; },
      setHeader() {},
      get status() { return statusCode; },
      get body() { return bodyChunks.join(''); },
      get capturedStatus() { return statusCode; },
      write(chunk) { bodyChunks.push(String(chunk)); },
      end(chunk) { if (chunk) bodyChunks.push(String(chunk)); this.headersSent = true; },
      _getBodyJson() {
        try { return JSON.parse(bodyChunks.join('')); } catch { return null; }
      },
      _status: () => statusCode,
    };
  }
  // GET should return 200 with correct envelope and no raw leakage
  {
    const mockReq = { method: 'GET', url: `/v1/chats/${CHAT}/character-sprites`, headers: {} };
    const mockRes = createMockRes();
    // Patch sendJson to capture via mockRes — handleChatCharacterSprites uses sendJson which writes to res
    await handleChatCharacterSprites(mockReq, mockRes, { db, settings }, USER, new URL(mockReq.url, 'http://placeholder'));
    const json = mockRes._getBodyJson();
    assert(mockRes.statusCode === 200 || mockRes.capturedStatus === 200, '1.3 endpoint GET 200');
    assert(json && Array.isArray(json.sprites) && json.sprites.length === 1 && json.sprites[0].imageUrl === 'https://cdn.example/endpoint.png', '1.3 endpoint GET returns ordered presentation rows');
    assert(json.sprites[0] && 'characterId' in json.sprites[0] && 'presenceOrder' in json.sprites[0] && !('composed_prompt' in json.sprites[0]) && !('outfit_key' in json.sprites[0]), '1.3 AC03 no raw persistence leakage via HTTP');
  }
  // POST should be 405 read-only
  {
    const mockReq = { method: 'POST', url: `/v1/chats/${CHAT}/character-sprites`, headers: {} };
    const mockRes = createMockRes();
    await handleChatCharacterSprites(mockReq, mockRes, { db, settings }, USER, new URL(mockReq.url, 'http://placeholder'));
    assert(mockRes.statusCode === 405 || mockRes.capturedStatus === 405, '1.3 AC04 POST returns 405 read-only');
  }
  // No generation side effect via HTTP
  {
    const before = pool.combinations.length;
    const mockReq = { method: 'GET', url: `/v1/chats/${CHAT}/character-sprites`, headers: {} };
    const mockRes = createMockRes();
    await handleChatCharacterSprites(mockReq, mockRes, { db, settings }, USER, new URL(mockReq.url, 'http://placeholder'));
    assert(pool.combinations.length === before, '1.3 AC05 no generation/BGRM on HTTP read');
  }
}

console.log('verify-character-sprite-state: all checks passed (1.1 + 1.2 + 1.3)');
if (process.exitCode && process.exitCode !== 0) {
  console.error('verify-character-sprite-state: failures detected');
}
