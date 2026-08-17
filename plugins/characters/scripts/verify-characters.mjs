// Proves the characters plugin's tools end to end through info/registerTools (the real loader
// contract) using a small stateful fake Postgres pool simulating characters/chat_sessions/
// chat_messages, plus a real (temp-dir) filesystem for avatarStorage.ts — same style as
// verify-notes.mjs. BIGBRAIN_CHARACTER_MEDIA_DIR must be set (see package.json's verify script)
// before ../dist/index.js is ever imported, since avatarStorage.ts reads it at module load time.

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

// A minimal valid 1x1 transparent PNG — stands in for a real uploaded card image.
const BLANK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

function createFakePool() {
  const characters = [];
  const chatSessions = [];
  const chatMessages = [];
  const chatMessageSwipes = [];
  const characterChatLinks = []; // {character_id, chat_id, anchor_swipe_id} (migration 0096)
  const lorebooks = [];
  const lorebookEntries = [];
  const lorebookLinks = [];
  let counter = 0;

  return {
    characters,
    chatSessions,
    chatMessages,
    chatMessageSwipes,
    characterChatLinks,
    lorebooks,
    lorebookEntries,
    lorebookLinks,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          // --- create_character ---
          if (sql.startsWith('insert into characters') && !sql.includes('spec_version')) {
            const [userId, name, persona, appearance, scenario, systemPrompt, exampleDialogue, greetings] = params;
            assert(scopedUserId === userId, 'create_character is scoped to the requesting user');
            const row = {
              character_id: `char-${++counter}`,
              user_id: userId,
              name,
              persona,
              appearance,
              scenario,
              system_prompt: systemPrompt,
              example_dialogue: exampleDialogue,
              greetings: JSON.parse(greetings),
              spec_version: 'v2',
              source_json: null,
              avatar_path: null,
              status: null, // user-authored (create_character leaves the lifecycle column unset)
            };
            characters.push(row);
            return { rows: [{ character_id: row.character_id, name: row.name }] };
          }

          // --- import_character_card ---
          if (sql.startsWith('insert into characters') && sql.includes('spec_version')) {
            const [userId, name, persona, scenario, systemPrompt, exampleDialogue, greetings, specVersion, sourceJson, avatarPath] = params;
            assert(scopedUserId === userId, 'import_character_card is scoped to the requesting user');
            const row = {
              character_id: `char-${++counter}`,
              user_id: userId,
              name,
              persona,
              scenario,
              system_prompt: systemPrompt,
              example_dialogue: exampleDialogue,
              greetings: JSON.parse(greetings),
              spec_version: specVersion,
              source_json: JSON.parse(sourceJson),
              avatar_path: avatarPath,
              status: null, // user-authored (import writes no status, matching the column default)
            };
            characters.push(row);
            return { rows: [{ character_id: row.character_id, name: row.name }] };
          }

          // --- import_character_card: embedded lorebook (§A of chub-lorebook-import-plan.md) ---
          if (sql.startsWith('insert into lorebooks')) {
            const [userId, name] = params;
            assert(scopedUserId === userId, 'the embedded lorebook insert is scoped to the requesting user');
            const row = { lorebook_id: `lb-${++counter}`, user_id: userId, name, global_scope: false };
            lorebooks.push(row);
            return { rows: [{ lorebook_id: row.lorebook_id }] };
          }
          if (sql.startsWith('insert into lorebook_entries')) {
            assert(scopedUserId === params[1], 'the lorebook entry insert is scoped to the requesting user');
            lorebookEntries.push({ sql, params });
            return { rows: [] };
          }
          if (sql.startsWith('insert into lorebook_character_links')) {
            const [lorebookId, characterId, userId] = params;
            assert(scopedUserId === userId, 'the character-link insert is scoped to the requesting user');
            lorebookLinks.push({ lorebook_id: lorebookId, character_id: characterId, user_id: userId });
            return { rows: [] };
          }

          // --- get_characters ---
          if (sql.startsWith('select character_id, name from characters')) {
            const [userId, chatId] = params;
            assert(scopedUserId === userId, 'get_characters is scoped to the requesting user');
            // db/migrations/0096 eligibility: user-authored (status null) is always eligible; an
            // auto-registered row is eligible only when linked to the calling chat and not
            // demoted to inactive (null chat -> no auto-registered row ever matches). The
            // castOnly=true query (rp-cast-library-repair.md Part A) drops the status-null
            // carve-out — the SQL text is the only signal of which shape this call is.
            const castOnly = sql.includes('status is not null');
            const eligible = (c) =>
              castOnly
                ? c.status !== null &&
                  c.status !== 'inactive' &&
                  characterChatLinks.some((link) => link.character_id === c.character_id && link.chat_id === chatId)
                : c.status === null ||
                  (c.status !== 'inactive' &&
                    characterChatLinks.some((link) => link.character_id === c.character_id && link.chat_id === chatId));
            const rows = characters
              .filter((c) => c.user_id === userId && eligible(c))
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((c) => ({ character_id: c.character_id, name: c.name }));
            return { rows };
          }

          // --- get_character ---
          if (sql.startsWith('select character_id, name, persona')) {
            const [characterId, userId, chatId] = params;
            assert(scopedUserId === userId, 'get_character is scoped to the requesting user');
            const eligible = (c) =>
              c.status === null ||
              (c.status !== 'inactive' && characterChatLinks.some((link) => link.character_id === c.character_id && link.chat_id === chatId));
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId && eligible(c));
            if (!row) return { rows: [] };
            return {
              rows: [
                {
                  character_id: row.character_id,
                  name: row.name,
                  persona: row.persona,
                  appearance: row.appearance,
                  scenario: row.scenario,
                  system_prompt: row.system_prompt,
                  example_dialogue: row.example_dialogue,
                  greetings: row.greetings,
                  spec_version: row.spec_version,
                  has_avatar: row.avatar_path !== null,
                  has_source_json: row.source_json !== null,
                  created_at: '2026-08-05T00:00:00Z',
                  updated_at: '2026-08-05T00:00:00Z',
                },
              ],
            };
          }

          // --- update_character ---
          if (sql.startsWith('update characters set')) {
            const [characterId, userId, ...rest] = params;
            assert(scopedUserId === userId, 'update_character is scoped to the requesting user');
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            if (!row) return { rows: [] };
            // The tool appends patched fields to `sets` (and therefore params) in a fixed order
            // whenever present — mirror that order here to know which value is which.
            const fieldOrder = ['name', 'persona', 'appearance', 'scenario', 'system_prompt', 'example_dialogue', 'greetings'];
            const patchedFields = fieldOrder.filter((f) => sql.includes(`${f} = $`));
            patchedFields.forEach((field, i) => {
              row[field] = field === 'greetings' ? JSON.parse(rest[i]) : rest[i];
            });
            return { rows: [{ character_id: row.character_id, name: row.name }] };
          }

          // --- delete_character ---
          if (sql.startsWith('delete from characters')) {
            const [characterId, userId] = params;
            assert(scopedUserId === userId, 'delete_character is scoped to the requesting user');
            const idx = characters.findIndex((c) => c.character_id === characterId && c.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [removed] = characters.splice(idx, 1);
            // Emulate the real FK: chat_sessions.character_id is ON DELETE SET NULL (0049), so
            // deleting a character nulls the link on its chats. The tool must purge the chats
            // BEFORE this delete or its purge query matches nothing.
            for (const c of chatSessions) {
              if (c.character_id === removed.character_id) c.character_id = null;
            }
            return { rows: [{ character_id: removed.character_id }] };
          }

          // --- delete_character: purge the character's chats (their ids come back so the
          // client can close open tabs for them) ---
          if (sql.startsWith('delete from chat_sessions') && sql.includes('character_id')) {
            const [characterId, userId] = params;
            assert(scopedUserId === userId, "delete_character's chat purge is scoped to the requesting user");
            const removed = chatSessions.filter((c) => c.character_id === characterId && c.user_id === userId);
            for (const row of removed) {
              const i = chatSessions.indexOf(row);
              if (i !== -1) chatSessions.splice(i, 1);
            }
            return { rows: removed.map((c) => ({ chat_id: c.chat_id })) };
          }

          // --- export_character_card ---
          if (sql.startsWith('select name, persona, scenario, system_prompt, example_dialogue, greetings, source_json')) {
            const [characterId, userId] = params;
            assert(scopedUserId === userId, 'export_character_card is scoped to the requesting user');
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            if (!row) return { rows: [] };
            return {
              rows: [
                {
                  name: row.name,
                  persona: row.persona,
                  scenario: row.scenario,
                  system_prompt: row.system_prompt,
                  example_dialogue: row.example_dialogue,
                  greetings: row.greetings,
                  source_json: row.source_json,
                  has_avatar: row.avatar_path !== null,
                },
              ],
            };
          }

          // --- get_character_avatar ---
          if (sql.startsWith('select avatar_path is not null as has_avatar')) {
            const [characterId, userId] = params;
            assert(scopedUserId === userId, 'get_character_avatar is scoped to the requesting user');
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            return { rows: row ? [{ has_avatar: row.avatar_path !== null }] : [] };
          }

          // --- apply_character_to_chat: character read ---
          if (sql.startsWith('select name, persona, scenario, system_prompt, example_dialogue, greetings from characters')) {
            const [characterId, userId] = params;
            assert(scopedUserId === userId, "apply_character_to_chat's character lookup is scoped to the requesting user");
            const row = characters.find((c) => c.character_id === characterId && c.user_id === userId);
            if (!row) return { rows: [] };
            return {
              rows: [
                {
                  name: row.name,
                  persona: row.persona,
                  scenario: row.scenario,
                  system_prompt: row.system_prompt,
                  example_dialogue: row.example_dialogue,
                  greetings: row.greetings,
                },
              ],
            };
          }

          // --- apply_character_to_chat: chat lookup ---
          if (sql.startsWith('select params from chat_sessions')) {
            const [chatId, userId] = params;
            assert(scopedUserId === userId, "apply_character_to_chat's chat lookup is scoped to the requesting user");
            const row = chatSessions.find((c) => c.chat_id === chatId && c.user_id === userId);
            return { rows: row ? [{ params: row.params }] : [] };
          }

          // --- apply_character_to_chat: params write ---
          if (sql.startsWith('update chat_sessions set params')) {
            const [chatId, paramsJson] = params;
            // RLS-equivalent: only a row this connection is scoped to is visible to update, even
            // though the statement itself carries no explicit user_id predicate (same shape
            // orchestrator/src/io/chatSessions.ts's own updateChat uses).
            const row = chatSessions.find((c) => c.chat_id === chatId && c.user_id === scopedUserId);
            if (row) row.params = JSON.parse(paramsJson);
            return { rows: [] };
          }

          // --- apply_character_to_chat: message count ---
          if (sql.startsWith('select count(*)::text as count from chat_messages')) {
            const [chatId] = params;
            const count = chatMessages.filter((m) => m.chat_id === chatId && m.user_id === scopedUserId).length;
            return { rows: [{ count: String(count) }] };
          }

          // --- apply_character_to_chat: greeting insert ---
          if (sql.startsWith('insert into chat_messages')) {
            const [chatId, userId, role, content] = params;
            assert(scopedUserId === userId, "apply_character_to_chat's greeting insert is scoped to the requesting user");
            const messageId = `msg-${++counter}`;
            chatMessages.push({ message_id: messageId, chat_id: chatId, user_id: userId, role, content, active_swipe_id: null });
            return { rows: [{ message_id: messageId }] };
          }

          // --- apply_character_to_chat: alternate-greeting swipe insert ---
          if (sql.startsWith('insert into chat_message_swipes')) {
            const [messageId, content] = params;
            const swipeId = `swipe-${++counter}`;
            chatMessageSwipes.push({ swipe_id: swipeId, message_id: messageId, content });
            return { rows: [{ swipe_id: swipeId }] };
          }

          // --- apply_character_to_chat: active-swipe pointer ---
          if (sql.startsWith('update chat_messages set active_swipe_id')) {
            const [activeSwipeId, messageId] = params;
            const row = chatMessages.find((m) => m.message_id === messageId);
            if (row) row.active_swipe_id = activeSwipeId;
            return { rows: [] };
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
assert(pluginTools.length === 11, 'registerTools returns exactly eleven tools');

const registry = createToolRegistry(pluginTools);
const EXPECTED_TOOL_NAMES = [
  'create_character',
  'get_characters',
  'get_character',
  'update_character',
  'delete_character',
  'import_character_card',
  'import_character_card_from_url',
  'search_chub_characters',
  'export_character_card',
  'get_character_avatar',
  'apply_character_to_chat',
];
for (const name of EXPECTED_TOOL_NAMES) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const otherUserId = '22222222-2222-2222-2222-222222222222';

// Embeddings stub (chub-lorebook-embed-repair.md): the import tools read ctx.embeddings now, and
// the embedded-lorebook test asserts the entries land with non-null vectors. A card without a
// character_book must never call embed — track that too.
const embedCalls = [];
const stubEmbeddings = {
  name: 'stub',
  dimension: 4,
  async embed(texts) {
    embedCalls.push(texts);
    return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
  },
};

const createTool = registry.get('create_character');
const getTool = registry.get('get_characters');
const getOneTool = registry.get('get_character');
const updateTool = registry.get('update_character');
const deleteTool = registry.get('delete_character');
const importTool = registry.get('import_character_card');
const exportTool = registry.get('export_character_card');
const avatarTool = registry.get('get_character_avatar');
const applyTool = registry.get('apply_character_to_chat');

// --- create_character ---
const elara = await db.withUserScope(userId, (session) =>
  createTool.handler(
    { name: 'Elara', persona: 'A stern but fair knight-commander.', appearance: 'Tall, with steel-grey eyes and a scarred jaw.', greetings: ['You again.'] },
    { userId, db: session },
  ),
);
assert(elara.characterId.length > 0 && elara.name === 'Elara', 'create_character returns the new character id and name');
assert(pool.characters.find((c) => c.character_id === elara.characterId)?.appearance === 'Tall, with steel-grey eyes and a scarred jaw.', 'create_character stores the optional appearance field');

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

// --- get_character ---
const elaraDetail = await db.withUserScope(userId, (session) =>
  getOneTool.handler({ characterId: elara.characterId }, { userId, db: session }),
);
assert(elaraDetail.found && elaraDetail.name === 'Elara' && elaraDetail.persona.includes('stern'), 'get_character returns the full detail row');
assert(elaraDetail.appearance === 'Tall, with steel-grey eyes and a scarred jaw.', 'get_character returns the appearance field');
assert(elaraDetail.hasSourceJson === false, 'a manually-created character has no source_json');

const notFoundDetail = await db.withUserScope(userId, (session) =>
  getOneTool.handler({ characterId: otherUsersChar.characterId }, { userId, db: session }),
);
assert(notFoundDetail.found === false, "get_character can't see another user's character");

// --- db/migrations/0096: chat-linkage eligibility, and inactive is never model-visible ----------
{
  const chatId = 'chat-live';
  const otherChatId = 'chat-other';
  const inactiveChar = await db.withUserScope(userId, (session) =>
    createTool.handler({ name: 'Goblin Merchant' }, { userId, db: session }),
  );
  const transientChar = await db.withUserScope(userId, (session) =>
    createTool.handler({ name: 'Night Guard' }, { userId, db: session }),
  );
  // Simulate the scraper's lifecycle: one demoted to inactive but still linked to the chat, one
  // transient and linked to the chat via character_chat_links (migration 0096).
  const inactiveRow = pool.characters.find((c) => c.character_id === inactiveChar.characterId);
  inactiveRow.status = 'inactive';
  pool.characterChatLinks.push({ character_id: inactiveChar.characterId, chat_id: chatId, anchor_swipe_id: 'swipe-dead' });
  const transientRow = pool.characters.find((c) => c.character_id === transientChar.characterId);
  transientRow.status = 'transient';
  pool.characterChatLinks.push({ character_id: transientChar.characterId, chat_id: chatId, anchor_swipe_id: 'swipe-live' });

  const withoutChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
  assert(
    !withoutChat.some((c) => c.characterId === inactiveChar.characterId) && !withoutChat.some((c) => c.characterId === transientChar.characterId),
    'with no chat context, an inactive and a chat-linked transient character are both excluded',
  );

  const inChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session, chatId }));
  assert(
    inChat.some((c) => c.characterId === transientChar.characterId) && !inChat.some((c) => c.characterId === inactiveChar.characterId),
    'a transient character linked to the calling chat is surfaced; an inactive one never is, even when linked',
  );

  const inOtherChat = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session, chatId: otherChatId }));
  assert(
    !inOtherChat.some((c) => c.characterId === transientChar.characterId),
    "a transient character linked to a DIFFERENT chat is not surfaced — chat-scoping's core invariant",
  );

  // rp-cast-library-repair.md Part A — castOnly: true is the RP Cast section's internal
  // frontend↔handler contract (deliberately NOT in definition.parameters). It must surface only
  // this chat's linked auto-registered characters, never the user's card library (status null).
  const castOnlyInChat = await db.withUserScope(userId, (session) =>
    getTool.handler({ castOnly: true }, { userId, db: session, chatId }),
  );
  assert(
    castOnlyInChat.length === 1 && castOnlyInChat[0].characterId === transientChar.characterId,
    'castOnly: true surfaces only the chat-linked auto-registered character — user-authored cards and inactive rows are excluded',
  );

  const castOnlyNoChat = await db.withUserScope(userId, (session) =>
    getTool.handler({ castOnly: true }, { userId, db: session }),
  );
  assert(castOnlyNoChat.length === 0, 'castOnly: true with no chat context returns an empty list');

  const castOnlyFalse = await db.withUserScope(userId, (session) =>
    getTool.handler({ castOnly: false }, { userId, db: session, chatId }),
  );
  assert(
    castOnlyFalse.some((c) => c.characterId === elara.characterId) &&
      castOnlyFalse.some((c) => c.characterId === transientChar.characterId),
    'castOnly: false behaves exactly like today — user-authored cards and chat-linked auto-registered rows both surface',
  );

  const castOnlyMalformed = await db.withUserScope(userId, (session) =>
    getTool.handler({ castOnly: 'yes' }, { userId, db: session, chatId }),
  );
  assert(
    castOnlyMalformed.some((c) => c.characterId === elara.characterId) &&
      castOnlyMalformed.some((c) => c.characterId === transientChar.characterId),
    'a non-boolean castOnly is treated as false — the full-library behavior is preserved, never throwing',
  );

  const inactiveDetail = await db.withUserScope(userId, (session) =>
    getOneTool.handler({ characterId: inactiveChar.characterId }, { userId, db: session, chatId }),
  );
  assert(inactiveDetail.found === false, 'get_character reports not-found for an inactive character, even when linked to the calling chat');
  const transientDetail = await db.withUserScope(userId, (session) =>
    getOneTool.handler({ characterId: transientChar.characterId }, { userId, db: session, chatId }),
  );
  assert(transientDetail.found === true, 'get_character returns an eligible transient character when called with chat context');
}

