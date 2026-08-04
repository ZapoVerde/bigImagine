// Proves the characters plugin's tools end to end through info/registerTools (the real loader
// contract) using a small stateful fake Postgres pool simulating the characters table — same
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
  const characters = [];
  let counter = 0;

  return {
    characters,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into characters')) {
            const [userId, name, persona, scenario, systemPrompt, exampleDialogue, greetings] = params;
            assert(scopedUserId === userId, 'create_character is scoped to the requesting user');
            const row = {
              character_id: `char-${++counter}`,
              user_id: userId,
              name,
              persona,
              scenario,
              system_prompt: systemPrompt,
              example_dialogue: exampleDialogue,
              greetings,
              spec_version: 'v2',
              source_json: null,
            };
            characters.push(row);
            return { rows: [{ character_id: row.character_id, name: row.name }] };
          }

          if (sql.startsWith('select character_id, name from characters')) {
            const [userId] = params;
            assert(scopedUserId === userId, 'get_characters is scoped to the requesting user');
            const rows = characters
              .filter((c) => c.user_id === userId)
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => ({ character_id: c.character_id, name: c.name }));
            return { rows };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'characters' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, db: null, credentials: null, settings: null });
assert(pluginTools.length === 2, 'registerTools returns exactly two tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_character', 'get_characters']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

const createTool = registry.get('create_character');
const getTool = registry.get('get_characters');

// --- create_character ---
const elara = await db.withUserScope(userId, (session) =>
  createTool.handler(
    { name: 'Elara', persona: 'A stern but fair knight-commander.', greetings: ['You again.'] },
    { userId, db: session },
  ),
);
assert(elara.characterId.length > 0 && elara.name === 'Elara', 'create_character returns the new character id and name');

const bare = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'Bare' }, { userId, db: session }),
);
assert(bare.name === 'Bare', 'create_character works with only a name');

const otherUsersChar = await db.withUserScope(otherUserId, (session) =>
  createTool.handler({ name: 'Not yours' }, { userId: otherUserId, db: session }),
);

// --- get_characters ---
const all = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(all.length === 2, "get_characters only returns the requesting user's characters");
assert(all.every((c) => !('persona' in c)), 'get_characters summaries omit the static persona fields');
assert(all[0].name === 'Bare', 'get_characters orders by name');

// --- validation: empty name rejected before SQL ---
let threw = false;
try {
  await db.withUserScope(userId, (session) =>
    createTool.handler({ name: '   ' }, { userId, db: session }),
  );
} catch {
  threw = true;
}
assert(threw, 'create_character rejects a blank name before reaching SQL');

// --- cross-user isolation ---
const crossUser = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(!crossUser.some((c) => c.characterId === otherUsersChar.characterId), "another user's character is never visible");

if (process.exitCode) {
  console.error('\ncharacters verification FAILED');
  process.exit(1);
}
console.log('\ncharacters verification passed');