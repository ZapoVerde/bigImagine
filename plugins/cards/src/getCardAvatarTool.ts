/**
 * @file plugins/cards/src/getCardAvatarTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — reads Card-owned imported media
 * @api-declaration createGetCardAvatarTool() — returns get_card_avatar
 * @contract authorizes cards in SQL and never consults runtime Character visual state.
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { readCardMedia } from './cardMediaStorage.js';

export function createGetCardAvatarTool(): RegisteredTool {
  return { definition: { name: 'get_card_avatar', description: 'Get a Card imported image as base64.', parameters: {
    type: 'object', properties: { cardId: { type: 'string' } }, required: ['cardId'], additionalProperties: false,
  } }, handler: async (args, ctx) => {
    const value = args as Record<string, unknown>;
    if (!value || typeof value.cardId !== 'string' || !value.cardId) throw new Error('get_card_avatar requires a cardId: string');
    const rows = await ctx.db.query<{ has_avatar: boolean }>('select avatar_path is not null as has_avatar from cards where card_id = $1 and user_id = $2', [value.cardId, ctx.userId]);
    if (!rows[0]?.has_avatar) return { found: false };
    const bytes = await readCardMedia(value.cardId); if (!bytes) return { found: false };
    return { found: true, mimeType: 'image/png', base64: bytes.toString('base64') };
  } };
}
