/**
 * @file plugins/lists/src/updateListItemTool.ts
 * @stamp 2026-08-01
 * @architectural-role IO Wrapper — edits a list item's priority/due date/name
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as notes' update_note. Addressed by item_id, or — like complete_list_item's own name
 * lookup — by current_item_name (+ optional list_name), same case-insensitive
 * most-recently-created tie-break, so renaming/re-prioritizing a known item doesn't cost a
 * mandatory get_list_items round just to resolve its id first (caught live 2026-08-01: a "remove
 * X, add Y instead" turn burned every maxToolRounds round on lookups and never got to act).
 *
 * @api-declaration
 * createUpdateListItemTool() — returns the update_list_item RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

const VALID_PRIORITIES = ['P1', 'P2', 'P3'];

interface ItemRow {
  item_id: string;
  item_name: string;
  priority: string | null;
  due_at: string | null;
}

function isUpdateListItemArgs(value: unknown): value is {
  item_id?: string;
  current_item_name?: string;
  list_name?: string;
  item_name?: string;
  priority?: string;
  due_at?: string;
} {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null) return false;
  if (v.item_id !== undefined && (typeof v.item_id !== 'string' || v.item_id === '')) return false;
  if (v.current_item_name !== undefined && (typeof v.current_item_name !== 'string' || v.current_item_name === '')) return false;
  if (v.list_name !== undefined && typeof v.list_name !== 'string') return false;
  if (!v.item_id && !v.current_item_name) return false;
  if (v.item_name !== undefined && typeof v.item_name !== 'string') return false;
  if (v.priority !== undefined && !VALID_PRIORITIES.includes(v.priority as string)) return false;
  if (v.due_at !== undefined && typeof v.due_at !== 'string') return false;
  return true;
}

export function createUpdateListItemTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_list_item',
      description:
        "Edit a list item's name, priority, and/or due date, addressed by item_id or by its current " +
        'name (current_item_name, optionally scoped to a list). If multiple items match the name, edits ' +
        'the most recently added one. Only the fields provided are changed.',
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The item to edit, from get_list_items/add_list_item.' },
          current_item_name: { type: 'string', description: 'The item to edit, by its current name, if item_id is not known.' },
          list_name: { type: 'string', description: 'Optional: only look for current_item_name on this list.' },
          item_name: { type: 'string', description: 'New name for the item, if renaming it.' },
          priority: { type: 'string', enum: VALID_PRIORITIES, description: 'P1/P2/P3.' },
          due_at: { type: 'string', description: 'ISO timestamp.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateListItemArgs(args)) {
        throw new Error(
          'update_list_item requires an item_id or current_item_name: string argument; priority (if given) must be P1/P2/P3 and due_at (if given) a string',
        );
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
          [ctx.userId, args.current_item_name, args.list_name ?? null],
        );
        if (!match) return { found: false, reason: `no item named "${args.current_item_name}" was found` };
        itemId = match.item_id;
      }

      const sets: string[] = [];
      const params: unknown[] = [itemId, ctx.userId];
      if (args.item_name !== undefined) {
        params.push(args.item_name);
        sets.push(`item_name = $${params.length}`);
      }
      if (args.priority !== undefined) {
        params.push(args.priority);
        sets.push(`priority = $${params.length}`);
      }
      if (args.due_at !== undefined) {
        params.push(args.due_at);
        sets.push(`due_at = $${params.length}`);
      }
      if (sets.length === 0) {
        throw new Error('update_list_item requires at least one of item_name/priority/due_at');
      }
      const [row] = await ctx.db.query<ItemRow>(
        `update list_items set ${sets.join(', ')} where item_id = $1 and user_id = $2
         returning item_id, item_name, priority, due_at`,
        params,
      );
      if (!row) return { found: false, itemId };
      return {
        found: true,
        itemId: row.item_id,
        itemName: row.item_name,
        priority: row.priority,
        dueAt: row.due_at,
      };
    },
  };
}
