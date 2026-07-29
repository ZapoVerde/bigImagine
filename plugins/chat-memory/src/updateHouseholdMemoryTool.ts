/**
 * @file plugins/chat-memory/src/updateHouseholdMemoryTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — edits a household-memory entry
 * @description
 * Editing content always flips source to 'user' — once a household member has corrected or
 * confirmed an entry, it's no longer purely an inferred guess (bb_principles.md §3), regardless of
 * whether it started as one.
 *
 * @api-declaration
 * createUpdateHouseholdMemoryTool() — returns the update_household_memory RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface MemoryRow {
  memory_id: string;
  content: string;
}

function isUpdateArgs(value: unknown): value is { memory_id: string; content: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).memory_id === 'string' &&
    typeof (value as Record<string, unknown>).content === 'string'
  );
}

export function createUpdateHouseholdMemoryTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_household_memory',
      description: 'Edits the content of an existing household-memory entry.',
      parameters: {
        type: 'object',
        properties: {
          memory_id: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['memory_id', 'content'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateArgs(args)) {
        throw new Error('update_household_memory requires memory_id: string and content: string arguments');
      }
      const rows = await ctx.db.query<MemoryRow>(
        `update household_memory set content = $1, source = 'user', updated_at = now()
         where memory_id = $2 and user_id = $3
         returning memory_id, content`,
        [args.content, args.memory_id, ctx.userId],
      );
      if (!rows[0]) return { found: false, memoryId: args.memory_id };
      return { found: true, memoryId: rows[0].memory_id, content: rows[0].content };
    },
  };
}
