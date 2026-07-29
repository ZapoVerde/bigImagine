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

// Notion sync/cleanup now runs detached (notionSync.ts's *InBackground wrappers) — not awaited by
// the handler that triggered it. setImmediate defers past every pending microtask (BEGIN/query/
// COMMIT/release, all plain promises with no real timers in the fake pool), so one flush reliably
// lets a detached call finish before a test asserts on its effects.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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
          if (sql.startsWith('update lists set') && (sql.includes('show_priority') || sql.includes('show_due_dates'))) {
            const [listId, ...values] = params;
            const list = lists.find((l) => l.list_id === listId);
            let idx = 0;
            if (sql.includes('show_priority = $')) list.show_priority = values[idx++];
            if (sql.includes('show_due_dates = $')) list.show_due_dates = values[idx++];
            return { rows: list ? [{ show_priority: list.show_priority, show_due_dates: list.show_due_dates }] : [] };
          }
          if (sql.includes('select list_id, name, tags, show_priority, show_due_dates from lists')) {
            const [userId] = params;
            const rows = lists
              .filter((l) => l.user_id === userId)
              .slice()
              .sort((a, b) => a.name.localeCompare(b.name))
              .map((l) => ({
                list_id: l.list_id,
                name: l.name,
                tags: l.tags,
                show_priority: l.show_priority,
                show_due_dates: l.show_due_dates,
              }));
            return { rows };
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
            lists.push({ list_id, user_id: userId, name, tags, section_order: [], show_priority: false, show_due_dates: false });
            return { rows: [{ list_id }] };
          }
          if (sql.includes('insert into list_items')) {
            const [listId, userId, itemName, section, priority, dueAt] = params;
            const item_id = `item-${++itemCounter}`;
            items.push({
              item_id,
              list_id: listId,
              user_id: userId,
              item_name: itemName,
              section: section ?? null,
              status: 'pending',
              priority: priority ?? null,
              due_at: dueAt ?? null,
              created_at: `2026-07-23T00:00:${String(itemCounter).padStart(2, '0')}Z`,
              completed_at: null,
            });
            return { rows: [{ item_id }] };
          }
          if (sql.startsWith('update list_items set')) {
            const [itemId, userId] = params;
            const item = items.find((it) => it.item_id === itemId && it.user_id === userId);
            if (!item) return { rows: [] };
            let paramIdx = 2;
            if (sql.includes('item_name = $')) item.item_name = params[paramIdx++];
            if (sql.includes('priority = $')) item.priority = params[paramIdx++];
            if (sql.includes('due_at = $')) item.due_at = params[paramIdx++];
            return { rows: [{ item_id: item.item_id, item_name: item.item_name, priority: item.priority, due_at: item.due_at }] };
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
                  priority: it.priority ?? null,
                  due_at: it.due_at ?? null,
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
          if (sql.startsWith('delete from notion_sync_map')) {
            const [sourceTable, sourceRowId] = params;
            const idx = syncMap.findIndex((m) => m.source_table === sourceTable && m.source_row_id === sourceRowId);
            if (idx !== -1) syncMap.splice(idx, 1);
            return { rows: [] };
          }
          if (sql.startsWith('delete from list_items where item_id')) {
            const [itemId, userId] = params;
            const idx = items.findIndex((it) => it.item_id === itemId && it.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [removed] = items.splice(idx, 1);
            return { rows: [{ item_id: removed.item_id }] };
          }
          if (sql.includes('select item_id from list_items where list_id')) {
            const [listId, userId] = params;
            const rows = items.filter((it) => it.list_id === listId && it.user_id === userId).map((it) => ({ item_id: it.item_id }));
            return { rows };
          }
          if (sql.startsWith('delete from list_items where list_id')) {
            const [listId, userId] = params;
            for (let i = items.length - 1; i >= 0; i--) {
              if (items[i].list_id === listId && items[i].user_id === userId) items.splice(i, 1);
            }
            return { rows: [] };
          }
          if (sql.startsWith('delete from lists where list_id')) {
            const [listId, userId] = params;
            const idx = lists.findIndex((l) => l.list_id === listId && l.user_id === userId);
            if (idx === -1) return { rows: [] };
            const [removed] = lists.splice(idx, 1);
            return { rows: [{ list_id: removed.list_id, name: removed.name }] };
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
    archivedPageIds: [],
    async archivePage(pageId) {
      calls.push({ archivePage: pageId });
      if (shouldThrow) throw new Error('simulated Notion API failure');
      this.archivedPageIds.push(pageId);
    },
  };
}

assert(
  info.id === 'lists' && /^[a-z0-9_-]+$/.test(info.id),
  'info.id is present and matches the id format pluginLoader.ts requires',
);

const notion = createFakeNotionClient();
const pool = createFakePool();
const db = createPostgresClient(pool);
const pluginTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion, db });
assert(pluginTools.length === 10, 'registerTools returns exactly ten tools');

