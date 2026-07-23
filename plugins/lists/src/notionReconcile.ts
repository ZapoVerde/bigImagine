/**
 * @file plugins/lists/src/notionReconcile.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — inbound half of the Notion Sync Gateway (docs/spec.md §6.4)
 * @description
 * Polling, not a webhook endpoint: Notion's own webhook system exists (confirmed live in the
 * connection's dashboard), but polling avoids exposing a new public inbound route on the
 * orchestrator (which today accepts zero unauthenticated inbound traffic — see spec.md's Phase 5
 * network-perimeter notes) and avoids verifying webhook payload signatures for a household-scale
 * feature where a ~30s poll delay is imperceptible. Revisit if that latency ever actually matters.
 *
 * For every page currently in the Lists data source:
 *   - Known (in notion_sync_map, matched by notion_page_id): adopt ONLY its Done/Completed-At
 *     state into Postgres — never its Item/List (name) properties. Postgres stays authoritative
 *     for identity/naming; a rename in Notion is simply overwritten back by the next outbound
 *     push (io/notion.ts). Checking something off in Notion is the explicit feature; silently
 *     renaming bigBrain's own data from an external edit is not.
 *   - Unmapped (no matching sync_map row): a page created directly in Notion, not yet tracked.
 *     Adopted as a brand-new list_items row (creating its list via findOrCreateList if needed),
 *     attributed to notion.ownerUserId, with a fresh notion_sync_map entry minted right then —
 *     this is the "add items directly in Notion" half of what was asked for. Pages with no title
 *     yet (still being typed) are skipped until a later poll sees a real name.
 *
 * Each page is reconciled in its own transaction (db.withUserScope per page, not once for the
 * whole batch) rather than one on failure. Caught live: outbound sync (io/notion.ts +
 * notionSync.ts) creates the Notion page, THEN inserts notion_sync_map — a real window exists
 * between those two steps where a poll landing in that window sees the brand-new page as
 * "unmapped" and would otherwise adopt it a second time. notion_sync_map.notion_page_id now has
 * a unique constraint (db/migrations/0005) that turns that race into a caught conflict instead of
 * a silent duplicate row — one page's conflict is logged and skipped without rolling back
 * everything else this poll would have otherwise reconciled.
 *
 * @api-declaration
 * reconcileOnce(db, notion) — runs a single poll pass; exported (not just used internally by the
 *   loop below) so it can be called deterministically in verification, without racing real timers
 * startNotionReconcileLoop(db, notion, intervalMs) — returns the interval handle (unref'd so it
 *   never keeps the process alive on its own)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, Notion API IO, owns a timer)
 *     state_ownership: [the setInterval timer it starts]
 *     external_io:     [Postgres (via PostgresClient), Notion API (via NotionClient)]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import type { NotionClient, NotionListItemPage } from '@bigbrain/orchestrator/notion';
import { findOrCreateList } from './listLookup.js';
import { SOURCE_TABLE } from './notionSync.js';

async function reconcilePage(db: PostgresClient, notion: NotionClient, page: NotionListItemPage): Promise<void> {
  await db.withUserScope(notion.ownerUserId, async (session) => {
    const existing = await session.query<{ source_row_id: string }>(
      `select source_row_id from notion_sync_map where source_table = $1 and notion_page_id = $2`,
      [SOURCE_TABLE, page.pageId],
    );

    if (existing[0]) {
      const status = page.done ? 'done' : 'pending';
      const completedAt = page.done ? page.completedAt ?? new Date().toISOString() : null;
      await session.query(
        `update list_items set status = $2, completed_at = $3
         where item_id = $1 and status is distinct from $2`,
        [existing[0].source_row_id, status, completedAt],
      );
      return;
    }

    if (!page.itemName) return; // still being typed in Notion, no title yet

    const { listId } = await findOrCreateList(session, notion.ownerUserId, page.listName || 'Notion Inbox');
    const status = page.done ? 'done' : 'pending';
    const completedAt = page.done ? page.completedAt ?? new Date().toISOString() : null;

    const inserted = await session.query<{ item_id: string }>(
      `insert into list_items (list_id, user_id, item_name, status, completed_at)
       values ($1, $2, $3, $4, $5) returning item_id`,
      [listId, notion.ownerUserId, page.itemName, status, completedAt],
    );

    // Can conflict on notion_page_id if outbound sync (io/notion.ts) created this same page and
    // is mid-way through writing its own sync_map row — see the module docstring. Throwing here
    // rolls back just this page's transaction (including the list_items insert above), and the
    // caller logs + moves on to the next page rather than aborting the whole poll.
    await session.query(
      `insert into notion_sync_map (user_id, source_table, source_row_id, notion_database_id, notion_page_id, last_synced_at)
       values ($1, $2, $3, $4, $5, now())`,
      [notion.ownerUserId, SOURCE_TABLE, inserted[0]!.item_id, notion.listsDataSourceId, page.pageId],
    );
    log.info(`adopted a new list item created directly in Notion: "${page.itemName}"`);
  });
}

export async function reconcileOnce(db: PostgresClient, notion: NotionClient): Promise<void> {
  const pages = await notion.queryListItemsDataSource();

  for (const page of pages) {
    try {
      await reconcilePage(db, notion, page);
    } catch (err) {
      log.error(`failed to reconcile Notion page ${page.pageId} (skipped, will retry next poll)`, err);
    }
  }
}

export function startNotionReconcileLoop(
  db: PostgresClient,
  notion: NotionClient,
  intervalMs: number,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    reconcileOnce(db, notion).catch((err) => {
      log.error('Notion reconciliation poll failed (will retry next interval)', err);
    });
  }, intervalMs);
  timer.unref();
  return timer;
}
