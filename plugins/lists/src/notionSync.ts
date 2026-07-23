/**
 * @file plugins/lists/src/notionSync.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — the mint-and-stamp bridge between list_items and Notion
 * @description
 * docs/spec.md §6.4's identity mechanism: the only place a list_items row is linked to a Notion
 * page is notion_sync_map, keyed by (source_table='list_items', source_row_id). First sync
 * creates the Notion page and mints that mapping row; every later sync looks the mapping up and
 * updates the existing page — never trusting Notion's own page content to say which row it is.
 *
 * Deliberately best-effort: called after the Postgres write already succeeded, wrapped so a
 * Notion/network failure is logged but never fails the tool call or the user's chat turn back to
 * them. Postgres is already correct regardless of whether this succeeds — per spec.md, Notion
 * always loses on divergence, so a missed sync is stale until the next edit, not a data problem.
 * A no-op when notion is undefined (not configured) — see io/notion.ts.
 *
 * Also a no-op when userId isn't notion.ownerUserId: this gateway syncs one Notion workspace to
 * one owning bigBrain user (io/notion.ts), not one workspace per household member. Caught live —
 * a test account's writes were pushing into the real owner's Notion workspace with nothing to
 * stop it, since this check didn't exist before. Every other bigBrain user's lists/list_items
 * stay Postgres-only and fully isolated by RLS; they just never leave Postgres.
 *
 * @api-declaration
 * syncListItemToNotion(db, notion, userId, item) — fire-and-forget-safe; never throws
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, Notion API IO)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), Notion API (via NotionClient)]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import type { NotionClient } from '@bigbrain/orchestrator/notion';

export interface SyncableListItem {
  itemId: string;
  itemName: string;
  listName: string;
  status: string;
  completedAt: string | null;
}

// Shared with notionReconcile.ts (the inbound direction) so both directions agree on the
// notion_sync_map.source_table value for this plugin's rows.
export const SOURCE_TABLE = 'list_items';

export async function syncListItemToNotion(
  db: DbSession,
  notion: NotionClient | undefined,
  userId: string,
  item: SyncableListItem,
): Promise<void> {
  if (!notion || userId !== notion.ownerUserId) return;

  try {
    const existing = await db.query<{ notion_page_id: string }>(
      `select notion_page_id from notion_sync_map where source_table = $1 and source_row_id = $2`,
      [SOURCE_TABLE, item.itemId],
    );

    const { pageId } = await notion.upsertListItemPage({
      pageId: existing[0]?.notion_page_id,
      itemName: item.itemName,
      listName: item.listName,
      done: item.status === 'done',
      completedAt: item.completedAt,
    });

    if (existing[0]) {
      await db.query(`update notion_sync_map set last_synced_at = now() where source_table = $1 and source_row_id = $2`, [
        SOURCE_TABLE,
        item.itemId,
      ]);
    } else {
      await db.query(
        `insert into notion_sync_map (user_id, source_table, source_row_id, notion_database_id, notion_page_id, last_synced_at)
         values ($1, $2, $3, $4, $5, now())`,
        [userId, SOURCE_TABLE, item.itemId, notion.listsDataSourceId, pageId],
      );
    }
  } catch (err) {
    log.error(`Notion sync failed for list_items row ${item.itemId} (Postgres write already succeeded, unaffected)`, err);
  }
}
