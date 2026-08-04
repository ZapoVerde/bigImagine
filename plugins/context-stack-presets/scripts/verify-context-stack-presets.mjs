// Proves all four tools end to end through info/registerTools (the real loader contract) using a
// small stateful fake Postgres pool that simulates context_stack_presets/context_stack_slots
// across a sequence of calls — same style as plugins/prompt-presets's verify-prompt-presets.mjs.
// Also exercises assemblePromptStack directly (a pure function, no DB involved) and the
// migration's builtin-visibility RLS shape: own presets + builtins on get, builtins untouchable by
// update/delete regardless of caller.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';
import { assemblePromptStack } from '../dist/assemblePromptStack.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function createFakePool() {
  const presets = [];
  const slots = [];
  let counter = 0;
  let tick = 0;
  const nextUpdatedAt = () => `2026-08-04T00:00:${String(++tick).padStart(2, '0')}Z`;

  // Seed the two shipped builtins, same shape migration 0042's own `do $$ ... $$` block inserts —
  // direct array pushes, not through create_context_stack_preset, since bigbrain_admin (not
  // bigbrain_app) is what actually writes these in a real DB.
  const standardId = 'preset-standard';
  presets.push({ preset_id: standardId, user_id: SYSTEM_USER_ID, name: 'Standard', is_builtin: true, updated_at: nextUpdatedAt() });
  slots.push(
    { slot_id: 's1', preset_id: standardId, position: 0, slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null },
    { slot_id: 's2', preset_id: standardId, position: 1, slot_type: 'marker', marker_key: 'description', enabled: true, custom_role: null, custom_content: null },
    { slot_id: 's3', preset_id: standardId, position: 2, slot_type: 'marker', marker_key: 'recent_history', enabled: true, custom_role: null, custom_content: null },
  );
  const minimalId = 'preset-minimal';
  presets.push({ preset_id: minimalId, user_id: SYSTEM_USER_ID, name: 'Minimal', is_builtin: true, updated_at: nextUpdatedAt() });
  slots.push({ slot_id: 's4', preset_id: minimalId, position: 0, slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null });

  return {
    presets,
    slots,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.startsWith('insert into context_stack_presets')) {
            const [userId, name] = params;
            assert(scopedUserId === userId, 'create_context_stack_preset is scoped to the requesting user');
            const preset = {
              preset_id: `preset-${++counter}`,
              user_id: userId,
              name,
              is_builtin: false,
              updated_at: nextUpdatedAt(),
            };
            presets.push(preset);
            return { rows: [{ preset_id: preset.preset_id, name: preset.name, is_builtin: preset.is_builtin, updated_at: preset.updated_at }] };
          }

          if (sql.startsWith('insert into context_stack_slots')) {
            const [presetId, position, slotType, markerKey, enabled, customRole, customContent] = params;
            const parent = presets.find((p) => p.preset_id === presetId);
            assert(!!parent && parent.user_id === scopedUserId, 'insert into context_stack_slots is scoped to the owning preset\'s user');
            const row = { slot_id: `slot-${++counter}`, preset_id: presetId, position, slot_type: slotType, marker_key: markerKey, enabled, custom_role: customRole, custom_content: customContent };
            slots.push(row);
            return { rows: [{ slot_type: row.slot_type, marker_key: row.marker_key, enabled: row.enabled, custom_role: row.custom_role, custom_content: row.custom_content }] };
          }

          if (sql.startsWith('select preset_id, name, is_builtin, updated_at from context_stack_presets')) {
            // select_own_or_builtin: own rows plus every is_builtin row, regardless of owner.
            const visible = presets
              .filter((p) => p.user_id === scopedUserId || p.is_builtin)
              .slice()
              .sort((a, b) => (a.is_builtin === b.is_builtin ? (a.updated_at < b.updated_at ? 1 : -1) : a.is_builtin ? -1 : 1));
            return { rows: visible.map((p) => ({ preset_id: p.preset_id, name: p.name, is_builtin: p.is_builtin, updated_at: p.updated_at })) };
          }

          if (sql.startsWith('select preset_id, slot_type') && sql.includes('preset_id = any')) {
            const [presetIds] = params;
            const matches = slots
              .filter((s) => presetIds.includes(s.preset_id))
              .slice()
              .sort((a, b) => (a.preset_id === b.preset_id ? a.position - b.position : a.preset_id < b.preset_id ? -1 : 1));
            return { rows: matches.map(({ preset_id, slot_type, marker_key, enabled, custom_role, custom_content }) => ({ preset_id, slot_type, marker_key, enabled, custom_role, custom_content })) };
          }

          if (sql.startsWith('update context_stack_presets set')) {
            const [presetId, userId, ...rest] = params;
            assert(scopedUserId === userId, 'update_context_stack_preset is scoped to the requesting user');
            // update_own's RLS predicate: user_id = the caller — a builtin (owned by the system
            // user) or another user's preset simply doesn't match, same as a real Postgres policy.
            const preset = presets.find((p) => p.preset_id === presetId && p.user_id === userId);
            if (!preset) return { rows: [] };
            let i = 0;
            if (sql.includes('name = $')) preset.name = rest[i++];
            preset.updated_at = nextUpdatedAt();
            return { rows: [{ preset_id: preset.preset_id, name: preset.name, is_builtin: preset.is_builtin, updated_at: preset.updated_at }] };
          }

          if (sql.startsWith('delete from context_stack_slots where preset_id = $1')) {
            const [presetId] = params;
            for (let idx = slots.length - 1; idx >= 0; idx--) {
              if (slots[idx].preset_id === presetId) slots.splice(idx, 1);
            }
            return { rows: [] };
          }

          if (sql.startsWith('select slot_type, marker_key') && sql.includes('order by position')) {
            const [presetId] = params;
            const matches = slots.filter((s) => s.preset_id === presetId).slice().sort((a, b) => a.position - b.position);
            return { rows: matches.map(({ slot_type, marker_key, enabled, custom_role, custom_content }) => ({ slot_type, marker_key, enabled, custom_role, custom_content })) };
          }

          if (sql.startsWith('delete from context_stack_presets')) {
            const [presetId, userId] = params;
            assert(scopedUserId === userId, 'delete_context_stack_preset is scoped to the requesting user');
            const idx = presets.findIndex((p) => p.preset_id === presetId && p.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [deleted] = presets.splice(idx, 1);
            // on delete cascade, simulated here since the fake pool has no real FK enforcement.
            for (let i = slots.length - 1; i >= 0; i--) {
              if (slots[i].preset_id === deleted.preset_id) slots.splice(i, 1);
            }
            return { rows: [{ preset_id: deleted.preset_id }] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'context-stack-presets' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined });
assert(pluginTools.length === 4, 'registerTools returns exactly four tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_context_stack_preset', 'get_context_stack_presets', 'update_context_stack_preset', 'delete_context_stack_preset']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

const createTool = registry.get('create_context_stack_preset');
const getTool = registry.get('get_context_stack_presets');
const updateTool = registry.get('update_context_stack_preset');
const deleteTool = registry.get('delete_context_stack_preset');

// --- create_context_stack_preset ---
const custom = await db.withUserScope(userId, (session) =>
  createTool.handler(
    {
      name: 'Lore-Heavy',
      slots: [
        { slotType: 'marker', markerKey: 'description' },
        { slotType: 'custom', customRole: 'system', customContent: 'Stay in character no matter what.' },
        { slotType: 'marker', markerKey: 'recent_history' },
      ],
    },
    { userId, db: session },
  ),
);
assert(custom.name === 'Lore-Heavy' && custom.isBuiltin === false, 'create_context_stack_preset stores name and defaults isBuiltin to false');
assert(custom.slots.length === 3, 'create_context_stack_preset stores every slot in order');
assert(custom.slots[1].slotType === 'custom' && custom.slots[1].customContent === 'Stay in character no matter what.', 'create_context_stack_preset round-trips a custom slot');

const othersPreset = await db.withUserScope(otherUserId, (session) =>
  createTool.handler({ name: 'Not yours', slots: [{ slotType: 'marker', markerKey: 'system' }] }, { userId: otherUserId, db: session }),
);

// --- get_context_stack_presets ---
const mine = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(mine.length === 3, 'get_context_stack_presets returns the two builtins plus the caller\'s own preset');
assert(mine.filter((p) => p.isBuiltin).length === 2, 'both shipped builtins are visible to a user who never created them');
assert(!mine.some((p) => p.presetId === othersPreset.presetId), 'get_context_stack_presets does not leak another user\'s preset');
const standard = mine.find((p) => p.name === 'Standard');
assert(!!standard && standard.slots.length === 3, 'a builtin\'s full slot list comes back alongside it');

const thirdUserId = '33333333-3333-3333-3333-333333333333';
const noneOfMyOwn = await db.withUserScope(thirdUserId, (session) => getTool.handler({}, { userId: thirdUserId, db: session }));
assert(noneOfMyOwn.length === 2, 'a user with no presets of their own still sees exactly the two builtins');

// --- update_context_stack_preset ---
const updated = await db.withUserScope(userId, (session) =>
  updateTool.handler({ presetId: custom.presetId, name: 'Lore-Heavy v2', slots: [{ slotType: 'marker', markerKey: 'personality' }] }, { userId, db: session }),
);
assert(updated.found === true && updated.name === 'Lore-Heavy v2', 'update_context_stack_preset renames an owned preset');
assert(updated.slots.length === 1 && updated.slots[0].markerKey === 'personality', 'update_context_stack_preset replaces the whole slots array when slots is provided');

const renameOnly = await db.withUserScope(userId, (session) => updateTool.handler({ presetId: custom.presetId, name: 'Renamed Only' }, { userId, db: session }));
assert(renameOnly.slots.length === 1 && renameOnly.slots[0].markerKey === 'personality', 'update_context_stack_preset leaves slots untouched when slots is omitted');

const updateBuiltin = await db.withUserScope(userId, (session) => updateTool.handler({ presetId: standard.presetId, name: 'Hijacked' }, { userId, db: session }));
assert(updateBuiltin.found === false, 'update_context_stack_preset cannot rename a builtin preset');

const updateMissing = await db.withUserScope(userId, (session) => updateTool.handler({ presetId: 'does-not-exist', name: 'x' }, { userId, db: session }));
assert(updateMissing.found === false, 'update_context_stack_preset reports not-found for a missing preset rather than throwing');

// --- delete_context_stack_preset ---
const crossUserDelete = await db.withUserScope(userId, (session) => deleteTool.handler({ presetId: othersPreset.presetId }, { userId, db: session }));
assert(crossUserDelete.deleted === false, 'delete_context_stack_preset cannot delete another user\'s preset');

const deleteBuiltin = await db.withUserScope(userId, (session) => deleteTool.handler({ presetId: standard.presetId }, { userId, db: session }));
assert(deleteBuiltin.deleted === false, 'delete_context_stack_preset cannot delete a builtin preset');

const deleted = await db.withUserScope(userId, (session) => deleteTool.handler({ presetId: custom.presetId }, { userId, db: session }));
assert(deleted.deleted === true, 'delete_context_stack_preset reports success for an owned preset');

const afterDelete = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(afterDelete.length === 2, 'the deleted preset no longer appears in get_context_stack_presets, leaving only the two builtins');
assert(pool.slots.every((s) => s.preset_id !== custom.presetId), 'deleting a preset cascades to its own slot rows');

// --- assemblePromptStack (pure function, no DB) ---
const assembled = assemblePromptStack(
  { description: 'A quiet tavern.', recent_history: 'Ava: Welcome in.' },
  [
    { slotType: 'marker', markerKey: 'system', enabled: true },
    { slotType: 'marker', markerKey: 'description', enabled: true },
    { slotType: 'custom', enabled: true, customRole: 'system', customContent: 'Stay in character.' },
    { slotType: 'marker', markerKey: 'personality', enabled: true },
    { slotType: 'marker', markerKey: 'recent_history', enabled: false },
  ],
);
assert(assembled.length === 2, 'assemblePromptStack skips a marker slot with no matching field and a disabled slot');
assert(assembled[0].content === 'A quiet tavern.' && assembled[0].role === 'system', 'assemblePromptStack emits a marker slot\'s value under role system');
assert(assembled[1].role === 'system' && assembled[1].content === 'Stay in character.', 'assemblePromptStack emits a custom slot under its own chosen role');

if (process.exitCode) {
  console.error('\ncontext-stack-presets verification FAILED');
  process.exit(1);
}
console.log('\ncontext-stack-presets verification passed');
