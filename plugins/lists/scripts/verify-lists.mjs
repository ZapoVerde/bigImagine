// Proves all four tools end to end through info/registerTools (the real loader contract), using
// a small stateful fake Postgres pool that actually simulates lists/list_items across a sequence
// of calls — same style as document-ingestion/shopping-analytics's verify scripts, but these
// tools genuinely depend on prior state (find-or-create, tie-break on completion), so the fake
// pool needs to behave like a real (tiny) database, not just record calls.

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
  const lists = [];
  const items = [];
  const syncMap = [];
  let listCounter = 0;
  let itemCounter = 0;

  return {
    lists,
    items,
    syncMap,
    async connect() {
      let scopedUserId;
      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
          if (sql.includes('set_config')) {
            scopedUserId = params[0];
            return { rows: [] };
          }

          if (sql.includes('select section_order from lists where list_id')) {
            const [listId] = params;
            const list = lists.find((l) => l.list_id === listId);
            return { rows: list ? [{ section_order: list.section_order }] : [] };
          }
          if (sql.includes('update lists set section_order')) {
            const [listId, sectionOrder] = params;
            const list = lists.find((l) => l.list_id === listId);
            if (list) list.section_order = sectionOrder;
            return { rows: [] };
          }
          if (sql.includes('select list_id from lists where')) {
            const [userId, name] = params;
            const match = lists.find((l) => l.user_id === userId && l.name.toLowerCase() === name.toLowerCase());
            assert(scopedUserId === userId, 'the list lookup is scoped to the requesting user');
            return { rows: match ? [{ list_id: match.list_id }] : [] };
          }
          if (sql.includes('insert into lists')) {
            const [userId, name, tags] = params;
            const list_id = `list-${++listCounter}`;
            lists.push({ list_id, user_id: userId, name, tags, section_order: [] });
            return { rows: [{ list_id }] };
          }
          if (sql.includes('insert into list_items')) {
            const [listId, userId, itemName, section] = params;
            const item_id = `item-${++itemCounter}`;
            items.push({
              item_id,
              list_id: listId,
              user_id: userId,
              item_name: itemName,
              section: section ?? null,
              status: 'pending',
              created_at: `2026-07-23T00:00:${String(itemCounter).padStart(2, '0')}Z`,
              completed_at: null,
            });
            return { rows: [{ item_id }] };
          }
          if (sql.includes('update list_items')) {
            const [userId, itemName, listName] = params;
            const candidates = items
              .filter((it) => it.user_id === userId && it.status === 'pending')
              .filter((it) => it.item_name.toLowerCase() === itemName.toLowerCase())
              .filter((it) => {
                if (!listName) return true;
                const list = lists.find((l) => l.list_id === it.list_id);
                return list && list.name.toLowerCase() === listName.toLowerCase();
              })
              .sort((a, b) => b.created_at.localeCompare(a.created_at));
            const target = candidates[0];
            if (!target) return { rows: [] };
            target.status = 'done';
            target.completed_at = '2026-07-23T01:00:00Z';
            return { rows: [{ item_id: target.item_id, list_id: target.list_id }] };
          }
          if (sql.includes('select li.item_id, l.name as list_name')) {
            const [userId, listName, includeDone] = params;
            const rows = items
              .filter((it) => it.user_id === userId)
              .filter((it) => includeDone || it.status === 'pending')
              .filter((it) => {
                if (!listName) return true;
                const list = lists.find((l) => l.list_id === it.list_id);
                return list && list.name.toLowerCase() === listName.toLowerCase();
              })
              .map((it) => {
                const list = lists.find((l) => l.list_id === it.list_id);
                return {
                  item_id: it.item_id,
                  list_name: list.name,
                  section_order: list.section_order,
                  section: it.section,
                  item_name: it.item_name,
                  status: it.status,
                  created_at: it.created_at,
                  completed_at: it.completed_at,
                };
              });
            return { rows };
          }
          if (sql.includes('select notion_page_id from notion_sync_map')) {
            const [sourceTable, sourceRowId] = params;
            const match = syncMap.find((m) => m.source_table === sourceTable && m.source_row_id === sourceRowId);
            return { rows: match ? [{ notion_page_id: match.notion_page_id }] : [] };
          }
          if (sql.includes('insert into notion_sync_map')) {
            const [userId, sourceTable, sourceRowId, notionDatabaseId, notionPageId] = params;
            syncMap.push({
              user_id: userId,
              source_table: sourceTable,
              source_row_id: sourceRowId,
              notion_database_id: notionDatabaseId,
              notion_page_id: notionPageId,
            });
            return { rows: [] };
          }
          if (sql.includes('update notion_sync_map set last_synced_at')) {
            const [sourceTable, sourceRowId] = params;
            const match = syncMap.find((m) => m.source_table === sourceTable && m.source_row_id === sourceRowId);
            if (match) match.synced = true;
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

const OWNER_USER_ID = '11111111-1111-1111-1111-111111111111';

function createFakeNotionClient({ shouldThrow = false, ownerUserId = OWNER_USER_ID } = {}) {
  const calls = [];
  let pageCounter = 0;
  return {
    calls,
    listsDataSourceId: 'fake-data-source-id',
    ownerUserId,
    async upsertListItemPage(args) {
      calls.push(args);
      if (shouldThrow) throw new Error('simulated Notion API failure');
      return { pageId: args.pageId ?? `notion-page-${++pageCounter}` };
    },
  };
}

assert(
  info.id === 'lists' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

const notion = createFakeNotionClient();
const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion });
assert(pluginTools.length === 5, 'registerTools returns exactly five tools');

const registry = createToolRegistry(pluginTools);
for (const name of ['create_list', 'add_list_item', 'complete_list_item', 'get_list_items', 'set_list_section_order']) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const pool = createFakePool();
const db = createPostgresClient(pool);
const userId = '11111111-1111-1111-1111-111111111111';
const withUser = (fn) => db.withUserScope(userId, (session) => fn({ userId, db: session }));

// --- add_list_item creates the list on first use, and syncs the new item to Notion ---
const addMilk = await withUser((ctx) => registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'milk' }, ctx));
assert(addMilk.listWasCreated === true, 'adding an item to a new list creates it');
assert(notion.calls.length === 1 && notion.calls[0].itemName === 'milk', 'add_list_item synced the new item to Notion');
assert(pool.syncMap.length === 1 && pool.syncMap[0].source_row_id === addMilk.itemId, 'a notion_sync_map row was minted for the new item');

