// Proves the scenes plugin's tools end to end through info/registerTools (the real loader
// contract) using a small stateful fake Postgres pool simulating the scenes and scene_presence
// tables — same style as verify-notes.mjs.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

function createFakePool() {
  const scenes = [];
  const presence = []; // {scene_id, character_id, user_id}
  const characters = []; // {character_id, user_id, status} (segway.md §2.6 eligibility)
  const locations = []; // {location_id, user_id, status}
  const locationChatLinks = []; // {location_id, chat_id, anchor_swipe_id} (migration 0096)
  const characterChatLinks = []; // {character_id, chat_id, anchor_swipe_id} (migration 0096)
  let counter = 0;

  return {
    scenes,
    presence,
    characters,
    locations,
    locationChatLinks,
    characterChatLinks,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into scenes')) {
            const [userId, name] = params;
            assert(scopedUserId === userId, 'create_scene is scoped to the requesting user');
            const row = {
              scene_id: `scene-${++counter}`,
              user_id: userId,
              name,
              active_location_id: null,
              chat_id: null, // create_scene mints user-authored, globally-visible rows (no chat_id)
            };
            scenes.push(row);
            return { rows: [{ scene_id: row.scene_id, name: row.name }] };
          }

          if (sql.startsWith('select s.scene_id, s.name, s.active_location_id')) {
            const [userId, chatId] = params;
            assert(scopedUserId === userId, 'get_scenes is scoped to the requesting user');
            // db/migrations/0096 eligibility, modeled in JS: user-authored (status null) is always
            // eligible; an auto-registered row is eligible only when linked to the calling chat and
            // not demoted to inactive (null chat -> no auto-registered row ever matches).
            const eligibleLocation = (row) =>
              row.status === null ||
              (row.status !== 'inactive' && locationChatLinks.some((l) => l.location_id === row.location_id && l.chat_id === chatId));
            const eligibleCharacter = (row) =>
              row.status === null ||
              (row.status !== 'inactive' && characterChatLinks.some((l) => l.character_id === row.character_id && l.chat_id === chatId));
            const rows = scenes
              .filter((s) => {
                if (s.user_id !== userId) return false;
                // rp-cast-infrastructure-plan.md Part C fix 1: `and (s.chat_id = $2 or s.chat_id is
                // null)` — a scene minted by resolveScene() for a different chat must never surface.
                if (s.chat_id !== null && s.chat_id !== chatId) return false;
                if (s.active_location_id === null) return true;
                const loc = locations.find((l) => l.location_id === s.active_location_id && l.user_id === userId);
                return loc ? eligibleLocation(loc) : true; // FK guarantees a row in real Postgres; lenient here
              })
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => ({
                scene_id: s.scene_id,
                name: s.name,
                active_location_id: s.active_location_id,
                character_ids: presence
                  .filter((p) => {
                    if (p.scene_id !== s.scene_id || p.user_id !== userId) return false;
                    const c = characters.find((ch) => ch.character_id === p.character_id && ch.user_id === userId);
                    return c ? eligibleCharacter(c) : true;
                  })
                  .map((p) => p.character_id),
              }));
            return { rows };
          }

          if (sql.startsWith('update scenes set active_location_id')) {
            const [sceneId, locationId] = params;
            const scene = scenes.find((s) => s.scene_id === sceneId && s.user_id === scopedUserId);
            if (!scene) return { rows: [] };
            scene.active_location_id = locationId;
            return { rows: [{ scene_id: scene.scene_id, active_location_id: scene.active_location_id }] };
          }

          if (sql.startsWith('insert into scene_presence')) {
            const [sceneId, characterId, userId] = params;
            assert(scopedUserId === userId, 'add_character_to_scene is scoped to the requesting user');
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

assert(info.id === 'scenes' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, db: null, credentials: null, settings: null });
assert(pluginTools.length === 4, 'registerTools returns exactly four tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_scene', 'get_scenes', 'set_active_location', 'add_character_to_scene']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';
const charA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const charB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const locX = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

const createSceneTool = registry.get('create_scene');
const getScenesTool = registry.get('get_scenes');
const setLocationTool = registry.get('set_active_location');
const addCharTool = registry.get('add_character_to_scene');

// --- create_scene ---
const castle = await db.withUserScope(userId, (session) =>
  createSceneTool.handler({ name: 'Castle courtyard' }, { userId, db: session }),
);
assert(castle.sceneId.length > 0 && castle.name === 'Castle courtyard', 'create_scene returns the new scene id and name');

