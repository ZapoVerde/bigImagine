// Proves the inbound half of Notion sync (notionReconcile.ts) against a stateful fake Postgres
// pool + a fake NotionClient returning canned queryListItemsDataSource() results — covering the
// real cases: a known item's Done state changing in Notion, a brand-new page typed directly into
// Notion getting adopted, a still-untitled page being skipped, and an already-correct item being
// left untouched. Calls reconcileOnce(db, notion) directly and awaits it — deterministic, no
// racing setInterval against a wall-clock wait.

import { createPostgresClient } from '@bigbrain/orchestrator/postgres';
import { reconcileOnce, startNotionReconcileLoop } from '../dist/notionReconcile.js';

function assert(cond, message) {
  if (!cond) {
    console.error(`FAIL: ${message}`);
    process.exitCode = 1;
  } else {
    console.log(`ok: ${message}`);
  }
}

const OWNER_USER_ID = '11111111-1111-1111-1111-111111111111';

// Simulates real transaction semantics (unlike the simpler fake pools elsewhere in this repo):
// each connection stages its writes against a private copy and only merges them into the shared
// arrays on COMMIT; ROLLBACK discards the staged copy entirely. This matters specifically for
// testing the notion_page_id conflict path below, where a failed insert must leave no trace —
// including the list_items row inserted earlier in that same transaction.
// raceSimulation, if given, injects a "concurrent commit" — a sync_map row for a specific
// page_id appearing in the committed (not staged) store right after that page's SELECT runs and
// finds nothing. This reproduces the exact live race: reconcile's SELECT sees no mapping, but by
// the time its own INSERT runs, another transaction (outbound sync) has already claimed the page.
function createFakePool(seed, raceSimulation) {
  const lists = [...seed.lists];
  const items = [...seed.items];
  const syncMap = [...seed.syncMap];
  let listCounter = lists.length;
  let itemCounter = items.length;

  return {
    lists,
    items,
    syncMap,
    async connect() {
      let staged;

      return {
        async query(sql, params = []) {
          if (sql === 'BEGIN') {
            staged = { lists: [...lists], items: [...items], syncMap: [...syncMap] };
            return { rows: [] };
          }
          if (sql === 'COMMIT') {
            lists.length = 0;
            lists.push(...staged.lists);
            items.length = 0;
            items.push(...staged.items);
            syncMap.length = 0;
            syncMap.push(...staged.syncMap);
            return { rows: [] };
          }
          if (sql === 'ROLLBACK') {
            staged = undefined; // discard whatever this transaction staged
            return { rows: [] };
          }
          if (sql.includes('set_config')) return { rows: [] };

          if (sql.includes('select source_row_id from notion_sync_map')) {
            const [sourceTable, pageId] = params;
            const match = staged.syncMap.find((m) => m.source_table === sourceTable && m.notion_page_id === pageId);
            if (!match && raceSimulation && pageId === raceSimulation.pageId) {
              // simulate another (already-committed) transaction claiming this page right now
              syncMap.push(raceSimulation.concurrentEntry);
            }
            return { rows: match ? [{ source_row_id: match.source_row_id }] : [] };
          }
          if (sql.startsWith('update list_items set status')) {
            const [itemId, status, completedAt] = params;
            const item = staged.items.find((i) => i.item_id === itemId);
            if (item && item.status !== status) {
              item.status = status;
              item.completed_at = completedAt;
            }
            return { rows: [] };
          }
          if (sql.includes('select list_id from lists where')) {
            const [userId, name] = params;
            const match = staged.lists.find((l) => l.user_id === userId && l.name.toLowerCase() === name.toLowerCase());
            return { rows: match ? [{ list_id: match.list_id }] : [] };
          }
          if (sql.includes('insert into lists')) {
            const [userId, name, tags] = params;
            const list_id = `list-${++listCounter}`;
            staged.lists.push({ list_id, user_id: userId, name, tags });
            return { rows: [{ list_id }] };
          }
          if (sql.startsWith('insert into list_items')) {
            const [listId, userId, itemName, status, completedAt] = params;
            const item_id = `item-${++itemCounter}`;
            staged.items.push({ item_id, list_id: listId, user_id: userId, item_name: itemName, status, completed_at: completedAt });
            return { rows: [{ item_id }] };
          }
          if (sql.includes('insert into notion_sync_map')) {
            const [userId, sourceTable, sourceRowId, notionDatabaseId, notionPageId] = params;
            // Checked against the committed array, not staged — simulates the unique constraint
            // catching a page another (already-committed) transaction claimed first.
            if (syncMap.some((m) => m.notion_page_id === notionPageId)) {
              throw new Error('duplicate key value violates unique constraint "notion_sync_map_notion_page_id_key"');
            }
            staged.syncMap.push({ user_id: userId, source_table: sourceTable, source_row_id: sourceRowId, notion_database_id: notionDatabaseId, notion_page_id: notionPageId });
            return { rows: [] };
          }

          throw new Error(`fake pool got an unexpected query: ${sql}`);
        },
        release() {},
      };
    },
  };
}

