// Proves all four tools end to end through info/registerTools (the real loader contract) using a
// small stateful fake Postgres pool that simulates the prompt_presets table across a sequence of
// calls — same style as plugins/notes's verify-notes.mjs.

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
  const presets = [];
  let counter = 0;

  return {
    presets,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into prompt_presets')) {
            const [userId, name, content] = params;
            assert(scopedUserId === userId, 'create_prompt_preset is scoped to the requesting user');
            const preset = {
              preset_id: `preset-${++counter}`,
              user_id: userId,
              name,
              content,
              updated_at: `2026-07-25T00:00:${String(counter).padStart(2, '0')}Z`,
            };
            presets.push(preset);
            return { rows: [{ preset_id: preset.preset_id, name: preset.name, content: preset.content }] };
          }

          if (sql.startsWith('select preset_id, name, content, updated_at from prompt_presets')) {
            const [userId] = params;
            assert(scopedUserId === userId, 'get_prompt_presets is scoped to the requesting user');
            const matches = presets.filter((p) => p.user_id === userId).sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
            return { rows: matches };
          }

          if (sql.startsWith('update prompt_presets set')) {
            const [presetId, userId, ...rest] = params;
            assert(scopedUserId === userId, 'update_prompt_preset is scoped to the requesting user');
            const preset = presets.find((p) => p.preset_id === presetId && p.user_id === userId);
            if (!preset) return { rows: [] };
            let i = 0;
            if (sql.includes('name = $')) preset.name = rest[i++];
            if (sql.includes('content = $')) preset.content = rest[i++];
            preset.updated_at = `2026-07-25T01:00:${String(++counter).padStart(2, '0')}Z`;
            return { rows: [{ preset_id: preset.preset_id, name: preset.name, content: preset.content, updated_at: preset.updated_at }] };
          }

          if (sql.startsWith('delete from prompt_presets')) {
            const [presetId, userId] = params;
            assert(scopedUserId === userId, 'delete_prompt_preset is scoped to the requesting user');
            const idx = presets.findIndex((p) => p.preset_id === presetId && p.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [deleted] = presets.splice(idx, 1);
            return { rows: [{ preset_id: deleted.preset_id }] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'prompt-presets' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined });
assert(pluginTools.length === 4, 'registerTools returns exactly four tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_prompt_preset', 'get_prompt_presets', 'update_prompt_preset', 'delete_prompt_preset']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

const createTool = registry.get('create_prompt_preset');
const getTool = registry.get('get_prompt_presets');
const updateTool = registry.get('update_prompt_preset');
const deleteTool = registry.get('delete_prompt_preset');

// --- create_prompt_preset ---
const terse = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'Terse Assistant', content: 'Answer in one sentence.' }, { userId, db: session }),
);
assert(terse.name === 'Terse Assistant' && terse.content === 'Answer in one sentence.', 'create_prompt_preset stores name/content');

const verbose = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'Verbose', content: 'Explain thoroughly.' }, { userId, db: session }),
);

const othersPreset = await db.withUserScope(otherUserId, (session) =>
  createTool.handler({ name: 'Not yours', content: 'x' }, { userId: otherUserId, db: session }),
);

// --- get_prompt_presets ---
const all = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(all.length === 2, 'get_prompt_presets only returns the requesting user\'s presets');
assert(all[0].name === 'Verbose', 'get_prompt_presets orders by updated_at desc (most recently created first)');
assert(all[0].content === 'Explain thoroughly.', 'get_prompt_presets returns full content, not a summary');

// --- update_prompt_preset ---
const updated = await db.withUserScope(userId, (session) =>
  updateTool.handler({ preset_id: terse.presetId, content: 'Answer in at most two sentences.' }, { userId, db: session }),
);
assert(updated.found === true && updated.content === 'Answer in at most two sentences.', 'update_prompt_preset changes only the given field');
assert(updated.name === 'Terse Assistant', 'update_prompt_preset leaves an unspecified field untouched');

const updateMissing = await db.withUserScope(userId, (session) =>
  updateTool.handler({ preset_id: 'does-not-exist', name: 'x' }, { userId, db: session }),
);
assert(updateMissing.found === false, 'update_prompt_preset reports not-found for a missing preset rather than throwing');

// --- delete_prompt_preset ---
const crossUserDelete = await db.withUserScope(userId, (session) =>
  deleteTool.handler({ preset_id: othersPreset.presetId }, { userId, db: session }),
);
assert(crossUserDelete.deleted === false, 'delete_prompt_preset cannot delete another user\'s preset');

const deleted = await db.withUserScope(userId, (session) => deleteTool.handler({ preset_id: terse.presetId }, { userId, db: session }));
assert(deleted.deleted === true, 'delete_prompt_preset reports success for an owned preset');

const afterDelete = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(afterDelete.length === 1, 'the deleted preset no longer appears in get_prompt_presets');

if (process.exitCode) {
  console.error('\nprompt-presets verification FAILED');
  process.exit(1);
}
console.log('\nprompt-presets verification passed');
