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
  const characters = []; // {character_id, user_id, status, anchor_swipe_id} (segway.md §2.6 eligibility)
  const locations = []; // {location_id, user_id, status, anchor_swipe_id}
  const chatMessages = []; // {chat_id, active_swipe_id}
  let counter = 0;

  return {
    scenes,
    presence,
    characters,
    locations,
    chatMessages,
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
            };
            scenes.push(row);
            return { rows: [{ scene_id: row.scene_id, name: row.name }] };
          }

          if (sql.startsWith('select s.scene_id, s.name, s.active_location_id')) {
            const [userId, chatId] = params;
            assert(scopedUserId === userId, 'get_scenes is scoped to the requesting user');
            // segway.md §2.6 eligibility, modeled in JS: transient rows count only when their
            // anchor is on the calling chat's active swipe path ($2; null chat -> none).
            const activeSwipeIds = new Set(
              chatMessages.filter((m) => m.chat_id === chatId && m.active_swipe_id).map((m) => m.active_swipe_id),
            );
            const eligible = (row) =>
              row.status === null || row.status === 'permanent' || (row.status === 'transient' && activeSwipeIds.has(row.anchor_swipe_id));
            const rows = scenes
              .filter((s) => {
                if (s.user_id !== userId) return false;
                if (s.active_location_id === null) return true;
                const loc = locations.find((l) => l.location_id === s.active_location_id && l.user_id === userId);
                return loc ? eligible(loc) : true; // FK guarantees a row in real Postgres; lenient here
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
                    return c ? eligible(c) : true;
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

// --- segway.md §2.6: an inactive location/character must recall as absent, never leak ----------
{
  // A scene pinned to an inactive location, and a presence character who has been demoted
  // (alternate timeline), must both disappear from the model-facing listing — while the scene
  // itself (null location, user-authored character) stays visible.
  pool.locations.push({ location_id: locX, user_id: userId, status: 'inactive', anchor_swipe_id: null });
  pool.characters.push({ character_id: charA, user_id: userId, status: 'inactive', anchor_swipe_id: null });
  pool.characters.push({ character_id: charB, user_id: userId, status: null, anchor_swipe_id: null });

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

// --- segway.md §2.6 inclusion side: a transient row on the calling chat's active swipe path IS
// surfaced when the call carries chat context ------------------------------------------------
{
  const chatId = 'chat-live';
  const liveSwipe = 'swipe-live';
  pool.chatMessages.push({ chat_id: chatId, active_swipe_id: liveSwipe });
  const liveScene = await db.withUserScope(userId, (session) =>
    createSceneTool.handler({ name: 'Live-timeline courtyard' }, { userId, db: session }),
  );
  // charB is user-authored; add a transient character anchored to the live swipe and one
  // anchored to a dead swipe.
  const liveChar = 'live-char';
  const deadChar = 'dead-char';
  pool.characters.push({ character_id: liveChar, user_id: userId, status: 'transient', anchor_swipe_id: liveSwipe });
  pool.characters.push({ character_id: deadChar, user_id: userId, status: 'transient', anchor_swipe_id: 'swipe-dead' });
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
    'a transient character on the calling chat\'s active path is surfaced; one on a dead swipe is not',
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