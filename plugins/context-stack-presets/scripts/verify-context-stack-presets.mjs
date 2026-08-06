// Proves all four tools end to end through info/registerTools (the real loader contract) using a
// small stateful fake Postgres pool that simulates context_stack_presets/context_stack_slots
// across a sequence of calls — same style as plugins/prompt-presets's verify-prompt-presets.mjs.
// Also exercises assemblePromptStack (now a core util, orchestrator/scripts/verify-assemble-
// prompt-stack.mjs covers it in more depth) through this plugin's own apply_prompt_stack_to_chat
// caller, and the migration's builtin-visibility RLS shape: own presets + builtins on get,
// builtins untouchable by update/delete regardless of caller.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';
import { assemblePromptStack } from '@bigbrain/orchestrator/assemble-prompt-stack';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000';

function createFakeSettingsStore(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    async get(key) {
      return values.get(key);
    },
    async set(key, value) {
      values.set(key, value);
    },
  };
}

function createFakePool() {
  const presets = [];
  const slots = [];
  const characters = [];
  const chatSessions = [];
  const chatMessages = [];
  // users has no RLS of its own (0002's own comment) — just a plain array, one row per known test
  // user, each starting with no default prompt stack (migration 0061).
  const users = [
    { user_id: '11111111-1111-1111-1111-111111111111', default_context_stack_preset_id: null },
    { user_id: '22222222-2222-2222-2222-222222222222', default_context_stack_preset_id: null },
    { user_id: '33333333-3333-3333-3333-333333333333', default_context_stack_preset_id: null },
  ];
  let counter = 0;
  let tick = 0;
  const nextUpdatedAt = () => `2026-08-04T00:00:${String(++tick).padStart(2, '0')}Z`;

  // Seed the two shipped builtins, same shape migration 0042's own `do $$ ... $$` block inserts —
  // direct array pushes, not through create_context_stack_preset, since bigbrain_admin (not
  // bigbrain_app) is what actually writes these in a real DB.
  const standardId = 'preset-standard';
  presets.push({ preset_id: standardId, user_id: SYSTEM_USER_ID, name: 'Standard', is_builtin: true, updated_at: nextUpdatedAt() });
  slots.push(
    { slot_id: 's1', preset_id: standardId, position: 0, slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null, label: null },
    { slot_id: 's2', preset_id: standardId, position: 1, slot_type: 'marker', marker_key: 'description', enabled: true, custom_role: null, custom_content: null, label: null },
    { slot_id: 's3', preset_id: standardId, position: 2, slot_type: 'marker', marker_key: 'recent_history', enabled: true, custom_role: null, custom_content: null, label: null },
  );
  const minimalId = 'preset-minimal';
  presets.push({ preset_id: minimalId, user_id: SYSTEM_USER_ID, name: 'Minimal', is_builtin: true, updated_at: nextUpdatedAt() });
  slots.push({ slot_id: 's4', preset_id: minimalId, position: 0, slot_type: 'marker', marker_key: 'system', enabled: true, custom_role: null, custom_content: null, label: null });

  return {
    presets,
    slots,
    characters,
    chatSessions,
    chatMessages,
    users,
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
            const [presetId, position, slotType, markerKey, enabled, customRole, customContent, label] = params;
            const parent = presets.find((p) => p.preset_id === presetId);
            assert(!!parent && parent.user_id === scopedUserId, 'insert into context_stack_slots is scoped to the owning preset\'s user');
            const row = { slot_id: `slot-${++counter}`, preset_id: presetId, position, slot_type: slotType, marker_key: markerKey, enabled, custom_role: customRole, custom_content: customContent, label: label ?? null };
            slots.push(row);
            return { rows: [{ slot_type: row.slot_type, marker_key: row.marker_key, enabled: row.enabled, custom_role: row.custom_role, custom_content: row.custom_content, label: row.label }] };
          }

          if (sql.startsWith('select preset_id, name, is_builtin, updated_at from context_stack_presets')) {
            // select_own_or_builtin: own rows plus every is_builtin row, regardless of owner.
            const visible = presets
              .filter((p) => p.user_id === scopedUserId || p.is_builtin)
              .slice()
              .sort((a, b) => (a.is_builtin === b.is_builtin ? (a.updated_at < b.updated_at ? 1 : -1) : a.is_builtin ? -1 : 1));
            return { rows: visible.map((p) => ({ preset_id: p.preset_id, name: p.name, is_builtin: p.is_builtin, updated_at: p.updated_at })) };
          }

          if (sql.startsWith('select default_context_stack_preset_id from users')) {
            const [userId] = params;
            const user = users.find((u) => u.user_id === userId);
            return { rows: user ? [{ default_context_stack_preset_id: user.default_context_stack_preset_id }] : [] };
          }

          if (sql.startsWith('select preset_id from context_stack_presets where preset_id = $1')) {
            const [presetId, userId] = params;
            const match = presets.find((p) => p.preset_id === presetId && (p.user_id === userId || p.is_builtin));
            return { rows: match ? [{ preset_id: match.preset_id }] : [] };
          }

          if (sql.startsWith('update users set default_context_stack_preset_id')) {
            const [userId, presetId] = params;
            const user = users.find((u) => u.user_id === userId);
            if (user) user.default_context_stack_preset_id = presetId;
            return { rows: [] };
          }

          if (sql.startsWith('select preset_id, slot_type') && sql.includes('preset_id = any')) {
            const [presetIds] = params;
            const matches = slots
              .filter((s) => presetIds.includes(s.preset_id))
              .slice()
              .sort((a, b) => (a.preset_id === b.preset_id ? a.position - b.position : a.preset_id < b.preset_id ? -1 : 1));
            return { rows: matches.map(({ preset_id, slot_type, marker_key, enabled, custom_role, custom_content, label }) => ({ preset_id, slot_type, marker_key, enabled, custom_role, custom_content, label })) };
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
            return { rows: matches.map(({ slot_type, marker_key, enabled, custom_role, custom_content, label }) => ({ slot_type, marker_key, enabled, custom_role, custom_content, label })) };
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

          if (sql.startsWith('select params, character_id from chat_sessions')) {
            const [chatId, userId] = params;
            const chat = chatSessions.find((c) => c.chat_id === chatId && c.user_id === userId);
            return { rows: chat ? [{ params: chat.params, character_id: chat.character_id }] : [] };
          }

          if (sql.startsWith('select system_prompt, persona, scenario, example_dialogue, greetings from characters')) {
            const [characterId, userId] = params;
            const character = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            return {
              rows: character
                ? [{
                    system_prompt: character.system_prompt,
                    persona: character.persona,
                    scenario: character.scenario,
                    example_dialogue: character.example_dialogue,
                    greetings: character.greetings,
                  }]
                : [],
            };
          }

          if (sql.startsWith('update chat_sessions set params')) {
            const [chatId, paramsJson, presetId] = params;
            const chat = chatSessions.find((c) => c.chat_id === chatId);
            if (chat) {
              chat.params = JSON.parse(paramsJson);
              chat.prompt_stack_preset_id = presetId;
            }
            return { rows: [] };
          }

          if (sql.startsWith('select count(*)::text as count from chat_messages')) {
            const [chatId] = params;
            const count = chatMessages.filter((m) => m.chat_id === chatId).length;
            return { rows: [{ count: String(count) }] };
          }

          if (sql.startsWith('insert into chat_messages')) {
            const [chatId, userId, role, content] = params;
            chatMessages.push({ chat_id: chatId, user_id: userId, role, content });
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

assert(info.id === 'context-stack-presets' && /^[a-z0-9_-]+$/.test(info.id), 'info.id is present and matches the required format');

const fakeSettings = createFakeSettingsStore();
const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined, settings: fakeSettings });
assert(pluginTools.length === 6, 'registerTools returns exactly six tools');

const registry = createToolRegistry(pluginTools);
for (const name of [
  'create_context_stack_preset',
  'get_context_stack_presets',
  'update_context_stack_preset',
  'delete_context_stack_preset',
  'apply_prompt_stack_to_chat',
  'set_default_context_stack_preset',
]) {
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

// --- apply_prompt_stack_to_chat (docs/prompt-macros.md's Stage 1: the 'persona' marker) ---
const applyTool = registry.get('apply_prompt_stack_to_chat');

const presetWithPersona = await db.withUserScope(userId, (session) =>
  createTool.handler(
    {
      name: 'RP Standard',
      slots: [
        { slotType: 'marker', markerKey: 'system' },
        { slotType: 'marker', markerKey: 'description' },
        { slotType: 'marker', markerKey: 'persona' },
      ],
    },
    { userId, db: session },
  ),
);

pool.characters.push({
  character_id: 'char-1',
  user_id: userId,
  system_prompt: 'You are a helpful narrator.',
  persona: 'A grizzled tavern keeper.',
  scenario: 'A dusty roadside inn.',
  example_dialogue: '',
  greetings: ['Welcome, traveler.'],
});
pool.chatSessions.push({ chat_id: 'chat-1', user_id: userId, character_id: 'char-1', params: {}, prompt_stack_preset_id: null });

const appliedNoPersona = await db.withUserScope(userId, (session) =>
  applyTool.handler({ chatId: 'chat-1', presetId: presetWithPersona.presetId }, { userId, db: session }),
);
assert(appliedNoPersona.applied === true, 'apply_prompt_stack_to_chat applies a preset to a linked chat');
assert(appliedNoPersona.systemText.includes('You are a helpful narrator.'), 'apply_prompt_stack_to_chat includes the character system prompt');
assert(appliedNoPersona.systemText.includes('A grizzled tavern keeper.'), "apply_prompt_stack_to_chat maps character.persona onto the description marker (character.persona is the card's own field, not the household's)");
assert(!appliedNoPersona.systemText.includes('Jeremy'), 'apply_prompt_stack_to_chat skips the persona marker when persona_name/persona_description are unset');
assert(appliedNoPersona.greetingInserted === true, 'apply_prompt_stack_to_chat seeds the first greeting on a chat with no messages');

const reapplied = await db.withUserScope(userId, (session) =>
  applyTool.handler({ chatId: 'chat-1', presetId: presetWithPersona.presetId }, { userId, db: session }),
);
assert(reapplied.greetingInserted === false, 'apply_prompt_stack_to_chat does not re-seed a greeting once the chat has messages');

await fakeSettings.set('persona_name', 'Jeremy');
await fakeSettings.set('persona_description', 'A software engineer who likes concise answers.');
pool.chatSessions.push({ chat_id: 'chat-2', user_id: userId, character_id: 'char-1', params: {}, prompt_stack_preset_id: null });

const appliedWithPersona = await db.withUserScope(userId, (session) =>
  applyTool.handler({ chatId: 'chat-2', presetId: presetWithPersona.presetId }, { userId, db: session }),
);
assert(
  appliedWithPersona.systemText.includes('Jeremy: A software engineer who likes concise answers.'),
  'apply_prompt_stack_to_chat folds household persona_name/persona_description into the persona marker once both are set',
);

// --- set_default_context_stack_preset (migration 0061) ---
const setDefaultTool = registry.get('set_default_context_stack_preset');

const setOwnDefault = await db.withUserScope(userId, (session) =>
  setDefaultTool.handler({ presetId: presetWithPersona.presetId }, { userId, db: session }),
);
assert(setOwnDefault.set === true, 'set_default_context_stack_preset accepts an owned preset');

const afterSetOwn = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(
  afterSetOwn.find((p) => p.presetId === presetWithPersona.presetId)?.isDefault === true,
  'get_context_stack_presets reports isDefault: true for the preset just marked default',
);
assert(
  afterSetOwn.filter((p) => p.isDefault).length === 1,
  'get_context_stack_presets reports isDefault: true for at most one preset',
);

const setBuiltinDefault = await db.withUserScope(userId, (session) =>
  setDefaultTool.handler({ presetId: standard.presetId }, { userId, db: session }),
);
assert(setBuiltinDefault.set === true, 'set_default_context_stack_preset accepts a shared builtin, not just an owned preset');
const afterSetBuiltin = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(
  afterSetBuiltin.find((p) => p.presetId === standard.presetId)?.isDefault === true &&
    afterSetBuiltin.find((p) => p.presetId === presetWithPersona.presetId)?.isDefault === false,
  'marking a new default replaces the previous one rather than stacking',
);

const setCrossUserDefault = await db.withUserScope(otherUserId, (session) =>
  setDefaultTool.handler({ presetId: presetWithPersona.presetId }, { userId: otherUserId, db: session }),
);
assert(setCrossUserDefault.set === false, "set_default_context_stack_preset rejects another user's preset (not owned, not builtin)");
const otherUserPresets = await db.withUserScope(otherUserId, (session) => getTool.handler({}, { userId: otherUserId, db: session }));
assert(otherUserPresets.every((p) => !p.isDefault), "a rejected set leaves the other user's own default untouched (still none)");

const clearedDefault = await db.withUserScope(userId, (session) => setDefaultTool.handler({}, { userId, db: session }));
assert(clearedDefault.set === true && clearedDefault.presetId === null, 'set_default_context_stack_preset with no presetId clears the default');
const afterClear = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(afterClear.every((p) => !p.isDefault), 'no preset reports isDefault: true once cleared');

if (process.exitCode) {
  console.error('\ncontext-stack-presets verification FAILED');
  process.exit(1);
}
console.log('\ncontext-stack-presets verification passed');
