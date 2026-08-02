/**
 * @file plugins/lists/src/deleteListItemTool.ts
 * @stamp 2026-08-01
 * @architectural-role IO Wrapper — deletes a single list item
 * @description
 * A real delete, no soft-delete/archive concept — same as delete_note. Notion cleanup
 * (cleanupListItemNotionPage, notionSync.ts) runs in the background, not awaited, so a slow or
 * failing Notion API never adds latency to deleting an item — the item is gone from Postgres
 * immediately regardless; the Notion page just lags behind until cleanup catches up (see
 * notionSync.ts's header for why this matters and why it's still safe).
 *
 * Addressed by item_id, or by item_name (+ optional list_name), same case-insensitive
 * most-recently-created tie-break as complete_list_item's name lookup — without it, every delete
 * of a named item costs a mandatory get_list_items round just to resolve the id first (caught
 * live 2026-08-01: a "remove X, add Y instead" turn burned every maxToolRounds round on lookups
 * and never got to act).
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

function isDeleteListItemArgs(
  value: unknown,
): value is { item_id?: string; item_name?: string; list_name?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.item_id !== undefined && (typeof v.item_id !== 'string' || v.item_id === '')) return false;
  if (v.item_name !== undefined && (typeof v.item_name !== 'string' || v.item_name === '')) return false;
  if (v.list_name !== undefined && typeof v.list_name !== 'string') return false;
  return Boolean(v.item_id) || Boolean(v.item_name);
}

export function createDeleteListItemTool(notion: NotionClient | undefined, db: PostgresClient): RegisteredTool {
  return {
    definition: {
      name: 'delete_list_item',
      description:
        'Delete a list item, either by id or by name. If multiple items match the name, deletes the ' +
        'most recently added one. Optionally scope a name lookup to one list.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The item to delete, from get_list_items/add_list_item.' },
          item_name: { type: 'string', description: 'The name of the item to delete, if item_id is not known.' },
          list_name: { type: 'string', description: 'Optional: only look for item_name on this list.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteListItemArgs(args)) {
        throw new Error('delete_list_item requires an item_id or item_name: string argument');
      }

      let itemId = args.item_id;
      if (!itemId) {
        const [match] = await ctx.db.query<{ item_id: string }>(
          `select li.item_id
           from list_items li
           join lists l on l.list_id = li.list_id
           where li.user_id = $1
             and lower(li.item_name) = lower($2)
             and ($3::text is null or lower(l.name) = lower($3))
           order by li.created_at desc
           limit 1`,
          [ctx.userId, args.item_name, args.list_name ?? null],
        );
        if (!match) return { deleted: false, reason: `no item named "${args.item_name}" was found` };
        itemId = match.item_id;
      }

      cleanupListItemNotionPageInBackground(db, notion, ctx.userId, itemId);

      const rows = await ctx.db.query<{ item_id: string }>(
        'delete from list_items where item_id = $1 and user_id = $2 returning item_id',
        [itemId, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