function createFakeNotionClient(pages) {
  return {
    listsDataSourceId: 'fake-data-source-id',
    ownerUserId: OWNER_USER_ID,
    async queryListItemsDataSource() {
      return pages;
    },
  };
}

// --- Scenario 1: a known item's Done state changes in Notion (unchecked -> checked) ---
{
  const seed = {
    lists: [{ list_id: 'list-1', user_id: OWNER_USER_ID, name: 'Grocery List', tags: [] }],
    items: [{ item_id: 'item-1', list_id: 'list-1', user_id: OWNER_USER_ID, item_name: 'milk', status: 'pending', completed_at: null }],
    syncMap: [{ user_id: OWNER_USER_ID, source_table: 'list_items', source_row_id: 'item-1', notion_database_id: 'fake-data-source-id', notion_page_id: 'notion-page-1' }],
  };
  const pool = createFakePool(seed);
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([
    { pageId: 'notion-page-1', itemName: 'milk', listName: 'Grocery List', done: true, completedAt: '2026-07-23T00:00:00Z' },
  ]);

  await reconcileOnce(db, notion);

  const item = pool.items.find((i) => i.item_id === 'item-1');
  assert(item.status === 'done', 'a known item checked off in Notion is marked done in Postgres');
  assert(item.completed_at === '2026-07-23T00:00:00Z', "the item's completed_at is adopted from Notion");
  assert(pool.syncMap.length === 1, 'no duplicate sync_map row was created for an already-known page');
}

// --- Scenario 2: an unmapped page (typed directly into Notion) gets adopted ---
{
  const pool = createFakePool({ lists: [], items: [], syncMap: [] });
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([
    { pageId: 'notion-page-2', itemName: 'stamps', listName: 'Errand List', done: false, completedAt: null },
  ]);

  await reconcileOnce(db, notion);

  assert(pool.items.length === 1 && pool.items[0].item_name === 'stamps', 'a page with no sync_map entry is adopted as a new list_items row');
  assert(pool.items[0].user_id === OWNER_USER_ID, 'the adopted item is attributed to notion.ownerUserId');
  assert(pool.lists.length === 1 && pool.lists[0].name === 'Errand List', "the item's list is created if it didn't exist");
  assert(
    pool.syncMap.some((m) => m.notion_page_id === 'notion-page-2' && m.source_row_id === pool.items[0].item_id),
    'a fresh notion_sync_map row is minted linking the new item back to the Notion page',
  );

  // a second poll of the same (now-mapped) page must not adopt it again as a duplicate
  await reconcileOnce(db, notion);
  assert(pool.items.length === 1, 'polling again after adoption does not create a duplicate item');
  assert(pool.syncMap.length === 1, 'polling again after adoption does not mint a duplicate sync_map row');
}

