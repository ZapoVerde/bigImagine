/**
 * @file plugins/cards/src/createCardTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — creates canonical Cards
 * @description
 * Creates one reusable Card row. This operation never creates a runtime Character, chat, or
 * character_chat_links membership.
 *
 * @api-declaration
 * createCreateCardTool() — returns create_card
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CreateCardArgs {
  name: string;
  persona?: string;
  appearance?: string;
  scenario?: string;
  system_prompt?: string;
  example_dialogue?: string;
  greetings?: string[];
}

function isArgs(value: unknown): value is CreateCardArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.name !== 'string' || v.name.trim().length === 0) return false;
  for (const key of ['persona', 'appearance', 'scenario', 'system_prompt', 'example_dialogue']) {
    if (v[key] !== undefined && typeof v[key] !== 'string') return false;
  }
  return v.greetings === undefined || (Array.isArray(v.greetings) && v.greetings.every((g) => typeof g === 'string'));
}

export function createCreateCardTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_card',
      description: 'Create a reusable Card without creating a runtime Character.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' }, persona: { type: 'string' }, appearance: { type: 'string' },
          scenario: { type: 'string' }, system_prompt: { type: 'string' }, example_dialogue: { type: 'string' },
          greetings: { type: 'array', items: { type: 'string' } },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) throw new Error('create_card requires a non-empty name and string Card fields');
      const [row] = await ctx.db.query<{ card_id: string; name: string }>(
        `insert into cards (user_id, name, persona, appearance, scenario, system_prompt, example_dialogue, greetings)
         values ($1, $2, $3, $4, $5, $6, $7, $8::jsonb) returning card_id, name`,
        [ctx.userId, args.name.trim(), args.persona ?? '', args.appearance ?? '', args.scenario ?? '', args.system_prompt ?? '', args.example_dialogue ?? '', JSON.stringify(args.greetings ?? [])],
      );
      return { cardId: row!.card_id, name: row!.name };
    },
  };
}
