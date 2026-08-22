/**
 * @file plugins/cards/src/updateCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — patches canonical Cards
 * @description
 * Updates Card-owned authored fields only. It never mutates runtime Character rows in linked
 * chats; linked RPs observe future Card reads through the live Card relationship.
 *
 * @api-declaration
 * createUpdateCardTool() — returns update_card
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface UpdateCardArgs {
  cardId: string;
  name?: string;
  persona?: string;
  appearance?: string;
  scenario?: string;
  system_prompt?: string;
  example_dialogue?: string;
  greetings?: string[];
}

function isArgs(value: unknown): value is UpdateCardArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.cardId !== 'string' || v.cardId.length === 0) return false;
  for (const key of ['name', 'persona', 'appearance', 'scenario', 'system_prompt', 'example_dialogue']) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  }
  if (v.name !== undefined && (v.name as string).trim().length === 0) return false;
  return v.greetings === undefined || (Array.isArray(v.greetings) && v.greetings.every((g) => typeof g === 'string'));
}

export function createUpdateCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_card',
      description: 'Patch authored fields on one reusable Card.',
      parameters: {
        type: 'object',
        properties: {
          cardId: { type: 'string' }, name: { type: 'string' }, persona: { type: 'string' }, appearance: { type: 'string' },
          scenario: { type: 'string' }, system_prompt: { type: 'string' }, example_dialogue: { type: 'string' },
          greetings: { type: 'array', items: { type: 'string' } },
        },
        required: ['cardId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) throw new Error('update_card requires cardId and valid Card fields');
      const sets = ['updated_at = now()'];
      const params: unknown[] = [args.cardId, ctx.userId];
      const fields: Array<[keyof UpdateCardArgs, string]> = [
        ['name', 'name'], ['persona', 'persona'], ['appearance', 'appearance'], ['scenario', 'scenario'],
        ['system_prompt', 'system_prompt'], ['example_dialogue', 'example_dialogue'],
      ];
      for (const [key, column] of fields) {
        if (args[key] !== undefined) {
          params.push(key === 'name' ? (args[key] as string).trim() : args[key]);
          sets.push(`${column} = $${params.length}`);
        }
      }
      if (args.greetings !== undefined) {
        params.push(JSON.stringify(args.greetings));
        sets.push(`greetings = $${params.length}::jsonb`);
      }
      const rows = await ctx.db.query<{ card_id: string; name: string }>(
        `update cards set ${sets.join(', ')} where card_id = $1 and user_id = $2 returning card_id, name`,
        params,
      );
      const row = rows[0];
      if (!row) return { found: false, cardId: args.cardId };
      return { found: true, cardId: row.card_id, name: row.name };
    },
  };
}