// --- Scenario 2b: the live-caught race — outbound sync claims a page between reconcile's SELECT
// and INSERT. Must not leave an orphaned list_items row, and must not touch a second, unrelated
// page in the same poll batch. ---
{
  const pool = createFakePool(
    { lists: [], items: [], syncMap: [] },
    {
      pageId: 'notion-page-race',
      concurrentEntry: {
        user_id: OWNER_USER_ID,
        source_table: 'list_items',
        source_row_id: 'item-from-outbound-sync',
        notion_database_id: 'fake-data-source-id',
        notion_page_id: 'notion-page-race',
      },
    },
  );
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([
    { pageId: 'notion-page-race', itemName: 'racing item', listName: 'Errand List', done: false, completedAt: null },
    { pageId: 'notion-page-unrelated', itemName: 'unrelated item', listName: 'Errand List', done: false, completedAt: null },
  ]);

  await reconcileOnce(db, notion);

  assert(
    !pool.items.some((i) => i.item_name === 'racing item'),
    'the raced page leaves no orphaned list_items row when its sync_map insert conflicts',
  );
  assert(
    pool.syncMap.filter((m) => m.notion_page_id === 'notion-page-race').length === 1,
    'the raced page still has exactly one sync_map row — the concurrent one that won, not a second one',
  );
  assert(
    pool.items.some((i) => i.item_name === 'unrelated item'),
    'a second, unrelated page in the same poll batch is still reconciled despite the first one conflicting',
  );
}

// --- Scenario 3: a still-untitled page (empty Item title) is skipped, not adopted as a blank item ---
{
  const pool = createFakePool({ lists: [], items: [], syncMap: [] });
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([{ pageId: 'notion-page-3', itemName: '', listName: '', done: false, completedAt: null }]);

  await reconcileOnce(db, notion);

  assert(pool.items.length === 0, 'a page with no title yet is skipped, not adopted as a blank item');
  assert(pool.syncMap.length === 0, 'no sync_map row is minted for a skipped untitled page');
}

// --- Scenario 4: an already-correct item is left untouched (no redundant write) ---
{
  const seed = {
    lists: [{ list_id: 'list-1', user_id: OWNER_USER_ID, name: 'Grocery List', tags: [] }],
    items: [{ item_id: 'item-1', list_id: 'list-1', user_id: OWNER_USER_ID, item_name: 'milk', status: 'pending', completed_at: null }],
    syncMap: [{ user_id: OWNER_USER_ID, source_table: 'list_items', source_row_id: 'item-1', notion_database_id: 'fake-data-source-id', notion_page_id: 'notion-page-1' }],
  };
  const pool = createFakePool(seed);
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([
    { pageId: 'notion-page-1', itemName: 'milk', listName: 'Grocery List', done: false, completedAt: null },
  ]);

  await reconcileOnce(db, notion);

  const item = pool.items.find((i) => i.item_id === 'item-1');
  assert(item.status === 'pending' && item.completed_at === null, 'an item whose Notion state matches Postgres already stays unchanged');
}

// --- Scenario 5: startNotionReconcileLoop actually wires a real, unref'd interval ---
{
  const pool = createFakePool({ lists: [], items: [], syncMap: [] });
  const db = createPostgresClient(pool);
  const notion = createFakeNotionClient([
    { pageId: 'notion-page-5', itemName: 'batteries', listName: 'Errand List', done: false, completedAt: null },
  ]);

  const timer = startNotionReconcileLoop(db, notion, 10);
  await new Promise((resolve) => setTimeout(resolve, 50));
  clearInterval(timer);

  assert(pool.items.some((i) => i.item_name === 'batteries'), 'startNotionReconcileLoop actually invokes reconcileOnce on its interval');
}

if (process.exitCode) {
  console.error('\nnotion reconcile verification FAILED');
  process.exit(1);
}
console.log('\nnotion reconcile verification passed');
