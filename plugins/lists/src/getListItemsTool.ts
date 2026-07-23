/**
 * @file plugins/lists/src/getListItemsTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — reads list items back
 * @description
 * Defaults to pending items only (the common "what do I still need to get" ask) across all of
 * the user's lists; pass list_name to scope to one list, or include_done to also see completed
 * items. Read-only, deterministic — no LLM reasoning involved in fetching, same as
 * get_shopping_patterns.
 *
 * @api-declaration
 * createGetListItemsTool() — returns the get_list_items RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface ItemRow {
  item_id: string;
  list_name: string;
  item_name: string;
  status: string;
  created_at: string;
  completed_at: string | null;
}

function isGetListItemsArgs(value: unknown): value is { list_name?: string; include_done?: boolean } {
  return typeof value === 'object' && value !== null;
}

export function createGetListItemsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_list_items',
      description:
        'Get items across the user\'s lists. Defaults to pending (not-yet-done) items on every list; optionally scope to one list by name or include already-completed items.',
      parameters: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: 'Optional: only return items from this list.' },
          include_done: { type: 'boolean', description: 'Optional: also include already-completed items.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetListItemsArgs(args)) {
        throw new Error('get_list_items requires an object argument');
      }
      const includeDone = args.include_done ?? false;

      const rows = await ctx.db.query<ItemRow>(
        `select li.item_id, l.name as list_name, li.item_name, li.status, li.created_at, li.completed_at
         from list_items li
         join lists l on l.list_id = li.list_id
         where li.user_id = $1
           and ($2::text is null or lower(l.name) = lower($2))
           and ($3 or li.status = 'pending')
         order by l.name, li.created_at`,
        [ctx.userId, args.list_name ?? null, includeDone],
      );

      return rows.map((r) => ({
        itemId: r.item_id,
        listName: r.list_name,
        itemName: r.item_name,
        status: r.status,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      }));
    },
  };
}
