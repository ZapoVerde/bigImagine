/**
 * @file plugins/cards/src/deleteCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — deletes a Card and its dependent chats
 * @description
 * Deletes all chats carrying the Card reference first, then deletes the Card row. Chat deletion
 * cascades runtime membership removal; this tool never queries or deletes runtime Characters by
 * Card identity. Returned chat ids let the frontend reconcile open RP tabs. Local imported Card
 * media cleanup is best-effort through the existing UUID-keyed storage adapter.
 *
 * @api-declaration
 * createDeleteCardTool() — returns delete_card with deletedChatIds
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO and filesystem)
 *     state_ownership: []
 *     external_io:     [Postgres, filesystem]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { deleteCardMedia } from './cardMedia.js';

function isArgs(value: unknown): value is { cardId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.cardId === 'string' && v.cardId.length > 0;
}

export function createDeleteCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_card',
      description: 'Delete a reusable Card and every RP chat derived from it.',
      parameters: {
        type: 'object',
        properties: { cardId: { type: 'string' } },
        required: ['cardId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) throw new Error('delete_card requires a cardId: string');
      const owned = await ctx.db.query<{ card_id: string }>(
        'select card_id from cards where card_id = $1 and user_id = $2',
        [args.cardId, ctx.userId],
      );
      if (owned.length === 0) return { deleted: false, deletedChatIds: [] };
      const chats = await ctx.db.query<{ chat_id: string }>(
        'delete from chat_sessions where card_id = $1 and user_id = $2 returning chat_id',
        [args.cardId, ctx.userId],
      );
      const cards = await ctx.db.query<{ card_id: string }>(
        'delete from cards where card_id = $1 and user_id = $2 returning card_id',
        [args.cardId, ctx.userId],
      );
      if (cards.length === 0) return { deleted: false, deletedChatIds: [] };
      await deleteCardMedia(args.cardId);
      return { deleted: true, deletedChatIds: chats.map((chat) => chat.chat_id) };
    },
  };
}
