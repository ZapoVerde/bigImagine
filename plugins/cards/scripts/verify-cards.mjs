// Proves canonical Card CRUD through the real plugin tools and a fake Postgres boundary. The fake
// models cards and Card-linked chats and lorebooks. Card CRUD must never invoke Character logic.

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
          // get_card linked lorebooks
          if (sql.includes('select b.lorebook_id')) {
            const [cardId, userId] = params;
            const links = lorebookCardLinks.filter((l) => l.card_id === cardId && l.user_id === userId);
            const rows = links.map((l) => {
              const book = lorebooks.find((b) => b.lorebook_id === l.lorebook_id);
              if (!book) return null;
              const shared = lorebookCardLinks.some((other) => other.lorebook_id === l.lorebook_id && other.card_id !== cardId);
              return { lorebook_id: l.lorebook_id, name: book.name ?? l.lorebook_id, shared };
            }).filter(Boolean);
            // order by name as query does
            rows.sort((a, b) => a.name.localeCompare(b.name));
            return { rows };
          }
          // explicit lorebook linkage validation
          if (sql.startsWith('select lorebook_id from lorebook_card_links where card_id = $1')) {
            const [cardId, userId, lorebookId] = params;
            const found = lorebookCardLinks.find((l) => l.card_id === cardId && l.user_id === userId && l.lorebook_id === lorebookId);
            return { rows: found ? [{ lorebook_id: lorebookId }] : [] };
          }
          if (sql.startsWith('select lorebook_id from lorebook_card_links where lorebook_id = $1')) {
            const [lorebookId, userId, cardId] = params;
            const found = lorebookCardLinks.find((l) => l.lorebook_id === lorebookId && l.user_id === userId && l.card_id !== cardId);
            return { rows: found ? [{ lorebook_id: lorebookId }] : [] };
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
          if (sql.startsWith('delete from lorebooks where lorebook_id = $1')) {
            const [lorebookId, userId] = params;
            for (let i = lorebooks.length - 1; i >= 0; i--) {
              if (lorebooks[i].lorebook_id === lorebookId && lorebooks[i].user_id === userId) lorebooks.splice(i, 1);
            }
            // cascade to links and entries (entries not modeled)
            for (let i = lorebookCardLinks.length - 1; i >= 0; i--) {
              if (lorebookCardLinks[i].lorebook_id === lorebookId) lorebookCardLinks.splice(i, 1);
            }
            return { rows: [] };
          }
          // legacy bulk lorebook delete should not be called anymore; keep for safety but make it not delete anything unexpected
          if (sql.startsWith('delete from lorebooks where user_id')) {
            throw new Error('legacy bulk lorebook delete should not be called');
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
            // cascade lorebook_card_links
            for (let i = lorebookCardLinks.length - 1; i >= 0; i--) {
              if (lorebookCardLinks[i].card_id === cardId) lorebookCardLinks.splice(i, 1);
            }
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
assert(detail.found && detail.persona === 'A traveller', 'get_card returns Card-linked fields');
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
// Card-linked lorebooks: Sydney's lorebook is linked only to Sydney; other is linked only to otherCard
pool.lorebooks.push({ lorebook_id: 'lorebook-sydney', user_id: userId, name: "Sydney's Lorebook" }, { lorebook_id: 'lorebook-other', user_id: userId, name: 'Other Lorebook' });
pool.lorebookCardLinks.push(
  { lorebook_id: 'lorebook-sydney', card_id: card.cardId, user_id: userId },
  { lorebook_id: 'lorebook-other', card_id: otherCard.cardId, user_id: userId },
);
// Verify get_card exposes linked lorebooks with shared flag
const detailWithLorebook = await db.withUserScope(userId, (session) => get.handler({ cardId: card.cardId }, { userId, db: session }));
assert(detailWithLorebook.found && detailWithLorebook.linkedLorebooks.length === 1 && detailWithLorebook.linkedLorebooks[0].lorebookId === 'lorebook-sydney' && detailWithLorebook.linkedLorebooks[0].shared === false, 'get_card exposes linked lorebooks with shared=false');
const deleted = await db.withUserScope(userId, (session) => remove.handler({ cardId: card.cardId }, { userId, db: session }));
assert(deleted.deleted && deleted.deletedChatIds.length === 3, 'delete_card deletes all dependent chats, including forks, and returns their ids');
assert(pool.cards.length === 1 && pool.cards[0].card_id === otherCard.cardId, 'delete_card leaves another Card untouched');
assert(pool.chats.length === 1 && pool.chats[0].chat_id === 'chat-other', 'delete_card leaves another Card\'s chat untouched');
assert(pool.characters.length === 1 && pool.characters[0].character_id === 'character-other', 'runtime Characters are orphan-cleaned only after their final Card chat link disappears');
assert(pool.memberships.length === 1 && pool.memberships[0].character_id === 'character-other', 'runtime membership for another Card remains intact');
// Default deletion leaves lorebooks intact; only the link row is removed via FK cascade
assert(pool.lorebooks.length === 2 && pool.lorebooks.some((b) => b.lorebook_id === 'lorebook-sydney'), 'delete_card default leaves linked Lorebook intact');
assert(pool.lorebookCardLinks.length === 1 && pool.lorebookCardLinks[0].card_id === otherCard.cardId, 'delete_card removes only the deleted Card\'s lorebook link via cascade');

// --- Explicit deletion ---
const cardForExplicit = await db.withUserScope(userId, (session) => create.handler({ name: 'Explicit' }, { userId, db: session }));
pool.lorebooks.push({ lorebook_id: 'lorebook-explicit', user_id: userId, name: 'Explicit Book' });
pool.lorebookCardLinks.push({ lorebook_id: 'lorebook-explicit', card_id: cardForExplicit.cardId, user_id: userId });
const deletedExplicit = await db.withUserScope(userId, (session) => remove.handler({ cardId: cardForExplicit.cardId, deleteLorebookIds: ['lorebook-explicit'] }, { userId, db: session }));
assert(deletedExplicit.deleted, 'delete_card with explicit lorebook deletes the Card');
assert(!pool.lorebooks.some((b) => b.lorebook_id === 'lorebook-explicit'), 'explicit delete removes the requested Lorebook');
assert(!pool.lorebookCardLinks.some((l) => l.lorebook_id === 'lorebook-explicit'), 'explicit delete removes the lorebook link via cascade');

// --- Shared lorebook ---
const cardA = await db.withUserScope(userId, (session) => create.handler({ name: 'CardA' }, { userId, db: session }));
const cardB = await db.withUserScope(userId, (session) => create.handler({ name: 'CardB' }, { userId, db: session }));
pool.lorebooks.push({ lorebook_id: 'lorebook-shared', user_id: userId, name: "Shared Book" });
pool.lorebookCardLinks.push(
  { lorebook_id: 'lorebook-shared', card_id: cardA.cardId, user_id: userId },
  { lorebook_id: 'lorebook-shared', card_id: cardB.cardId, user_id: userId },
);
pool.chats.push({ chat_id: 'chat-a-shared', card_id: cardA.cardId, user_id: userId }, { chat_id: 'chat-b-shared', card_id: cardB.cardId, user_id: userId });
const detailShared = await db.withUserScope(userId, (session) => get.handler({ cardId: cardA.cardId }, { userId, db: session }));
assert(detailShared.found && detailShared.linkedLorebooks.some((lb) => lb.lorebookId === 'lorebook-shared' && lb.shared === true), 'get_card marks shared lorebooks as shared');
// Attempting to explicitly delete shared lorebook through Card A must be refused while Card B still links
let sharedDeleteFailed = false;
try {
  await db.withUserScope(userId, (session) => remove.handler({ cardId: cardA.cardId, deleteLorebookIds: ['lorebook-shared'] }, { userId, db: session }));
} catch {
  sharedDeleteFailed = true;
}
assert(sharedDeleteFailed, 'explicit delete of shared Lorebook is refused');
assert(pool.lorebooks.some((b) => b.lorebook_id === 'lorebook-shared'), 'shared Lorebook still survives after refused explicit delete');
assert(pool.cards.some((c) => c.card_id === cardA.cardId), 'Card A still exists after refused shared lorebook delete');
assert(pool.lorebookCardLinks.some((l) => l.lorebook_id === 'lorebook-shared' && l.card_id === cardB.cardId), 'Card B link to shared Lorebook still intact after refused delete');
const deletedSharedDefault = await db.withUserScope(userId, (session) => remove.handler({ cardId: cardA.cardId }, { userId, db: session }));
assert(deletedSharedDefault.deleted, 'delete CardA with shared lorebook default succeeds');
assert(pool.lorebooks.some((b) => b.lorebook_id === 'lorebook-shared'), 'shared Lorebook survives default delete');
assert(pool.lorebookCardLinks.some((l) => l.lorebook_id === 'lorebook-shared' && l.card_id === cardB.cardId), 'Card B link to shared Lorebook remains intact');
assert(!pool.lorebookCardLinks.some((l) => l.lorebook_id === 'lorebook-shared' && l.card_id === cardA.cardId), 'Card A link to shared Lorebook removed');

// --- Arbitrary lorebook id not linked must be rejected ---
const cardForArbitrary = await db.withUserScope(userId, (session) => create.handler({ name: 'ArbitraryTest' }, { userId, db: session }));
let arbitraryFailed = false;
try {
  await db.withUserScope(userId, (session) => remove.handler({ cardId: cardForArbitrary.cardId, deleteLorebookIds: ['lorebook-other'] }, { userId, db: session }));
} catch {
  arbitraryFailed = true;
}
assert(arbitraryFailed, 'delete_card rejects lorebook id not linked to this Card');
assert(pool.cards.some((c) => c.card_id === cardForArbitrary.cardId), 'Card still exists after rejected arbitrary lorebook delete');

if (process.exitCode) process.exit(1);
console.log('\nCards verification passed');
