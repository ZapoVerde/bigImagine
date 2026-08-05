/**
 * @file plugins/characters/src/deleteCharacterTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — deletes a character and its stored avatar
 * @description
 * Deletes the row first (still scoped to user_id, so a stale/foreign id never touches the
 * filesystem at all) and only then removes the on-disk avatar (avatarStorage.ts) — the row is the
 * source of truth, so an avatar file orphaned by a crash between the two steps is a leaked file,
 * never a leaked-but-still-referenced one.
 *
 * @api-declaration
 * createDeleteCharacterTool() — returns the delete_character RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, filesystem via avatarStorage)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { deleteAvatar } from './avatarStorage.js';

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
      if (rows.length === 0) return { deleted: false };
      await deleteAvatar(args.characterId);
      return { deleted: true };
    },
  };
}
