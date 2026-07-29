/**
 * @file plugins/lists/src/deleteListItemTool.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — deletes a single list item
 * @description
 * A real delete, no soft-delete/archive concept — same as delete_note. Notion cleanup
 * (cleanupListItemNotionPage, notionSync.ts) runs in the background, not awaited, so a slow or
 * failing Notion API never adds latency to deleting an item — the item is gone from Postgres
 * immediately regardless; the Notion page just lags behind until cleanup catches up (see
 * notionSync.ts's header for why this matters and why it's still safe).
 *
 * @api-declaration
 * createDeleteListItemTool(notion, db) — returns the delete_list_item RegisteredTool
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
import { cleanupListItemNotionPageInBackground } from './notionSync.js';

function isDeleteListItemArgs(value: unknown): value is { item_id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.item_id === 'string' && v.item_id !== '';
}

export function createDeleteListItemTool(notion: NotionClient | undefined, db: PostgresClient): RegisteredTool {
  return {
    definition: {
      name: 'delete_list_item',
      description: 'Delete a list item by id.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The item to delete, from get_list_items/add_list_item.' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteListItemArgs(args)) {
        throw new Error('delete_list_item requires an item_id: string argument');
      }

      cleanupListItemNotionPageInBackground(db, notion, ctx.userId, args.item_id);

      const rows = await ctx.db.query<{ item_id: string }>(
        'delete from list_items where item_id = $1 and user_id = $2 returning item_id',
        [args.item_id, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