// --- update_character ---
const updated = await db.withUserScope(userId, (session) =>
  updateTool.handler(
    { characterId: elara.characterId, scenario: 'A besieged keep at dawn.', appearance: 'Tall, with grey eyes and a fresh scar.' },
    { userId, db: session },
  ),
);
assert(updated.found, 'update_character finds and patches an owned character');
const afterUpdate = await db.withUserScope(userId, (session) =>
  getOneTool.handler({ characterId: elara.characterId }, { userId, db: session }),
);
assert(afterUpdate.scenario === 'A besieged keep at dawn.', 'update_character actually persisted the patched field');
assert(afterUpdate.appearance === 'Tall, with grey eyes and a fresh scar.', 'update_character patches the appearance field');
assert(afterUpdate.name === 'Elara', "update_character leaves fields that weren't patched alone");

const updateOtherUsers = await db.withUserScope(userId, (session) =>
  updateTool.handler({ characterId: otherUsersChar.characterId, name: 'Hijacked' }, { userId, db: session }),
);
assert(updateOtherUsers.found === false, "update_character can't patch another user's character");

// --- import_character_card: PNG with an embedded card ---
const { encodePngCard } = await import('../dist/cardCodec.js');
const cardJson = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Bram',
    description: 'A gruff blacksmith.',
    personality: '',
    scenario: 'A forge at dusk.',
    first_mes: 'What do you want?',
    alternate_greetings: [],
    mes_example: '',
    system_prompt: '',
  },
});
const bramPng = encodePngCard(BLANK_PNG, cardJson);
const importedPng = await db.withUserScope(userId, (session) =>
  importTool.handler({ filename: 'bram.png', fileBase64: bramPng.toString('base64') }, { userId, db: session, embeddings: stubEmbeddings }),
);
assert(importedPng.name === 'Bram' && importedPng.hasAvatar === true, 'import_character_card reads a card embedded in a PNG and flags it as having an avatar');