// --- a second add to the same list (different case) reuses it, does not duplicate ---
const addEggs = await withUser((ctx) =>
  registry.get('add_list_item').handler({ list_name: 'grocery list', item_name: 'eggs' }, ctx),
);
assert(addEggs.listWasCreated === false, 'adding to an existing list (case-insensitive) does not recreate it');
assert(addEggs.listId === addMilk.listId, 'both items landed on the same list');
assert(pool.lists.length === 1, 'only one list row exists after two add_list_item calls');

// --- create_list is idempotent by name ---
const createDup = await withUser((ctx) => registry.get('create_list').handler({ name: 'Grocery List' }, ctx));
assert(createDup.created === false && createDup.listId === addMilk.listId, 'create_list on an existing name returns it instead of duplicating');

const createNew = await withUser((ctx) => registry.get('create_list').handler({ name: 'Books to Read', tags: ['reading'] }, ctx));
assert(createNew.created === true, 'create_list makes a genuinely new list when the name is new');
assert(pool.lists.length === 2, 'exactly two distinct lists exist now');

// --- a second "milk" on the same list, to prove the completion tie-break ---
const addMilk2 = await withUser((ctx) => registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'milk' }, ctx));
assert(pool.items.filter((i) => i.item_name === 'milk').length === 2, 'two pending "milk" items exist on the list');

// --- complete_list_item completes the most recently added matching pending item, and syncs ---
const syncCallsBeforeComplete = notion.calls.length;
const complete = await withUser((ctx) => registry.get('complete_list_item').handler({ item_name: 'milk' }, ctx));
assert(complete.completed === true && complete.itemId === addMilk2.itemId, 'completing "milk" resolves to the most recently added matching item');
const remainingMilk = pool.items.find((i) => i.item_name === 'milk' && i.status === 'pending');
assert(remainingMilk && remainingMilk.item_id === addMilk.itemId, 'the earlier milk item is untouched and still pending');
assert(notion.calls.length === syncCallsBeforeComplete + 1, 'completing the item triggered exactly one more Notion sync call');
const completeSyncCall = notion.calls[notion.calls.length - 1];
assert(completeSyncCall.done === true, 'the Notion sync call for completion carries done: true');
assert(
  pool.syncMap.find((m) => m.source_row_id === addMilk2.itemId).notion_page_id === completeSyncCall.pageId,
  'completing an already-synced item updates its existing Notion page rather than creating a new one',
);

