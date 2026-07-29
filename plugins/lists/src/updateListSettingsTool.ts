/**
 * @file plugins/lists/src/updateListSettingsTool.ts
 * @stamp 2026-07-29
 * @architectural-role IO Wrapper — toggles a list's show_priority/show_due_dates display flags
 * @description
 * Same "build the SET clause from present keys" shape as update_list_item, and the same
 * find-or-create-by-name shape as set_list_section_order — this is a per-list config value, not a
 * per-item one. Only governs whether the Lists view *shows* priority/due-date controls for this
 * list (db/migrations/0041_list_display_flags.sql); it never touches list_items.priority/due_at
 * themselves, so flipping a flag off doesn't clear or hide data that's already set.
 *
 * @api-declaration
 * createUpdateListSettingsTool() — returns the update_list_settings RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { findOrCreateList } from './listLookup.js';

function isUpdateListSettingsArgs(
  value: unknown,
): value is { list_name: string; show_priority?: boolean; show_due_dates?: boolean } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.list_name !== 'string' || v.list_name === '') return false;
  if (v.show_priority !== undefined && typeof v.show_priority !== 'boolean') return false;
  if (v.show_due_dates !== undefined && typeof v.show_due_dates !== 'boolean') return false;
  return true;
}

export function createUpdateListSettingsTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_list_settings',
      description:
        "Turn a list's priority and/or due-date controls on or off (creates the list if it does not already exist). Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: 'The list to update.' },
          show_priority: { type: 'boolean', description: 'Whether to show priority controls for this list.' },
          show_due_dates: { type: 'boolean', description: 'Whether to show due-date controls for this list.' },
        },
        required: ['list_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateListSettingsArgs(args)) {
        throw new Error(
          'update_list_settings requires list_name: string, and show_priority/show_due_dates (if given) must be boolean',
        );
      }

      const sets: string[] = [];
      const params: unknown[] = [];
      if (args.show_priority !== undefined) {
        params.push(args.show_priority);
        sets.push(`show_priority = $${params.length + 1}`);
      }
      if (args.show_due_dates !== undefined) {
        params.push(args.show_due_dates);
        sets.push(`show_due_dates = $${params.length + 1}`);
      }
      if (sets.length === 0) {
        throw new Error('update_list_settings requires at least one of show_priority/show_due_dates');
      }

      const { listId } = await findOrCreateList(ctx.db, ctx.userId, args.list_name);
      const [row] = await ctx.db.query<{ show_priority: boolean; show_due_dates: boolean }>(
        `update lists set ${sets.join(', ')} where list_id = $1 returning show_priority, show_due_dates`,
        [listId, ...params],
      );

      return { listId, name: args.list_name, showPriority: row!.show_priority, showDueDates: row!.show_due_dates };
    },
  };
}