const bramDetail = await db.withUserScope(userId, (session) =>
  getOneTool.handler({ characterId: importedPng.characterId }, { userId, db: session }),
);
assert(bramDetail.hasSourceJson === true, 'a card imported from a PNG keeps its exact source_json');
assert(bramDetail.scenario === 'A forge at dusk.', 'import_character_card parses the embedded card JSON into the row');

// --- import_character_card: raw JSON (no avatar) ---
const importedJson = await db.withUserScope(userId, (session) =>
  importTool.handler(
    { filename: 'plain.json', fileBase64: Buffer.from(JSON.stringify({ name: 'Plain', description: 'Just text.' })).toString('base64') },
    { userId, db: session, embeddings: stubEmbeddings },
  ),
);
assert(importedJson.hasAvatar === false, 'importing a raw JSON card (no PNG bytes) has no avatar');
assert(importedJson.lorebookEntriesImported === 0, 'a card with no character_book imports zero lorebook entries');
assert(pool.lorebooks.length === 0 && pool.lorebookLinks.length === 0, 'a card with no character_book writes no lorebook rows at all');
assert(embedCalls.length === 0, 'a card with no character_book never calls the embeddings provider (strict no-op)');

// --- import_character_card: embedded lorebook (§A of chub-lorebook-import-plan.md) ---
const lorebookCardJson = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Hollow',
    description: 'A knight of the ash.',
    character_book: {
      name: "Hollow's Oath",
      description: 'The oath and its broken pieces.',
      scan_depth: 3,
      token_budget: 1024,
      recursive_scanning: true,
      entries: [
        {
          id: 7,
          keys: ['oath', 'ash'],
          secondary_keys: ['vow'],
          comment: 'The oath',
          content: 'An oath sworn in ash.',
          constant: false,
          selective: true,
          enabled: true,
          insertion_order: 5,
          position: 'before_char',
          case_sensitive: true,
        },
        { keys: ['Hollow'], content: 'A silent knight.', enabled: false, position: 'after_char' },
      ],
    },
  },
});
const importedBook = await db.withUserScope(userId, (session) =>
  importTool.handler(
    { filename: 'hollow.json', fileBase64: Buffer.from(lorebookCardJson).toString('base64') },
    { userId, db: session, embeddings: stubEmbeddings },
  ),
);
assert(importedBook.lorebookEntriesImported === 2, 'a card with a character_book reports its imported entry count');
assert(embedCalls.length === 1 && embedCalls[0].length === 2, 'the two entries are embedded in one batched call');
assert(embedCalls[0][0] === "Hollow's Oath\nAn oath sworn in ash.", 'entries embed as `${bookName}\n${content}` (same convention as quickAddLorebookEntry / the ST importer)');
assert(pool.lorebooks.length === 1, 'the embedded book becomes exactly one lorebooks row');
assert(pool.lorebooks[0].name === "Hollow's Oath" && pool.lorebooks[0].global_scope === false, 'the book takes character_book.name and is character-scoped, not global');
const entryParams = pool.lorebookEntries.flatMap((e) => e.params);
assert(pool.lorebookEntries.length === 1 && entryParams.length === 46, 'both drafts land in one bulk insert (23 columns × 2 entries)');
assert(entryParams[2] === 7 && entryParams[25] === 0, 'entry ids map to uid; missing ids synthesize sequentially (0 here)');
assert(entryParams[3].join() === 'oath,ash' && entryParams[26].join() === 'Hollow', 'keys map to the key column');
assert(entryParams[5] === 'The oath' && entryParams[28] === '', 'comment maps through (blank comment for the entry without one)');
assert(entryParams[9] === false && entryParams[32] === true, '!enabled → disable (first entry enabled, second disabled)');
assert(entryParams[10] === 5 && entryParams[33] === 100, 'insertion_order maps to order_value; default 100 when absent');
assert(entryParams[11] === 0 && entryParams[34] === 1, "position maps 'before_char'→0 and 'after_char'→1");
const firstEntrySource = JSON.parse(entryParams[21]);
assert(firstEntrySource.case_sensitive === true, 'the verbatim entry (incl. case_sensitive) survives in source_json');
assert(firstEntrySource.scan_depth === undefined && firstEntrySource.token_budget === undefined, 'book-level settings are not folded into entry source_json (they stay book-level, source_json-only)');
assert(entryParams[22].startsWith('[') && entryParams[45].startsWith('['), 'each entry lands with a non-null vector_embed (recallable, not permanently undiscoverable)');
assert(pool.lorebookLinks.length === 1, 'the new book is linked to the new character');
assert(pool.lorebookLinks[0].character_id === importedBook.characterId, 'the character link points at the just-inserted character');

