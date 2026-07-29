/**
 * @file plugins/chat-memory/src/createHouseholdMemoryTool.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — adds a household-memory entry directly
 * @description
 * The manual counterpart to orchestrator/src/orchestrator/chatMemorySync.ts's automatic end-of-
 * chat extraction — a household member (or the LLM, told explicitly "remember this") stating a
 * fact directly is source: 'user', outranking anything inferred (bb_principles.md §3). No
 * source_chat_id: there's no chat this entry was extracted from.
 *
 * @api-declaration
 * createCreateHouseholdMemoryTool() — returns the create_household_memory RegisteredTool
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

function isCreateArgs(value: unknown): value is { content: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).content === 'string';
}

export function createCreateHouseholdMemoryTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_household_memory',
      description:
        "Directly remember a fact or preference for this household, beyond any single conversation — use this when " +
        'a household member explicitly asks you to remember something.',
      parameters: {
        type: 'object',
        properties: { content: { type: 'string', description: 'The durable fact or preference to remember.' } },
        required: ['content'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateArgs(args)) {
        throw new Error('create_household_memory requires a content: string argument');
      }
      const [row] = await ctx.db.query<MemoryRow>(
        `insert into household_memory (user_id, content, source) values ($1, $2, 'user') returning memory_id, content`,
        [ctx.userId, args.content],
      );
      return { memoryId: row!.memory_id, content: row!.content };
    },
  };
}
