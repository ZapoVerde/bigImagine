// Proves the locations plugin's tools end to end through info/registerTools (the real loader
// contract) using a small stateful fake Postgres pool simulating the locations table — same
// style as verify-notes.mjs.

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
  const locations = [];
  const locationChatLinks = []; // {location_id, chat_id, anchor_swipe_id} (migration 0096)
  let counter = 0;

  return {
    locations,
    locationChatLinks,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into locations')) {
            // createLocationTool writes definition between visual_description and environment,
            // and status = null (literal SQL, not a param — a user-created location is exempt
            // from the auto-registration lifecycle, db/migrations/0096):
            // [userId, name, visual_description, definition, environment, seed]
            const [userId, name, visualDescription, definition, environmentJson, seed] = params;
            assert(scopedUserId === userId, 'create_location is scoped to the requesting user');
            const row = {
              location_id: `loc-${++counter}`,
              user_id: userId,
              name,
              visual_description: visualDescription,
              definition: definition ?? null,
              environment: JSON.parse(environmentJson),
              seed,
              status: null, // createLocationTool.ts writes null — user-created, always cross-chat eligible
            };
            locations.push(row);
            return { rows: [{ location_id: row.location_id, name: row.name }] };
          }

          if (sql.startsWith('select location_id, name, definition from locations')) {
            const [userId, chatId] = params;
            assert(scopedUserId === userId, 'get_locations is scoped to the requesting user');
            // db/migrations/0096 eligibility: user-authored (status null) is always eligible; an
            // auto-registered row is eligible only when linked to the calling chat and not
            // demoted to inactive (null chat -> no auto-registered row ever matches).
            const eligible = (l) =>
              l.status === null ||
              (l.status !== 'inactive' && locationChatLinks.some((link) => link.location_id === l.location_id && link.chat_id === chatId));
            const rows = locations
              .filter((l) => l.user_id === userId && eligible(l))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => ({ location_id: l.location_id, name: l.name, definition: l.definition ?? null }));
            return { rows };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'locations' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, db: null, credentials: null, settings: null });
assert(pluginTools.length === 3, 'registerTools returns exactly three tools (create, list, regenerate image)');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_location', 'get_locations', 'regenerate_location_image']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

const createTool = registry.get('create_location');
const getTool = registry.get('get_locations');

// --- create_location ---
const tavern = await db.withUserScope(userId, (session) =>
  createTool.handler(
    { name: 'The Leaky Cauldron', visual_description: 'A dim, smoky tavern.', environment: { time_of_day: 'night', weather: 'clear' }, seed: 42 },
    { userId, db: session },
  ),
);
assert(tavern.locationId.length > 0 && tavern.name === 'The Leaky Cauldron', 'create_location returns the new location id and name');

const withDef = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'The Sorting Room', definition: 'A cramped room where arrivals are assigned.' }, { userId, db: session }),
);
assert(withDef.name === 'The Sorting Room', 'create_location accepts an optional definition');

const bare = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'Crossroads' }, { userId, db: session }),
);
assert(bare.name === 'Crossroads', 'create_location works with only a name');

const otherUsersLoc = await db.withUserScope(otherUserId, (session) =>
  createTool.handler({ name: 'Not yours' }, { userId: otherUserId, db: session }),
);

// --- get_locations ---
const all = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(all.length === 3, "get_locations only returns the requesting user's locations");
assert(all.every((l) => !('visual_description' in l)), 'get_locations summaries omit the descriptive fields');
assert(all.find((l) => l.locationId === withDef.locationId)?.definition === 'A cramped room where arrivals are assigned.', 'get_locations surfaces the definition when one exists');
assert(!('definition' in all.find((l) => l.locationId === tavern.locationId)), 'get_locations omits definition when absent');
assert(all[0].name === 'Crossroads', 'get_locations orders by name');

// --- validation: empty name and malformed environment rejected before SQL ---
let threw = false;
try {
  await db.withUserScope(userId, (session) => createTool.handler({ name: '' }, { userId, db: session }));
} catch {
  threw = true;
}
assert(threw, 'create_location rejects an empty name before reaching SQL');

threw = false;
try {
  await db.withUserScope(userId, (session) =>
    createTool.handler({ name: 'Bad', environment: 'not-an-object' }, { userId, db: session }),
  );
} catch {
  threw = true;
}
assert(threw, 'create_location rejects a non-object environment before reaching SQL');

// --- cross-user isolation ---
const crossUser = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(!crossUser.some((l) => l.locationId === otherUsersLoc.locationId), "another user's location is never visible");

// --- db/migrations/0096: chat-linkage eligibility, and inactive is never model-visible -----------
{
  const chatId = 'chat-live';
  const otherChatId = 'chat-other';
  pool.locations.push({
    location_id: 'loc-inactive',
    user_id: userId,
    name: 'The Dark Cave',
    visual_description: '',
    environment: {},
    seed: null,
    status: 'inactive', // demoted alternate timeline
  });
  pool.locationChatLinks.push({ location_id: 'loc-inactive', chat_id: chatId, anchor_swipe_id: 'swipe-dead' });
  pool.locations.push({
    location_id: 'loc-transient',
    user_id: userId,
    name: 'The Forest Clearing',
    visual_description: '',
    environment: {},
    seed: null,
    status: 'transient',
  });
  pool.locationChatLinks.push({ location_id: 'loc-transient', chat_id: chatId, anchor_swipe_id: 'swipe-live' });

  const withoutChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
  assert(
    !withoutChat.some((l) => l.locationId === 'loc-inactive') && !withoutChat.some((l) => l.locationId === 'loc-transient'),
    'with no chat context, an inactive and a chat-linked transient location are both excluded',
  );

  const inChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session, chatId }));
  assert(
    inChat.some((l) => l.locationId === 'loc-transient') && !inChat.some((l) => l.locationId === 'loc-inactive'),
    'a transient location linked to the calling chat is surfaced; an inactive one never is, even when linked',
  );

  const inOtherChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session, chatId: otherChatId }));
  assert(
    !inOtherChat.some((l) => l.locationId === 'loc-transient'),
    "a transient location linked to a DIFFERENT chat is not surfaced — chat-scoping's core invariant",
  );
}

if (process.exitCode) {
  console.error('\nlocations verification FAILED');
  process.exit(1);
}
console.log('\nlocations verification passed');