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
  let counter = 0;

  return {
    scenes,
    presence,
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
            const [userId] = params;
            assert(scopedUserId === userId, 'get_scenes is scoped to the requesting user');
            const rows = scenes
              .filter((s) => s.user_id === userId)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((s) => ({
                scene_id: s.scene_id,
                name: s.name,
                active_location_id: s.active_location_id,
                character_ids: presence
                  .filter((p) => p.scene_id === s.scene_id && p.user_id === userId)
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