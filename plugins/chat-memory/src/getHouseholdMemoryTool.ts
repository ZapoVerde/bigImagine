/**
 * @file plugins/chat-memory/src/getHouseholdMemoryTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — lists the household's cross-chat "worth keeping" memory
 * @description
 * household_memory (db/migrations/0039_household_memory.sql) is small, household-scale data — full
 * content returned directly, same reasoning as get_prompt_presets, no pagination needed.
 *
 * @api-declaration
 * createGetHouseholdMemoryTool() — returns the get_household_memory RegisteredTool
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
  source: 'inferred' | 'user';
  updated_at: string;
}

export function createGetHouseholdMemoryTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_household_memory',
      description:
        "Lists everything remembered about this household beyond any single conversation — standing preferences, " +
        'corrections, durable facts. Always available as context for any conversation.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<MemoryRow>(
        'select memory_id, content, source, updated_at from household_memory where user_id = $1 order by updated_at desc',
        [ctx.userId],
      );
      return rows.map((r) => ({ memoryId: r.memory_id, content: r.content, source: r.source, updatedAt: r.updated_at }));
    },
  };
}