// --- import_character_card: fail-open when the embeddings provider throws ---
// (chub-lorebook-embed-repair.md): a card must still import — character, lorebook rows, and link —
// with all entries at vector_embed = null, never hard-fail over an embedding hiccup.
const throwingEmbeddings = {
  name: 'throwing',
  dimension: 4,
  async embed() {
    throw new Error('embedding service down');
  },
};
const failOpenCardJson = JSON.stringify({
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Failopen',
    description: 'A card whose embed call fails.',
    character_book: { name: 'Failopen Book', entries: [{ keys: ['x'], content: 'X.' }] },
  },
});
const preBooks = pool.lorebooks.length;
const preLinks = pool.lorebookLinks.length;
const failOpenBook = await db.withUserScope(userId, (session) =>
  importTool.handler(
    { filename: 'failopen.json', fileBase64: Buffer.from(failOpenCardJson).toString('base64') },
    { userId, db: session, embeddings: throwingEmbeddings },
  ),
);
assert(failOpenBook.lorebookEntriesImported === 1, 'a card whose embed throws still reports its imported entry count');
assert(pool.lorebooks.length === preBooks + 1 && pool.lorebookLinks.length === preLinks + 1, 'the book and its character link still land when embedding fails');
const failOpenParams = pool.lorebookEntries[pool.lorebookEntries.length - 1].params;
assert(failOpenParams[22] === null, 'a failed embed call leaves vector_embed = null (fail-open, never a thrown import)');

