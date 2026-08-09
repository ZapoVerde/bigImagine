/**
 * @file plugins/characters/src/deleteCharacterTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — deletes a character and its stored avatar
 * @description
 * Deletes the row first (still scoped to user_id, so a stale/foreign id never touches the
 * filesystem at all) and only then removes the on-disk avatar (avatarStorage.ts) — the row is the
 * source of truth, so an avatar file orphaned by a crash between the two steps is a leaked file,
 * never a leaked-but-still-referenced one. Also deletes every chat_sessions row pointing at the
 * character (its chats are unusable without the persona) and returns the deleted chat ids so the
 * client can close any open tabs for them. chat_messages cascade with their chat row (0009).
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
      // Purge the character's chats FIRST: chat_sessions.character_id is ON DELETE SET NULL
      // (0049), so deleting the character row first would null the link and this purge would
      // match nothing. FK integrity means a missing character can't have referencing chats, so
      // doing the purge before the character delete is safe for the not-found case too (and the
      // character delete below still decides deleted: true/false).
      const chats = await ctx.db.query<{ chat_id: string }>(
        'delete from chat_sessions where character_id = $1 and user_id = $2 returning chat_id',
        [args.characterId, ctx.userId],
      );
      const rows = await ctx.db.query<{ character_id: string }>(
        'delete from characters where character_id = $1 and user_id = $2 returning character_id',
        [args.characterId, ctx.userId],
      );
      if (rows.length === 0) return { deleted: false, deletedChatIds: [] };
      // chat_messages cascade with their chat row (0009); the avatar is last so a crash between
      // the two deletes leaks at worst an orphaned file, never a live reference.
      await deleteAvatar(args.characterId);
      return { deleted: true, deletedChatIds: chats.map((c) => c.chat_id) };
    },
  };
}