const otherUsersScene = await db.withUserScope(otherUserId, (session) =>
  createSceneTool.handler({ name: 'Not yours' }, { userId: otherUserId, db: session }),
);

// --- get_scenes: empty presence ---
const before = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
assert(before.length === 1, "get_scenes only returns the requesting user's scenes");
assert(Array.isArray(before[0].characterIds) && before[0].characterIds.length === 0, 'a fresh scene has no present characters');
assert(before[0].activeLocationId === null, 'a fresh scene has no active location');

// --- add_character_to_scene + presence shows up ---
await db.withUserScope(userId, (session) =>
  addCharTool.handler({ scene_id: castle.sceneId, character_id: charA }, { userId, db: session }),
);
await db.withUserScope(userId, (session) =>
  addCharTool.handler({ scene_id: castle.sceneId, character_id: charB }, { userId, db: session }),
);
await db.withUserScope(userId, (session) =>
  addCharTool.handler({ scene_id: castle.sceneId, character_id: charA }, { userId, db: session }),
); // re-add is a no-op

const withPresence = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
assert(withPresence[0].characterIds.length === 2, 'presence reflects added characters, deduplicated');
assert(withPresence[0].characterIds.includes(charA) && withPresence[0].characterIds.includes(charB), 'both character ids are present');

// --- set_active_location ---
const located = await db.withUserScope(userId, (session) =>
  setLocationTool.handler({ scene_id: castle.sceneId, location_id: locX }, { userId, db: session }),
);
assert(located.activeLocationId === locX, 'set_active_location sets the scene active location');

const checked = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
assert(checked[0].activeLocationId === locX, 'the scene listing reflects the active location');

const cleared = await db.withUserScope(userId, (session) =>
  setLocationTool.handler({ scene_id: castle.sceneId, location_id: null }, { userId, db: session }),
);
assert(cleared.activeLocationId === null, 'set_active_location with null clears the active location');

// --- cross-user isolation ---
const crossScene = await db.withUserScope(userId, (session) =>
  setLocationTool.handler({ scene_id: otherUsersScene.sceneId, location_id: locX }, { userId, db: session }),
);
assert(crossScene.notFound === true, "set_active_location cannot mutate another user's scene");

const crossUserScenes = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
assert(!crossUserScenes.some((s) => s.sceneId === otherUsersScene.sceneId), "another user's scene is never visible");

// --- db/migrations/0096: an inactive location/character must recall as absent, never leak -------
{
  // A scene pinned to an inactive location, and a presence character who has been demoted
  // (alternate timeline), must both disappear from the model-facing listing — while the scene
  // itself (null location, user-authored character) stays visible.
  pool.locations.push({ location_id: locX, user_id: userId, status: 'inactive' });
  pool.characters.push({ character_id: charA, user_id: userId, status: 'inactive' });
  pool.characters.push({ character_id: charB, user_id: userId, status: null });

  const cleanScene = await db.withUserScope(userId, (session) =>
    createSceneTool.handler({ name: 'Stable courtyard' }, { userId, db: session }),
  );
  await db.withUserScope(userId, (session) =>
    addCharTool.handler({ scene_id: cleanScene.sceneId, character_id: charA }, { userId, db: session }),
  );
  await db.withUserScope(userId, (session) =>
    addCharTool.handler({ scene_id: cleanScene.sceneId, character_id: charB }, { userId, db: session }),
  );

  const listing = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
  const clean = listing.find((s) => s.sceneId === cleanScene.sceneId);
  assert(clean !== undefined, 'a scene with no active location stays visible');
  assert(clean.characterIds.length === 1 && clean.characterIds[0] === charB, 'an inactive character is filtered out of presence; a user-authored one stays');

  const located = await db.withUserScope(userId, (session) =>
    setLocationTool.handler({ scene_id: castle.sceneId, location_id: locX }, { userId, db: session }),
  );
  const afterInactiveLocation = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
  assert(
    !afterInactiveLocation.some((s) => s.sceneId === castle.sceneId),
    'a scene whose active location is inactive is excluded from the listing',
  );
}