let importThrew = false;
try {
  await db.withUserScope(userId, (session) =>
    importTool.handler({ filename: 'garbage.json', fileBase64: Buffer.from('not json').toString('base64') }, { userId, db: session, embeddings: stubEmbeddings }),
  );
} catch {
  importThrew = true;
}
assert(importThrew, 'import_character_card rejects a file that is neither a card PNG nor valid JSON');

// --- export_character_card ---
const exportedJson = await db.withUserScope(userId, (session) =>
  exportTool.handler({ characterId: importedPng.characterId, format: 'json' }, { userId, db: session }),
);
assert(exportedJson.found && exportedJson.json.data.name === 'Bram', 'export_character_card (json) returns the exact source_json for an imported card');

const exportedPng = await db.withUserScope(userId, (session) =>
  exportTool.handler({ characterId: importedPng.characterId, format: 'png' }, { userId, db: session }),
);
assert(exportedPng.found && exportedPng.mimeType === 'image/png' && exportedPng.base64.length > 0, 'export_character_card (png) returns base64 PNG bytes');
const { decodePngCard } = await import('../dist/cardCodec.js');
const reDecodedCard = JSON.parse(decodePngCard(Buffer.from(exportedPng.base64, 'base64')));
assert(reDecodedCard.data.name === 'Bram', 'the exported PNG has the same card re-embedded and readable back out');

