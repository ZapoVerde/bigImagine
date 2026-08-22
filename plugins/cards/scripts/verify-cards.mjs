// Proves canonical Card CRUD through the real plugin tools and a fake Postgres boundary. The fake
// models cards and Card-linked chats only; it deliberately does not mock Character logic because
// Card CRUD must never invoke it.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { createToolRegistry } from '@bigbrain/orchestrator/tool-registry';
import { info, registerTools } from '../dist/index.js';

function assert(condition, message) {
  if (!condition) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else console.log(`ok: ${message}`);
}

function createFakePool() {
  const cards = [];
  const chats = [];
  const characters = [];
  const memberships = [];
  const lorebooks = [];
  const lorebookCardLinks = [];
  let sequence = 0;
  return {
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }
          if (sql.startsWith('insert into cards')) {
            const [userId, name, persona, appearance, scenario, systemPrompt, exampleDialogue, greetings] = params;
            assert(scopedUserId === userId, 'create_card is user-scoped');
            const card = {
              card_id: `card-${++sequence}`, user_id: userId, name, persona, appearance, scenario,
              system_prompt: systemPrompt, example_dialogue: exampleDialogue, greetings: JSON.parse(greetings),
              created_at: new Date('2026-08-22T00:00:00Z'), updated_at: new Date('2026-08-22T00:00:00Z'),
            };
            cards.push(card);
            return { rows: [{ card_id: card.card_id, name: card.name }] };
          }
          if (sql.startsWith('select card_id, name, created_at')) {
            const rows = cards.filter((c) => c.user_id === params[0]).map((c) => ({ ...c, has_avatar: false }));
            return { rows };
          }
          if (sql.startsWith('select card_id from cards')) {
            const card = cards.find((c) => c.card_id === params[0] && c.user_id === params[1]);
            return { rows: card ? [{ card_id: card.card_id }] : [] };
          }
          if (sql.startsWith('select card_id, name, persona')) {
            const card = cards.find((c) => c.card_id === params[0] && c.user_id === params[1]);
            return { rows: card ? [{ ...card, has_avatar: false, has_source_json: false, spec_version: 'v2' }] : [] };
          }
          if (sql.startsWith('update cards set')) {
            const [cardId, userId, ...rest] = params;
            const card = cards.find((c) => c.card_id === cardId && c.user_id === userId);
            if (!card) return { rows: [] };
            let i = 0;
            for (const [column, marker] of [['name', 'name = $'], ['persona', 'persona = $'], ['appearance', 'appearance = $'], ['scenario', 'scenario = $'], ['system_prompt', 'system_prompt = $'], ['example_dialogue', 'example_dialogue = $']]) {
              if (sql.includes(marker)) card[column] = rest[i++];
            }
            if (sql.includes('greetings = $')) card.greetings = JSON.parse(rest[i++]);
            return { rows: [{ card_id: card.card_id, name: card.name }] };
          }
          if (sql.startsWith('delete from lorebooks')) {
            const [userId, cardId] = params;
            const owned = lorebookCardLinks.filter((l) => l.card_id === cardId && l.user_id === userId).map((l) => l.lorebook_id);
            for (let i = lorebooks.length - 1; i >= 0; i--) {
              if (owned.includes(lorebooks[i].lorebook_id) && lorebooks[i].user_id === userId) lorebooks.splice(i, 1);
            }
            for (let i = lorebookCardLinks.length - 1; i >= 0; i--) {
              if (lorebookCardLinks[i].card_id === cardId) lorebookCardLinks.splice(i, 1);
            }
            return { rows: [] };
          }
          if (sql.startsWith('delete from chat_sessions')) {
            const [cardId, userId] = params;
            const deleted = chats.filter((c) => c.card_id === cardId && c.user_id === userId);
            for (const chat of deleted) chats.splice(chats.indexOf(chat), 1);
            for (let i = memberships.length - 1; i >= 0; i--) {
              if (deleted.some((chat) => chat.chat_id === memberships[i].chat_id)) memberships.splice(i, 1);
            }
            for (let i = characters.length - 1; i >= 0; i--) {
              if (!memberships.some((link) => link.character_id === characters[i].character_id)) characters.splice(i, 1);
            }
            return { rows: deleted.map((c) => ({ chat_id: c.chat_id })) };
          }
          if (sql.startsWith('delete from cards')) {
            const [cardId, userId] = params;
            const index = cards.findIndex((c) => c.card_id === cardId && c.user_id === userId);
            if (index < 0) return { rows: [] };
            const [card] = cards.splice(index, 1);
            return { rows: [{ card_id: card.card_id }] };
          }
          throw new Error(`unexpected fake query: ${sql}`);
        },
        release() {},
      };
    },
    cards,
    chats,
    characters,
    memberships,
    lorebooks,
    lorebookCardLinks,
  };
}