// --- db/migrations/0096 inclusion side: a transient row linked to the calling chat IS surfaced,
// and one linked only to a different chat is not ------------------------------------------------
{
  const chatId = 'chat-live';
  const otherChatId = 'chat-other';
  const liveScene = await db.withUserScope(userId, (session) =>
    createSceneTool.handler({ name: 'Live-timeline courtyard' }, { userId, db: session }),
  );
  // charB is user-authored; add a transient character linked to the calling chat and one linked
  // only to a different chat.
  const liveChar = 'live-char';
  const deadChar = 'dead-char';
  pool.characters.push({ character_id: liveChar, user_id: userId, status: 'transient' });
  pool.characters.push({ character_id: deadChar, user_id: userId, status: 'transient' });
  pool.characterChatLinks.push({ character_id: liveChar, chat_id: chatId, anchor_swipe_id: 'swipe-live' });
  pool.characterChatLinks.push({ character_id: deadChar, chat_id: otherChatId, anchor_swipe_id: 'swipe-other' });
  await db.withUserScope(userId, (session) =>
    addCharTool.handler({ scene_id: liveScene.sceneId, character_id: liveChar }, { userId, db: session }),
  );
  await db.withUserScope(userId, (session) =>
    addCharTool.handler({ scene_id: liveScene.sceneId, character_id: deadChar }, { userId, db: session }),
  );
  await db.withUserScope(userId, (session) =>
    addCharTool.handler({ scene_id: liveScene.sceneId, character_id: charB }, { userId, db: session }),
  );

  const inChat = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session, chatId }));
  const live = inChat.find((s) => s.sceneId === liveScene.sceneId);
  assert(
    live.characterIds.includes(liveChar) && live.characterIds.includes(charB) && !live.characterIds.includes(deadChar),
    "a transient character linked to the calling chat is surfaced; one linked only to a different chat is not",
  );
}

// --- rp-cast-infrastructure-plan.md Part C fix 1: get_scenes is scoped to s.chat_id ---------------
{
  // resolveScene() (locationAndPresenceScraper.ts), not create_scene, is what mints a scene with a
  // chat_id — modeled here by pushing rows directly into the fake pool rather than going through
  // createSceneTool (which never sets chat_id).
  // castle's active_location_id was pinned to an inactive location in the block above, so it's no
  // longer eligible on its own — mint a fresh user-authored (chat_id null) scene for this block.
  const globalScene = await db.withUserScope(userId, (session) =>
    createSceneTool.handler({ name: 'Global user-authored scene' }, { userId, db: session }),
  );

  const chatA = 'chat-scene-a';
  const chatB = 'chat-scene-b';
  const sceneInChatA = {
    scene_id: 'scene-chat-a',
    user_id: userId,
    name: 'Chat A courtyard',
    active_location_id: null,
    chat_id: chatA,
  };
  const sceneInChatB = {
    scene_id: 'scene-chat-b',
    user_id: userId,
    name: 'Chat B courtyard',
    active_location_id: null,
    chat_id: chatB,
  };
  pool.scenes.push(sceneInChatA, sceneInChatB);

  const fromChatA = await db.withUserScope(userId, (session) =>
    getScenesTool.handler({}, { userId, db: session, chatId: chatA }),
  );
  assert(
    fromChatA.some((s) => s.sceneId === sceneInChatA.scene_id) && !fromChatA.some((s) => s.sceneId === sceneInChatB.scene_id),
    "get_scenes(chatId: chatA) returns chat A's own scene, not chat B's (Part C fix 1)",
  );
  assert(
    fromChatA.some((s) => s.sceneId === globalScene.sceneId),
    "get_scenes(chatId: chatA) still returns user-authored (chat_id null) scenes alongside the chat's own",
  );

  const fromChatB = await db.withUserScope(userId, (session) =>
    getScenesTool.handler({}, { userId, db: session, chatId: chatB }),
  );
  assert(
    fromChatB.some((s) => s.sceneId === sceneInChatB.scene_id) && !fromChatB.some((s) => s.sceneId === sceneInChatA.scene_id),
    "get_scenes(chatId: chatB) returns chat B's own scene, not chat A's",
  );

  const stateless = await db.withUserScope(userId, (session) => getScenesTool.handler({}, { userId, db: session }));
  assert(
    !stateless.some((s) => s.sceneId === sceneInChatA.scene_id) && !stateless.some((s) => s.sceneId === sceneInChatB.scene_id),
    'a stateless get_scenes call (no chatId) sees neither chat-scoped scene — only user-authored ones (posture change from Part C fix 1)',
  );
  assert(
    stateless.some((s) => s.sceneId === globalScene.sceneId),
    'a stateless get_scenes call still returns user-authored (chat_id null) scenes',
  );
}

// --- validation ---
let threw = false;
try {
  await db.withUserScope(userId, (session) => createSceneTool.handler({ name: '' }, { userId, db: session }));
} catch {
  threw = true;
}
assert(threw, 'create_scene rejects an empty name before reaching SQL');

if (process.exitCode) {
  console.error('\nscenes verification FAILED');
  process.exit(1);
}
console.log('\nscenes verification passed');