const exportedManual = await db.withUserScope(userId, (session) =>
  exportTool.handler({ characterId: elara.characterId, format: 'json' }, { userId, db: session }),
);
assert(exportedManual.json.spec === 'chara_card_v2' && exportedManual.json.data.description.includes('stern'), 'a manually-created character (no source_json) exports via buildCardJson instead');

// --- get_character_avatar ---
const avatar = await db.withUserScope(userId, (session) =>
  avatarTool.handler({ characterId: importedPng.characterId }, { userId, db: session }),
);
assert(avatar.found && avatar.base64.length > 0, 'get_character_avatar returns the stored avatar for an imported PNG card');

const noAvatar = await db.withUserScope(userId, (session) =>
  avatarTool.handler({ characterId: elara.characterId }, { userId, db: session }),
);
assert(noAvatar.found === false, 'get_character_avatar reports no avatar for a manually-created character');

// --- apply_character_to_chat ---
pool.chatSessions.push({ chat_id: 'chat-1', user_id: userId, params: { temperature: 0.8 } });
const applied = await db.withUserScope(userId, (session) =>
  applyTool.handler({ characterId: elara.characterId, chatId: 'chat-1' }, { userId, db: session }),
);
assert(applied.applied === true, 'apply_character_to_chat succeeds for an owned character and chat');
assert(applied.systemText.includes('stern') && applied.systemText.includes('besieged'), 'the composed system text includes both the persona and scenario sections');
assert(!applied.systemText.includes('System Prompt'), 'the composed system text omits empty sections (Elara has no system_prompt)');
assert(applied.greetingInserted === true, 'a zero-message chat gets the first greeting seeded');
const chatAfterApply = pool.chatSessions.find((c) => c.chat_id === 'chat-1');
assert(chatAfterApply.params.system === applied.systemText && chatAfterApply.params.temperature === 0.8, "applying a character sets params.system without clobbering the chat's other params");
assert(pool.chatMessages.some((m) => m.chat_id === 'chat-1' && m.role === 'assistant' && m.content === 'You again.'), "the character's first greeting was inserted as an assistant message");

