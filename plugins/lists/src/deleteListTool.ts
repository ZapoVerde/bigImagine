/**
 * @file plugins/lists/src/deleteListTool.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — deletes a whole list and everything on it
 * @description
 * list_items.list_id has no cascade (db/migrations/0004_lists.sql), so deleting a list with items
 * still on it would otherwise fail at the DB level with an FK violation. This tool deletes the
 * items first — then the list row itself, all within this one handler call (already one
 * transaction via withUserScope). Each item's Notion cleanup (same as delete_list_item) fires in
 * the background, not awaited — deleting a list with many Notion-synced items would otherwise
 * block the response for one Notion round trip per item; notion_sync_map has no FK to list_items
 * (db/migrations/0002_schema.sql), so cleaning it up after the list's rows are already gone is
 * safe.
 *
 * Addressed by name, not list_id, matching add_list_item/complete_list_item — the frontend's
 * ListsBrowser only ever has list names (list_id is never surfaced to it).
 *
 * @api-declaration
 * createDeleteListTool(notion, db) — returns the delete_list RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session; best-effort background
 *                      Notion API IO when notion is configured)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given, and independently via db for the
 *                      background Notion cleanup), Notion API (via NotionClient)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { NotionClient } from '@bigbrain/orchestrator/notion';
import type { PostgresClient } from '@bigbrain/orchestrator/postgres';
import { findListByName } from './listLookup.js';
import { cleanupListItemNotionPageInBackground } from './notionSync.js';

function isDeleteListArgs(value: unknown): value is { list_name: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.list_name === 'string' && v.list_name !== '';
}

export function createDeleteListTool(notion: NotionClient | undefined, db: PostgresClient): RegisteredTool {
  return {
    definition: {
      name: 'delete_list',
      description: 'Delete an entire list and all of its items, by name.',
      parameters: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: 'The list to delete.' },
        },
        required: ['list_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteListArgs(args)) {
        throw new Error('delete_list requires a list_name: string argument');
      }

      const list = await findListByName(ctx.db, ctx.userId, args.list_name);
      if (!list) {
        return { deleted: false, reason: `no list named "${args.list_name}"` };
      }

      const items = await ctx.db.query<{ item_id: string }>('select item_id from list_items where list_id = $1 and user_id = $2', [
        list.listId,
        ctx.userId,
      ]);
      for (const item of items) {
        cleanupListItemNotionPageInBackground(db, notion, ctx.userId, item.item_id);
      }

      await ctx.db.query('delete from list_items where list_id = $1 and user_id = $2', [list.listId, ctx.userId]);
      const [row] = await ctx.db.query<{ list_id: string; name: string }>(
        'delete from lists where list_id = $1 and user_id = $2 returning list_id, name',
        [list.listId, ctx.userId],
      );

      return { deleted: true, listId: row!.list_id, name: row!.name, itemsDeleted: items.length };
    },
  };
}
