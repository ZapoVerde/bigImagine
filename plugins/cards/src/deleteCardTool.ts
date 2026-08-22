/**
 * @file plugins/cards/src/deleteCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — deletes a Card and its dependent chats
 * @description
 * Deletes all chats carrying the Card reference first, then the Card row itself.
 * Linked lorebooks survive by default (Card links Lorebooks; Card owns Chats). Lorebooks are
 * only deleted when explicitly requested via deleteLorebookIds, and only when each requested
 * lorebook is actually linked to this Card and not shared with another Card. Card-linked
 * association rows disappear through the lorebook_card_links FK cascade on card delete.
 * Chat deletion cascades runtime membership removal; this tool never queries or deletes runtime
 * Characters by Card identity. Returned chat ids let the frontend reconcile open RP tabs. Local
 * imported Card media cleanup is best-effort through the existing UUID-keyed storage adapter.
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

function isArgs(value: unknown): value is { cardId: string; deleteLorebookIds?: string[] } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.cardId !== 'string' || v.cardId.length === 0) return false;
  if (v.deleteLorebookIds === undefined) return true;
  if (!Array.isArray(v.deleteLorebookIds)) return false;
  return v.deleteLorebookIds.every((id) => typeof id === 'string' && id.length > 0);
}

export function createDeleteCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_card',
      description: 'Delete a reusable Card and every RP chat derived from it. Linked lorebooks survive unless explicitly requested via deleteLorebookIds.',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string' },
          deleteLorebookIds: { type: 'array', items: { type: 'string' }, description: 'Lorebook ids linked to this Card to delete explicitly' },
        },
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
      const requested = args.deleteLorebookIds ? [...new Set(args.deleteLorebookIds)] : [];
      if (requested.length > 0) {
        for (const lorebookId of requested) {
          const linked = await ctx.db.query<{ lorebook_id: string }>(
            'select lorebook_id from lorebook_card_links where card_id = $1 and user_id = $2 and lorebook_id = $3',
            [args.cardId, ctx.userId, lorebookId],
          );
          if (linked.length === 0) throw new Error(`lorebook ${lorebookId} is not linked to this card`);
          const shared = await ctx.db.query<{ lorebook_id: string }>(
            'select lorebook_id from lorebook_card_links where lorebook_id = $1 and user_id = $2 and card_id != $3 limit 1',
            [lorebookId, ctx.userId, args.cardId],
          );
          if (shared.length > 0) throw new Error(`lorebook ${lorebookId} is also linked to another card and cannot be deleted through this card`);
        }
      }
      const chats = await ctx.db.query<{ chat_id: string }>(
        'delete from chat_sessions where card_id = $1 and user_id = $2 returning chat_id',
        [args.cardId, ctx.userId],
      );
      for (const lorebookId of requested) {
        await ctx.db.query('delete from lorebooks where lorebook_id = $1 and user_id = $2', [lorebookId, ctx.userId]);
      }
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
