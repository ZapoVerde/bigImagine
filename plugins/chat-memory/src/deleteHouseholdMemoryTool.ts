/**
 * @file plugins/chat-memory/src/deleteHouseholdMemoryTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — removes a household-memory entry
 * @description
 * A real delete, no soft-delete/archive concept — same as notes/lists/chat_sessions.
 *
 * @api-declaration
 * createDeleteHouseholdMemoryTool() — returns the delete_household_memory RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeleteArgs(value: unknown): value is { memory_id: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).memory_id === 'string';
}

export function createDeleteHouseholdMemoryTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_household_memory',
      description: 'Deletes a household-memory entry — use when a household member says something remembered is wrong or no longer applies.',
      parameters: {
        type: 'object',
        properties: { memory_id: { type: 'string' } },
        required: ['memory_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteArgs(args)) {
        throw new Error('delete_household_memory requires a memory_id: string argument');
      }
      const rows = await ctx.db.query<{ memory_id: string }>(
        'delete from household_memory where memory_id = $1 and user_id = $2 returning memory_id',
        [args.memory_id, ctx.userId],
      );
      return { deleted: rows.length > 0 };
    },
  };
}
