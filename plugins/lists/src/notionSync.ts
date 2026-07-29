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
 * "Best-effort" used to still mean *awaited*: every call site ran this inline inside its own
 * request's transaction before responding, so a slow/flaky Notion API (retried once via
 * io/httpRetry.ts on a stale-socket failure) added several real seconds of latency to ticking a
 * checkbox or adding an item, even though the eventual result never depended on it — caught live
 * 2026-07-29, a Notion outage made completing an item in the native frontend feel completely
 * unresponsive on a slow mobile connection. Fixed by *not* awaiting these calls at their call
 * sites at all (`syncListItemToNotionInBackground`/`cleanupListItemNotionPageInBackground` below)
 * — but that means they can no longer reuse the caller's own `DbSession`: postgres.ts's
 * `inTransaction` releases that connection back to the pool as soon as the request's own handler
 * returns, which happens *before* an un-awaited background call has finished with it. Each
 * background wrapper instead opens its own independent `withUserScope` transaction against the
 * top-level `PostgresClient`, so it keeps working correctly no matter how long after the response
 * was sent it actually finishes.
 *
 * @api-declaration
 * syncListItemToNotion(db, notion, userId, item) — never throws; still runs *inside* the
 *   caller's own request-scoped transaction/session, so only awaitable, in-transaction callers
 *   (currently none — see the *InBackground wrappers below) should call it directly
 * cleanupListItemNotionPage(db, notion, userId, itemId) — archives the mirrored Notion page (if
 *   any) and drops its notion_sync_map row; same never-throw, same in-transaction contract
 * syncListItemToNotionInBackground(db, notion, userId, item) — fire-and-forget: opens its *own*
 *   withUserScope transaction and never rejects, so callers must NOT await it and must NOT pass
 *   it their request's own DbSession (see below for why)
 * cleanupListItemNotionPageInBackground(db, notion, userId, itemId) — same shape, for cleanup
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO, Notion API IO)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession/PostgresClient it's given), Notion API (via
 *                      NotionClient)]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { DbSession, PostgresClient } from '@bigbrain/orchestrator/postgres';
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

export async function cleanupListItemNotionPage(
  db: DbSession,
  notion: NotionClient | undefined,
  userId: string,
  itemId: string,
): Promise<void> {
  if (!notion || userId !== notion.ownerUserId) return;

  try {
    const existing = await db.query<{ notion_page_id: string }>(
      `select notion_page_id from notion_sync_map where source_table = $1 and source_row_id = $2`,
      [SOURCE_TABLE, itemId],
    );
    if (!existing[0]) return;

    await notion.archivePage(existing[0].notion_page_id);
    await db.query(`delete from notion_sync_map where source_table = $1 and source_row_id = $2`, [SOURCE_TABLE, itemId]);
  } catch (err) {
    log.error(`Notion cleanup failed for list_items row ${itemId} (Postgres delete proceeds regardless)`, err);
  }
}

// Fire-and-forget entry points for request handlers: deliberately not `await`ed at the call site,
// so each opens its own withUserScope transaction against the top-level PostgresClient rather than
// reusing the request's own DbSession, which would already be back in the pool by the time this
// runs. Both underlying functions already never throw, but withUserScope itself can reject (e.g.
// pool exhaustion) — caught here too so a background sync failure is logged, never an unhandled
// rejection. The ownerUserId/notion-configured check is duplicated from the underlying functions
// so the common case (Notion not configured, or this user isn't its owner) skips opening a
// transaction at all rather than opening one just to no-op inside it.
export function syncListItemToNotionInBackground(
  db: PostgresClient,
  notion: NotionClient | undefined,
  userId: string,
  item: SyncableListItem,
): void {
  if (!notion || userId !== notion.ownerUserId) return;
  void db.withUserScope(userId, (session) => syncListItemToNotion(session, notion, userId, item)).catch((err) => {
    log.error(`background Notion sync crashed unexpectedly for list_items row ${item.itemId}`, err);
  });
}

export function cleanupListItemNotionPageInBackground(
  db: PostgresClient,
  notion: NotionClient | undefined,
  userId: string,
  itemId: string,
): void {
  if (!notion || userId !== notion.ownerUserId) return;
  void db.withUserScope(userId, (session) => cleanupListItemNotionPage(session, notion, userId, itemId)).catch((err) => {
    log.error(`background Notion cleanup crashed unexpectedly for list_items row ${itemId}`, err);
  });
}