const registry = createToolRegistry(pluginTools);
for (const name of [
  'create_list',
  'add_list_item',
  'complete_list_item',
  'get_list_items',
  'update_list_item',
  'set_list_section_order',
  'delete_list_item',
  'delete_list',
  'get_lists',
  'update_list_settings',
]) {
  assert(registry.definitions().some((d) => d.name === name), `${name} is registered`);
}

const userId = '11111111-1111-1111-1111-111111111111';
// Auto-flushes after every call so a detached Notion sync/cleanup this handler triggered always
// finishes before the next line runs — without this, an un-flushed call's effects can land in the
// middle of a *later* flush and throw off any assertion counting notion.calls between two points.
const withUser = async (fn) => {
  const result = await db.withUserScope(userId, (session) => fn({ userId, db: session }));
  await flush();
  return result;
};

// --- add_list_item creates the list on first use, and syncs the new item to Notion ---
const addMilk = await withUser((ctx) => registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'milk' }, ctx));
assert(addMilk.listWasCreated === true, 'adding an item to a new list creates it');
await flush();
assert(notion.calls.length === 1 && notion.calls[0].itemName === 'milk', 'add_list_item synced the new item to Notion (in the background)');
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
await flush();
assert(notion.calls.length === syncCallsBeforeComplete + 1, 'completing the item triggered exactly one more Notion sync call (in the background)');
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

// --- priority/due_at pass through add_list_item -> get_list_items, and update_list_item edits them later ---
{
  const addUrgent = await withUser((ctx) =>
    registry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'urgent thing', priority: 'P1', due_at: '2026-08-01T00:00:00Z' }, ctx),
  );
  assert(addUrgent.priority === 'P1' && addUrgent.dueAt === '2026-08-01T00:00:00Z', 'add_list_item echoes back the priority/due_at it was given');

  const items = await withUser((ctx) => registry.get('get_list_items').handler({ list_name: 'Grocery List' }, ctx));
  const urgentItem = items.find((i) => i.itemName === 'urgent thing');
  assert(urgentItem.priority === 'P1' && urgentItem.dueAt === '2026-08-01T00:00:00Z', 'get_list_items carries priority/due_at through');
  const plainItem = items.find((i) => i.itemName === 'eggs');
  assert(plainItem.priority === null && plainItem.dueAt === null, 'an item added without priority/due_at has both null');

  const updated = await withUser((ctx) => registry.get('update_list_item').handler({ item_id: urgentItem.itemId, priority: 'P3' }, ctx));
  assert(updated.found === true && updated.priority === 'P3', 'update_list_item changes priority when given');
  assert(updated.dueAt === '2026-08-01T00:00:00Z', 'update_list_item leaves due_at untouched when only priority was supplied');

  const missingUpdate = await withUser((ctx) => registry.get('update_list_item').handler({ item_id: 'no-such-item', priority: 'P1' }, ctx));
  assert(missingUpdate.found === false, 'update_list_item on a nonexistent item returns found: false rather than throwing');
}

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
  const failTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: failingNotion, db: failDb });
  const failRegistry = createToolRegistry(failTools);

  const result = await failDb.withUserScope(failUserId, (session) =>
    failRegistry.get('add_list_item').handler({ list_name: 'Errand List', item_name: 'stamps' }, { userId: failUserId, db: session }),
  );
  assert(result.itemId !== undefined, 'add_list_item still succeeds even when the Notion sync call throws');
  await flush();
  assert(failingNotion.calls.length === 1, 'the failing Notion call was still attempted (in the background)');
  assert(failPool.syncMap.length === 0, 'no notion_sync_map row is left behind when the Notion call itself failed');
}