// --- completing something that doesn't exist fails softly, not with a thrown error ---
const missing = await withUser((ctx) => registry.get('complete_list_item').handler({ item_name: 'nonexistent thing' }, ctx));
assert(missing.completed === false, 'completing a nonexistent item returns completed: false rather than throwing');

// --- get_list_items defaults to pending-only, across all lists ---
const pending = await withUser((ctx) => registry.get('get_list_items').handler({}, ctx));
assert(pending.length === 2, 'default get_list_items returns only pending items (eggs, the older milk)');
assert(pending.every((i) => i.status === 'pending'), 'no completed items appear by default');

// --- include_done surfaces the completed one too ---
const all = await withUser((ctx) => registry.get('get_list_items').handler({ include_done: true }, ctx));
assert(all.length === 3, 'include_done: true returns all items including the completed one');

// --- list_name scopes to just that list ---
const booksOnly = await withUser((ctx) => registry.get('get_list_items').handler({ list_name: 'Books to Read' }, ctx));
assert(booksOnly.length === 0, 'a list with no items returns an empty array, not an error');

// --- empty-string args are rejected, not silently accepted ---
try {
  await withUser((ctx) => registry.get('add_list_item').handler({ list_name: '', item_name: 'x' }, ctx));
  assert(false, 'an empty list_name is rejected');
} catch {
  assert(true, 'an empty list_name is rejected');
}

// --- a Notion failure never fails the underlying tool call (best-effort, per notionSync.ts) ---
{
  const failUserId = '22222222-2222-2222-2222-222222222222';
  const failingNotion = createFakeNotionClient({ shouldThrow: true, ownerUserId: failUserId });
  const failPool = createFakePool();
  const failDb = createPostgresClient(failPool);
  const failTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: failingNotion });
  const failRegistry = createToolRegistry(failTools);

  const result = await failDb.withUserScope(failUserId, (session) =>
    failRegistry.get('add_list_item').handler({ list_name: 'Errand List', item_name: 'stamps' }, { userId: failUserId, db: session }),
  );
  assert(result.itemId !== undefined, 'add_list_item still succeeds even when the Notion sync call throws');
  assert(failingNotion.calls.length === 1, 'the failing Notion call was still attempted');
  assert(failPool.syncMap.length === 0, 'no notion_sync_map row is left behind when the Notion call itself failed');
}

// --- notion: undefined (not configured) is a clean no-op, not a crash ---
{
  const noNotionPool = createFakePool();
  const noNotionDb = createPostgresClient(noNotionPool);
  const noNotionTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined });
  const noNotionRegistry = createToolRegistry(noNotionTools);
  const noNotionUserId = '33333333-3333-3333-3333-333333333333';

  const result = await noNotionDb.withUserScope(noNotionUserId, (session) =>
    noNotionRegistry.get('add_list_item').handler({ list_name: 'Errand List', item_name: 'stamps' }, { userId: noNotionUserId, db: session }),
  );
  assert(result.itemId !== undefined, 'add_list_item works normally when Notion is not configured at all');
  assert(noNotionPool.syncMap.length === 0, 'no sync bookkeeping happens when notion is undefined');
}

// --- a non-owner user's list items stay Postgres-only: Notion is configured, but this user isn't
// notion.ownerUserId, so the sync must never fire (the bug caught live: a test account's writes
// were reaching the real owner's Notion workspace with nothing stopping it) ---
{
  const nonOwnerNotion = createFakeNotionClient(); // ownerUserId defaults to OWNER_USER_ID
  const nonOwnerPool = createFakePool();
  const nonOwnerDb = createPostgresClient(nonOwnerPool);
  const nonOwnerTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: nonOwnerNotion });
  const nonOwnerRegistry = createToolRegistry(nonOwnerTools);
  const nonOwnerUserId = '44444444-4444-4444-4444-444444444444'; // deliberately not OWNER_USER_ID

  const result = await nonOwnerDb.withUserScope(nonOwnerUserId, (session) =>
    nonOwnerRegistry.get('add_list_item').handler({ list_name: 'Errand List', item_name: 'stamps' }, { userId: nonOwnerUserId, db: session }),
  );
  assert(result.itemId !== undefined, "add_list_item still succeeds for a non-owner user (Postgres write is unaffected)");
  assert(nonOwnerNotion.calls.length === 0, "a non-owner user's add_list_item never calls the Notion API at all");
  assert(nonOwnerPool.syncMap.length === 0, 'no notion_sync_map row is created for a non-owner user');
}