assert(info.id === 'cards', 'plugin info identifies Cards');
const tools = await registerTools({});
assert(tools.length === 11, 'registerTools returns Card CRUD, import/export, media, Chub, and chat-apply tools');
const registry = createToolRegistry(tools);
for (const name of ['get_cards', 'get_card', 'create_card', 'update_card', 'delete_card']) {
  assert(registry.definitions().some((definition) => definition.name === name), `${name} is registered`);
}
for (const name of ['import_card', 'import_card_from_url', 'search_chub_cards', 'export_card', 'get_card_avatar']) {
  assert(registry.definitions().some((definition) => definition.name === name), `${name} is registered`);
}
assert(registry.definitions().some((definition) => definition.name === 'apply_card_to_chat'), 'apply_card_to_chat is registered');

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const create = registry.get('create_card');
const list = registry.get('get_cards');
const get = registry.get('get_card');
const update = registry.get('update_card');
const remove = registry.get('delete_card');

const card = await db.withUserScope(userId, (session) => create.handler({ name: 'Sydney', persona: 'A traveller', appearance: 'Tall', greetings: ['Hi'] }, { userId, db: session }));
assert(card.cardId && card.name === 'Sydney', 'create_card creates canonical Card data');
const listed = await db.withUserScope(userId, (session) => list.handler({}, { userId, db: session }));
assert(listed.length === 1 && listed[0].cardId === card.cardId, 'get_cards reads the created Card');
const detail = await db.withUserScope(userId, (session) => get.handler({ cardId: card.cardId }, { userId, db: session }));
assert(detail.found && detail.persona === 'A traveller', 'get_card returns Card-owned fields');
const changed = await db.withUserScope(userId, (session) => update.handler({ cardId: card.cardId, scenario: 'A new road' }, { userId, db: session }));
assert(changed.found && changed.cardId === card.cardId, 'update_card updates canonical Card data');
const otherCard = await db.withUserScope(userId, (session) => create.handler({ name: 'Unrelated' }, { userId, db: session }));
pool.chats.push(
  { chat_id: 'chat-a', card_id: card.cardId, user_id: userId },
  { chat_id: 'chat-a2', card_id: card.cardId, user_id: userId, parent_chat_id: 'chat-a' },
  { chat_id: 'chat-b', card_id: card.cardId, user_id: userId },
  { chat_id: 'chat-other', card_id: otherCard.cardId, user_id: userId },
);
pool.characters.push({ character_id: 'character-sydney-a', user_id: userId }, { character_id: 'character-sydney-b', user_id: userId }, { character_id: 'character-other', user_id: userId });
pool.memberships.push(
  { character_id: 'character-sydney-a', chat_id: 'chat-a' },
  { character_id: 'character-sydney-a', chat_id: 'chat-a2' },
  { character_id: 'character-sydney-b', chat_id: 'chat-b' },
  { character_id: 'character-other', chat_id: 'chat-other' },
);
// 4_ISSUES.md #2: an imported Card's embedded lorebook is Card-owned supporting content, not an
// independent reusable lorebook — it must not outlive the Card that owns it.
pool.lorebooks.push({ lorebook_id: 'lorebook-sydney', user_id: userId }, { lorebook_id: 'lorebook-other', user_id: userId });
pool.lorebookCardLinks.push(
  { lorebook_id: 'lorebook-sydney', card_id: card.cardId, user_id: userId },
  { lorebook_id: 'lorebook-other', card_id: otherCard.cardId, user_id: userId },
);
const deleted = await db.withUserScope(userId, (session) => remove.handler({ cardId: card.cardId }, { userId, db: session }));
assert(deleted.deleted && deleted.deletedChatIds.length === 3, 'delete_card deletes all dependent chats, including forks, and returns their ids');
assert(pool.cards.length === 1 && pool.cards[0].card_id === otherCard.cardId, 'delete_card leaves another Card untouched');
assert(pool.chats.length === 1 && pool.chats[0].chat_id === 'chat-other', 'delete_card leaves another Card\'s chat untouched');
assert(pool.characters.length === 1 && pool.characters[0].character_id === 'character-other', 'runtime Characters are orphan-cleaned only after their final Card chat link disappears');
assert(pool.memberships.length === 1 && pool.memberships[0].character_id === 'character-other', 'runtime membership for another Card remains intact');
assert(pool.lorebooks.length === 1 && pool.lorebooks[0].lorebook_id === 'lorebook-other', "delete_card deletes the Card's own imported lorebook, not just its link row");
assert(pool.lorebookCardLinks.length === 1 && pool.lorebookCardLinks[0].card_id === otherCard.cardId, "delete_card leaves another Card's lorebook association untouched");

if (process.exitCode) process.exit(1);
console.log('\nCards verification passed');