// --- notion: undefined (not configured) is a clean no-op, not a crash ---
{
  const noNotionPool = createFakePool();
  const noNotionDb = createPostgresClient(noNotionPool);
  const noNotionTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined, db: noNotionDb });
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
  const nonOwnerTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: nonOwnerNotion, db: nonOwnerDb });
  const nonOwnerRegistry = createToolRegistry(nonOwnerTools);
  const nonOwnerUserId = '44444444-4444-4444-4444-444444444444'; // deliberately not OWNER_USER_ID

  const result = await nonOwnerDb.withUserScope(nonOwnerUserId, (session) =>
    nonOwnerRegistry.get('add_list_item').handler({ list_name: 'Errand List', item_name: 'stamps' }, { userId: nonOwnerUserId, db: session }),
  );
  assert(result.itemId !== undefined, "add_list_item still succeeds for a non-owner user (Postgres write is unaffected)");
  await flush();
  assert(nonOwnerNotion.calls.length === 0, "a non-owner user's add_list_item never calls the Notion API at all");
  assert(nonOwnerPool.syncMap.length === 0, 'no notion_sync_map row is created for a non-owner user');
}

// --- delete_list_item and delete_list, including Notion cleanup and user-scoping ---
{
  const delNotion = createFakeNotionClient();
  const delPool = createFakePool();
  const delDb = createPostgresClient(delPool);
  const delTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: delNotion, db: delDb });
  const delRegistry = createToolRegistry(delTools);
  const delUserId = OWNER_USER_ID;
  const withDelUser = async (fn) => {
    const result = await delDb.withUserScope(delUserId, (session) => fn({ userId: delUserId, db: session }));
    await flush();
    return result;
  };

  const milk = await withDelUser((ctx) => delRegistry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'milk' }, ctx));
  const eggs = await withDelUser((ctx) => delRegistry.get('add_list_item').handler({ list_name: 'Grocery List', item_name: 'eggs' }, ctx));
  await flush();
  assert(delPool.syncMap.length === 2, 'both new items were synced to Notion, minting two sync-map rows (in the background)');
  const milkPageId = delPool.syncMap.find((m) => m.source_row_id === milk.itemId).notion_page_id;

  const deletedMilk = await withDelUser((ctx) => delRegistry.get('delete_list_item').handler({ item_id: milk.itemId }, ctx));
  assert(deletedMilk.deleted === true, 'delete_list_item deletes an existing item');
  assert(delPool.items.find((i) => i.item_id === milk.itemId) === undefined, 'the deleted item is gone from list_items');
  await flush();
  assert(delPool.syncMap.find((m) => m.source_row_id === milk.itemId) === undefined, 'the deleted item\'s notion_sync_map row is gone too (in the background)');
  assert(delNotion.archivedPageIds.includes(milkPageId), 'the deleted item\'s Notion page was archived');

  const deletedMissing = await withDelUser((ctx) => delRegistry.get('delete_list_item').handler({ item_id: 'no-such-item' }, ctx));
  assert(deletedMissing.deleted === false, 'delete_list_item on a nonexistent id returns deleted: false rather than throwing');

  const otherUserId = '55555555-5555-5555-5555-555555555555';
  const deletedWrongUser = await delDb.withUserScope(otherUserId, (session) =>
    delRegistry.get('delete_list_item').handler({ item_id: eggs.itemId }, { userId: otherUserId, db: session }),
  );
  assert(deletedWrongUser.deleted === false, 'delete_list_item is user-scoped: another user cannot delete this item');
  assert(delPool.items.find((i) => i.item_id === eggs.itemId) !== undefined, 'the item survives a wrong-user delete attempt');

  const deletedUnknownList = await withDelUser((ctx) => delRegistry.get('delete_list').handler({ list_name: 'Nonexistent List' }, ctx));
  assert(
    deletedUnknownList.deleted === false && typeof deletedUnknownList.reason === 'string',
    'delete_list on an unknown name returns {deleted:false, reason} rather than throwing',
  );

  const eggsPageId = delPool.syncMap.find((m) => m.source_row_id === eggs.itemId).notion_page_id;
  const deletedList = await withDelUser((ctx) => delRegistry.get('delete_list').handler({ list_name: 'grocery list' }, ctx));
  assert(deletedList.deleted === true && deletedList.itemsDeleted === 1, 'delete_list (case-insensitive) removes the list and reports its one remaining item');
  assert(delPool.lists.length === 0, 'the list row itself is gone');
  assert(delPool.items.length === 0, 'no items remain after delete_list');
  await flush();
  assert(delPool.syncMap.length === 0, 'delete_list cleaned up every item\'s notion_sync_map row (in the background)');
  assert(delNotion.archivedPageIds.includes(eggsPageId), 'delete_list archived the remaining item\'s Notion page too');
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
  const tools = await registerTools({ llm, embeddings: null, cipher: null, notion: undefined, db });
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
  const noOrderTools = await registerTools({ llm: throwingLlm, embeddings: null, cipher: null, notion: undefined, db });
  const noOrderRegistry = createToolRegistry(noOrderTools);
  const noOrderResult = await withUser((ctx) =>
    noOrderRegistry.get('add_list_item').handler({ list_name: 'Books to Read', item_name: 'a novel' }, ctx),
  );
  assert(noOrderResult.itemId !== undefined, 'adding to a list with no section_order still succeeds');
  assert(pool.items.find((i) => i.item_name === 'a novel').section === null, 'the item is left unsectioned when its list has no section_order');

  // a classification failure never blocks the item from being added
  const failingLlm = createFakeLlm(() => undefined); // always throws inside createFakeLlm
  const failTools = await registerTools({ llm: failingLlm, embeddings: null, cipher: null, notion: undefined, db });
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

