/**
 * @file plugins/lists/src/getListsTool.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — reads back the user's lists themselves, not their items
 * @description
 * Everything else in this plugin surfaces lists only indirectly, by distinct-ing list_name off of
 * get_list_items's rows (see ListsBrowser.tsx's own comment) — which means a list with zero items
 * is invisible to any caller. That gap didn't matter until per-list display settings
 * (show_priority/show_due_dates, db/migrations/0041_list_display_flags.sql) needed somewhere to
 * live for a list the frontend hasn't fetched any items for yet, e.g. a just-created empty list.
 * This tool is the fix: a direct read of the `lists` rows themselves.
 *
 * @api-declaration
 * createGetListsTool() — returns the get_lists RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface ListRow {
  list_id: string;
  name: string;
  tags: string[];
  show_priority: boolean;
  show_due_dates: boolean;
}

export function createGetListsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_lists',
      description: "Get the user's lists themselves (name, tags, and display settings) — not their items. Use get_list_items for items.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<ListRow>(
        `select list_id, name, tags, show_priority, show_due_dates from lists where user_id = $1 order by name`,
        [ctx.userId],
      );

      return rows.map((r) => ({
        listId: r.list_id,
        name: r.name,
        tags: r.tags,
        showPriority: r.show_priority,
        showDueDates: r.show_due_dates,
      }));
    },
  };
}