// Re-applying to a chat that already has messages must not seed a second greeting.
const appliedAgain = await db.withUserScope(userId, (session) =>
  applyTool.handler({ characterId: bare.characterId, chatId: 'chat-1' }, { userId, db: session }),
);
assert(appliedAgain.greetingInserted === false, 'apply_character_to_chat never seeds a greeting into a chat that already has messages');

// --- apply_character_to_chat: a card with alternate greetings loads them all in as swipe history ---
const multiGreeting = await db.withUserScope(userId, (session) =>
  createTool.handler({ name: 'Sabrina', greetings: ['Hey there.', 'Oh, it is you.', 'Well, well.'] }, { userId, db: session }),
);
pool.chatSessions.push({ chat_id: 'chat-2', user_id: userId, params: {} });
const appliedMulti = await db.withUserScope(userId, (session) =>
  applyTool.handler({ characterId: multiGreeting.characterId, chatId: 'chat-2' }, { userId, db: session }),
);
assert(appliedMulti.greetingInserted === true, 'a card with alternate greetings still seeds the opening message');
const seededMessage = pool.chatMessages.find((m) => m.chat_id === 'chat-2' && m.role === 'assistant');
assert(seededMessage.content === 'Hey there.', 'the opening message starts on the first greeting');
const seededSwipes = pool.chatMessageSwipes.filter((s) => s.message_id === seededMessage.message_id);
assert(
  seededSwipes.length === 3 && seededSwipes.map((s) => s.content).join('|') === 'Hey there.|Oh, it is you.|Well, well.',
  'every greeting (including the first) is stashed as a swipe row, in card order',
);
assert(
  seededMessage.active_swipe_id === seededSwipes[0].swipe_id,
  "the opening message's active_swipe_id points at the first greeting's own swipe row",
);