// --- get_lists / update_list_settings: per-list display flags, off by default ---
{
  const settingsPool = createFakePool();
  const settingsDb = createPostgresClient(settingsPool);
  const settingsUserId = '88888888-8888-8888-8888-888888888888';
  const settingsTools = await registerTools({ llm: null, embeddings: null, cipher: null, notion: undefined, db: settingsDb });
  const settingsRegistry = createToolRegistry(settingsTools);
  const withSettingsUser = (fn) => settingsDb.withUserScope(settingsUserId, (session) => fn({ userId: settingsUserId, db: session }));

  await withSettingsUser((ctx) => settingsRegistry.get('create_list').handler({ name: 'Errand List' }, ctx));
  const listsAfterCreate = await withSettingsUser((ctx) => settingsRegistry.get('get_lists').handler({}, ctx));
  assert(listsAfterCreate.length === 1, 'get_lists returns the one list that exists');
  assert(
    listsAfterCreate[0].showPriority === false && listsAfterCreate[0].showDueDates === false,
    'a new list defaults to both display flags off',
  );

  const toggledPriority = await withSettingsUser((ctx) =>
    settingsRegistry.get('update_list_settings').handler({ list_name: 'Errand List', show_priority: true }, ctx),
  );
  assert(toggledPriority.showPriority === true, 'update_list_settings turns show_priority on');
  assert(
    toggledPriority.showDueDates === false,
    'update_list_settings left show_due_dates untouched when only show_priority was given',
  );

  const afterToggle = await withSettingsUser((ctx) => settingsRegistry.get('get_lists').handler({}, ctx));
  assert(
    afterToggle[0].showPriority === true && afterToggle[0].showDueDates === false,
    'get_lists reflects the toggled state',
  );

  const toggledBoth = await withSettingsUser((ctx) =>
    settingsRegistry
      .get('update_list_settings')
      .handler({ list_name: 'Errand List', show_priority: false, show_due_dates: true }, ctx),
  );
  assert(
    toggledBoth.showPriority === false && toggledBoth.showDueDates === true,
    'update_list_settings can flip both flags in one call',
  );

  const onNewList = await withSettingsUser((ctx) =>
    settingsRegistry.get('update_list_settings').handler({ list_name: 'Brand New List', show_due_dates: true }, ctx),
  );
  assert(onNewList.showDueDates === true, 'update_list_settings creates the list first if it does not already exist');
  assert(settingsPool.lists.some((l) => l.name === 'Brand New List'), 'the new list was actually created');

  try {
    await withSettingsUser((ctx) => settingsRegistry.get('update_list_settings').handler({ list_name: 'Errand List' }, ctx));
    assert(false, 'update_list_settings with neither flag given is rejected');
  } catch {
    assert(true, 'update_list_settings with neither flag given is rejected');
  }
}

if (process.exitCode) {
  console.error('\nlists verification FAILED');
  process.exit(1);
}
console.log('\nlists verification passed');
