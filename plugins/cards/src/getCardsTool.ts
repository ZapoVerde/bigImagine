/**
 * @file plugins/cards/src/getCardsTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — lists canonical Cards
 * @description
 * Returns Card summaries from cards only. It never consults the legacy characters table or runtime
 * Character membership.
 *
 * @api-declaration
 * createGetCardsTool() — returns get_cards
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { CardSummaryRow } from './cardTypes.js';

export function createGetCardsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_cards',
      description: "List the user's reusable Cards.",
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<CardSummaryRow>(
        `select card_id, name, created_at, updated_at, avatar_path is not null as has_avatar
         from cards where user_id = $1 order by updated_at desc, name, card_id`,
        [ctx.userId],
      );
      return rows.map((row) => ({
        cardId: row.card_id,
        name: row.name,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        hasAvatar: row.has_avatar,
      }));
    },
  };
}
