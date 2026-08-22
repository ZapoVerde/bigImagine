/**
 * @file plugins/characters/src/deleteCharacterTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — deletes a runtime Character
 * @description
 * Runtime-only deletion. Removes the character row; chat membership cleanup
 * is owned by character_chat_links orphan handling, not by source-Card chat
 * deletion. Never deletes chats.
 *
 * @api-declaration
 * createDeleteCharacterTool() — returns the delete_character RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeleteCharacterArgs(value: unknown): value is { characterId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.characterId === 'string' && v.characterId.length > 0;
}

export function createDeleteCharacterTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_character',
      description: 'Delete a character permanently, including its stored avatar image.',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: 'The character id to delete.' },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteCharacterArgs(args)) {
        throw new Error('delete_character requires a characterId: string');
      }
      const rows = await ctx.db.query<{ character_id: string }>(
        'delete from characters where character_id = $1 and user_id = $2 returning character_id',
        [args.characterId, ctx.userId],
      );
      if (rows.length === 0) return { deleted: false, deletedChatIds: [] };
      return { deleted: true, deletedChatIds: [] };
    },
  };
}
