/**
 * @file plugins/lists/src/updateListItemTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — edits a list item's priority/due date/name
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as notes' update_note. Addressed by item_id (not item_name/list_name, unlike
 * complete_list_item) since this is the "set or change a priority/deadline later" path
 * (docs/spec.md's action-dates addition: "Set explicitly ... or changed later") and get_list_items
 * already hands every item's id back, so there's no ambiguity to resolve the way a spoken item
 * name would need.
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

function isUpdateListItemArgs(
  value: unknown,
): value is { item_id: string; item_name?: string; priority?: string; due_at?: string } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.item_id !== 'string' || v.item_id === '') return false;
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
        "Edit a list item's name, priority, and/or due date, addressed by item_id (from get_list_items/add_list_item). Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          item_id: { type: 'string', description: 'The item to edit.' },
          item_name: { type: 'string' },
          priority: { type: 'string', enum: VALID_PRIORITIES, description: 'P1/P2/P3.' },
          due_at: { type: 'string', description: 'ISO timestamp.' },
        },
        required: ['item_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateListItemArgs(args)) {
        throw new Error('update_list_item requires an item_id: string argument; priority (if given) must be P1/P2/P3 and due_at (if given) a string');
      }
      const sets: string[] = [];
      const params: unknown[] = [args.item_id, ctx.userId];
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
      if (!row) return { found: false, itemId: args.item_id };
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
