/**
 * @file plugins/lists/src/getListItemsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — reads list items back
 * @description
 * Defaults to pending items only (the common "what do I still need to get" ask) across all of
 * the user's lists; pass list_name to scope to one list, or include_done to also see completed
 * items. Read-only, deterministic — no LLM reasoning involved in fetching, same as
 * get_shopping_patterns.
 *
 * Sorted by each item's own list's section_order (set_list_section_order.ts) when that list has
 * one defined — e.g. a grocery list sorted into the order you actually walk the store, not
 * creation order. Done in JS, not SQL: results can span multiple lists at once (list_name is
 * optional), each with its own independent section_order, which is awkward to express as a single
 * SQL ORDER BY but trivial as a per-row array index lookup here. A list with no section_order (or
 * an item with no classified section) falls back to created_at, unchanged from before this existed.
 *
 * priority/due_at (db/migrations/0024_action_dates_priority.sql, docs/spec.md's action-dates
 * addition) are passed through as plain columns here, unsorted by this tool — this stays
 * section-order sorted for the "what do I still need to get" shopping-list case; a separate
 * time-then-priority ranked view is a different tool's job (the Landing Deck's action queue), not
 * this one's default.
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
  section_order: string[];
  section: string | null;
  item_name: string;
  status: string;
  priority: string | null;
  due_at: string | null;
  created_at: string;
  completed_at: string | null;
}

function sectionRank(row: ItemRow): number {
  if (!row.section) return Infinity;
  const index = row.section_order.indexOf(row.section);
  return index === -1 ? Infinity : index;
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
        `select li.item_id, l.name as list_name, l.section_order, li.section, li.item_name, li.status, li.priority, li.due_at, li.created_at, li.completed_at
         from list_items li
         join lists l on l.list_id = li.list_id
         where li.user_id = $1
           and ($2::text is null or lower(l.name) = lower($2))
           and ($3 or li.status = 'pending')
         order by l.name, li.created_at`,
        [ctx.userId, args.list_name ?? null, includeDone],
      );

      rows.sort((a, b) => {
        if (a.list_name !== b.list_name) return a.list_name.localeCompare(b.list_name);
        const rankDiff = sectionRank(a) - sectionRank(b);
        return rankDiff !== 0 ? rankDiff : +a.created_at - +b.created_at;
      });

      return rows.map((r) => ({
        itemId: r.item_id,
        listName: r.list_name,
        section: r.section,
        itemName: r.item_name,
        status: r.status,
        priority: r.priority,
        dueAt: r.due_at,
        createdAt: r.created_at,
        completedAt: r.completed_at,
      }));
    },
  };
}