const appliedMissingChat = await db.withUserScope(userId, (session) =>
  applyTool.handler({ characterId: elara.characterId, chatId: 'no-such-chat' }, { userId, db: session }),
);
assert(appliedMissingChat.applied === false && appliedMissingChat.reason === 'chat not found', 'apply_character_to_chat reports a missing chat instead of throwing');

// --- delete_character ---
pool.chatSessions.push({ chat_id: 'chat-3', user_id: userId, character_id: bare.characterId, params: {} });
const deleted = await db.withUserScope(userId, (session) =>
  deleteTool.handler({ characterId: bare.characterId }, { userId, db: session }),
);
assert(deleted.deleted === true, 'delete_character removes an owned character');
assert(
  deleted.deletedChatIds.length === 1 && deleted.deletedChatIds[0] === 'chat-3',
  "delete_character purges the character's chats and returns their ids",
);
assert(!pool.chatSessions.some((c) => c.chat_id === 'chat-3'), 'the purged chat is gone from chat_sessions');
const afterDelete = await db.withUserScope(userId, (session) => getTool.handler({}, { userId, db: session }));
assert(!afterDelete.some((c) => c.characterId === bare.characterId), "a deleted character no longer appears in get_characters");

const deleteOtherUsers = await db.withUserScope(userId, (session) =>
  deleteTool.handler({ characterId: otherUsersChar.characterId }, { userId, db: session }),
);
assert(
  deleteOtherUsers.deleted === false && Array.isArray(deleteOtherUsers.deletedChatIds) && deleteOtherUsers.deletedChatIds.length === 0,
  "delete_character can't delete another user's character",
);

if (process.exitCode) {
  console.error('\ncharacters verification FAILED');
  process.exit(1);
}
console.log('\ncharacters verification passed');