function createFakeLlm(sectionFor) {
  const calls = [];
  return {
    calls,
    async complete(messages, _tools, options) {
      calls.push(messages[1].content);
      const itemName = messages[1].content;
      const section = sectionFor(itemName);
      if (section === undefined) throw new Error(`no fake section configured for "${itemName}"`);
      return { message: { role: 'assistant', content: '' }, toolCalls: [{ id: 'c1', name: options.forceTool, arguments: { section } }] };
    },
  };
}

// --- set_list_section_order + section-aware sorting in get_list_items ---
{
  const pool = createFakePool();
  const db = createPostgresClient(pool);
  const userId = '66666666-6666-6666-6666-666666666666';
  const llm = createFakeLlm((item) => (item.toLowerCase().includes('milk') ? 'dairy' : item.toLowerCase().includes('lettuce') ? 'veggies' : undefined));
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined });
  const registry = createToolRegistry(tools);
  const withUser = (fn) => db.withUserScope(userId, (session) => fn({ userId, db: session }));

  const setOrder = await withUser((ctx) =>
    registry.get('set_list_section_order').handler({ list_name: 'Grocery List', sections: ['veggies', 'meats', 'dairy'] }, ctx),
  );
  assert(setOrder.sectionCount === 3, 'set_list_section_order reports the number of sections it set');
  assert(pool.lists[0].section_order.join(',') === 'veggies,meats,dairy', 'the list row carries the given section_order verbatim, in order');

  // added out of section order (dairy before veggies) — get_list_items must still return them
  // sorted by section position, not creation order
  await withUser((ctx) => registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'milk' }, ctx));
  await withUser((ctx) => registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'lettuce' }, ctx));

  assert(llm.calls.length === 2, 'each item added to a list with a section_order triggers exactly one classification call');
  assert(pool.items.find((i) => i.item_name === 'milk').section === 'dairy', 'milk was classified into the dairy section');
  assert(pool.items.find((i) => i.item_name === 'lettuce').section === 'veggies', 'lettuce was classified into the veggies section');

  const items = await withUser((ctx) => registry.get('get_list_items').handler({ list_name: 'Grocery List' }, ctx));
  assert(
    items.map((i) => i.itemName).join(',') === 'lettuce,milk',
    'get_list_items returns items in section_order order (veggies before dairy), not creation order',
  );

  // a list with no section_order never calls the LLM at all
  const throwingLlm = createFakeLlm(() => {
    throw new Error('llm should not be called for a list with no section_order');
  });
  const noOrderTools = await registerTools({ llm: throwingLlm, embeddings: null, cipher: null, notion: undefined });
  const noOrderRegistry = createToolRegistry(noOrderTools);
  const noOrderResult = await withUser((ctx) =>
    noOrderRegistry.get('add_list_item').handler({ list_name: 'Books to Read', item_name: 'a novel' }, ctx),
  );
  assert(noOrderResult.itemId !== undefined, 'adding to a list with no section_order still succeeds');
  assert(pool.items.find((i) => i.item_name === 'a novel').section === null, 'the item is left unsectioned when its list has no section_order');

  // a classification failure never blocks the item from being added
  const failingLlm = createFakeLlm(() => undefined); // always throws inside createFakeLlm
  const failTools = await registerTools({ llm: failingLlm, embeddings: null, cipher: null, notion: undefined });
  const failRegistry = createToolRegistry(failTools);
  const failResult = await withUser((ctx) =>
    failRegistry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'mystery item' }, ctx),
  );
  assert(failResult.itemId !== undefined, 'add_list_item still succeeds even when section classification throws');
  assert(
    pool.items.find((i) => i.item_name === 'mystery item').section === null,
    'an item is left unsectioned (not crashed) when classification fails',
  );
}

if (process.exitCode) {
  console.error('\nlists verification FAILED');
  process.exit(1);
}
console.log('\nlists verification passed');
