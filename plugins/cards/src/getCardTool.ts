/**
 * @file plugins/cards/src/getCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — reads one canonical Card
 * @description
 * Returns Card-owned authored/source fields from cards only. A runtime Character is never a
 * fallback candidate for a Card lookup.
 *
 * @api-declaration
 * createGetCardTool() — returns get_card
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import type { CardDetailRow } from './cardTypes.js';

function isArgs(value: unknown): value is { cardId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.cardId === 'string' && v.cardId.length > 0;
}

export function createGetCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_card',
      description: 'Get one reusable Card by id.',
      parameters: {
        type: 'object',
        properties: { cardId: { type: 'string' } },
        required: ['cardId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) throw new Error('get_card requires a cardId: string');
      const rows = await ctx.db.query<CardDetailRow>(
        `select card_id, name, persona, appearance, scenario, system_prompt, example_dialogue, greetings,
                spec_version, avatar_path is not null as has_avatar, source_json is not null as has_source_json,
                created_at, updated_at
         from cards where card_id = $1 and user_id = $2`,
        [args.cardId, ctx.userId],
      );
      const row = rows[0];
      if (!row) return { found: false, cardId: args.cardId };
      return {
        found: true,
        cardId: row.card_id,
        name: row.name,
        persona: row.persona,
        appearance: row.appearance,
        scenario: row.scenario,
        systemPrompt: row.system_prompt,
        exampleDialogue: row.example_dialogue,
        greetings: row.greetings,
        specVersion: row.spec_version,
        hasAvatar: row.has_avatar,
        hasSourceJson: row.has_source_json,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
      };
    },
  };
}
