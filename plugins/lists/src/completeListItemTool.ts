/**
 * @file plugins/lists/src/completeListItemTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — marks a list item done
 * @description
 * Only records that the item was completed (status + completed_at) — deliberately does not
 * write to shopping_logs or any other table, even for items on a list tagged "shopping". That
 * linkage was considered and explicitly rejected: maintaining real inventory/pantry state was
 * judged not worth the complexity until there's an actual use for it (see docs/spec.md).
 *
 * item_name lookup is case-insensitive and, when list_name is omitted, searches across all of
 * the user's lists. If more than one pending item matches, completes the most recently created
 * one — a deliberate, simple tie-break (most likely the one just referred to) rather than
 * failing or asking the model to disambiguate by item_id for what should be a low-stakes,
 * common action.
 *
 * After a successful completion, best-effort syncs the change to Notion (notionSync.ts) — never
 * fails this tool call if that sync fails.
 *
 * @api-declaration
 * createCompleteListItemTool(notion) — returns the complete_list_item RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, best-effort Notion IO)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), Notion API]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { NotionClient } from '@bigbrain/orchestrator/notion';
import { syncListItemToNotion } from './notionSync.js';

function isCompleteListItemArgs(value: unknown): value is { item_name: string; list_name?: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.item_name === 'string' && v.item_name !== '';
}

export function createCompleteListItemTool(notion: NotionClient | undefined): RegisteredTool {
  return {
    definition: {
      name: 'complete_list_item',
      description:
        'Mark a list item as done (e.g. checking it off). If multiple pending items match the name, completes the most recently added one. Optionally scope the search to one list by name.',
      parameters: {
        type: 'object',
        properties: {
          item_name: { type: 'string', description: 'The name of the item to mark done.' },
          list_name: { type: 'string', description: 'Optional: only look for the item on this list.' },
        },
        required: ['item_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCompleteListItemArgs(args)) {
        throw new Error('complete_list_item requires a non-empty item_name: string argument');
      }

      const rows = await ctx.db.query<{ item_id: string; list_id: string; list_name: string; completed_at: string }>(
        `update list_items li
         set status = 'done', completed_at = now()
         from lists l
         where li.list_id = l.list_id
           and li.item_id = (
             select li2.item_id
             from list_items li2
             join lists l2 on l2.list_id = li2.list_id
             where li2.user_id = $1
               and li2.status = 'pending'
               and lower(li2.item_name) = lower($2)
               and ($3::text is null or lower(l2.name) = lower($3))
             order by li2.created_at desc
             limit 1
           )
         returning li.item_id, li.list_id, l.name as list_name, li.completed_at`,
        [ctx.userId, args.item_name, args.list_name ?? null],
      );

      if (!rows[0]) {
        return { completed: false, reason: `no pending item named "${args.item_name}" was found` };
      }
      const item = rows[0];

      await syncListItemToNotion(ctx.db, notion, ctx.userId, {
        itemId: item.item_id,
        itemName: args.item_name,
        listName: item.list_name,
        status: 'done',
        completedAt: item.completed_at,
      });

      return { completed: true, itemId: item.item_id, listId: item.list_id, itemName: args.item_name };
    },
  };
}
