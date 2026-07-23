/**
 * @file plugins/lists/src/setListSectionOrderTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — defines (or clears) a list's store-layout section order
 * @description
 * Conversational, not hardcoded: "here's the order I walk my grocery store in" is exactly the
 * kind of household-specific, store-specific, and store-*rearranges-constantly* fact that
 * shouldn't live as a one-off SQL script. Overwrites any existing section_order for the list
 * (last-set-wins) — there's no merge semantics, since re-stating the whole order is the natural
 * way this actually gets used ("update my grocery order to..."). Setting an empty array turns
 * section-based sorting back off for that list; existing list_items.section values on that list
 * are left as-is (stale sections just stop being used for sorting), not cleared.
 *
 * @api-declaration
 * createSetListSectionOrderTool() — returns the set_list_section_order RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { findOrCreateList } from './listLookup.js';

function isSetListSectionOrderArgs(value: unknown): value is { list_name: string; sections: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.list_name === 'string' &&
    v.list_name !== '' &&
    Array.isArray(v.sections) &&
    v.sections.every((s) => typeof s === 'string' && s !== '')
  );
}

export function createSetListSectionOrderTool(): RegisteredTool {
  return {
    definition: {
      name: 'set_list_section_order',
      description:
        'Define the order sections appear in for a list (e.g. the aisle order you walk through a grocery store), so items on it sort to match. Creates the list if it does not already exist.',
      parameters: {
        type: 'object',
        properties: {
          list_name: { type: 'string', description: 'The list to set the section order for.' },
          sections: {
            type: 'array',
            items: { type: 'string' },
            description: 'Section names in the order you encounter them, e.g. ["veggies", "meats", "dairy"].',
          },
        },
        required: ['list_name', 'sections'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSetListSectionOrderArgs(args)) {
        throw new Error('set_list_section_order requires list_name: string and sections: string[]');
      }

      const { listId } = await findOrCreateList(ctx.db, ctx.userId, args.list_name);
      await ctx.db.query(`update lists set section_order = $2 where list_id = $1`, [listId, args.sections]);

      return { listId, listName: args.list_name, sectionCount: args.sections.length };
    },
  };
}
