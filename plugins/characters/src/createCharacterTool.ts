/**
 * @file plugins/characters/src/createCharacterTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — creates a character
 * @description
 * The data-only slice of the Character Roster (canonize-plan.md §8 — this is not the Roster:
 * no PNG/JSON import, no card-spec chunk parsing). A character is the static half of a canonical
 * identity (bi_principles.md §1, canonize-plan.md §3.3): name plus the fixed-at-creation fields
 * (persona, scenario, system_prompt, example_dialogue, greetings). source_json stays null for
 * anything created this way — it's reserved for future verbatim card import, so export remains a
 * lossless round-trip (bi_principles.md §7). Evolving detail never lands here: extraction proposes
 * canon_facts (category='person') rows instead, and a genuinely new static detail is a human
 * editing the Roster, per bi_principles.md §3.
 *
 * @api-declaration
 * createCreateCharacterTool() — returns the create_character RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CharacterRow {
  character_id: string;
  name: string;
}

interface CreateCharacterArgs {
  name: string;
  persona?: string;
  scenario?: string;
  system_prompt?: string;
  example_dialogue?: string;
  greetings?: string[];
}

function isCreateCharacterArgs(value: unknown): value is CreateCharacterArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.name !== 'string' || v.name.trim().length === 0) {
    return false;
  }
  if (v.persona !== undefined && typeof v.persona !== 'string') return false;
  if (v.scenario !== undefined && typeof v.scenario !== 'string') return false;
  if (v.system_prompt !== undefined && typeof v.system_prompt !== 'string') return false;
  if (v.example_dialogue !== undefined && typeof v.example_dialogue !== 'string') return false;
  if (
    v.greetings !== undefined &&
    (!Array.isArray(v.greetings) || v.greetings.some((g) => typeof g !== 'string'))
  ) {
    return false;
  }
  return true;
}

export function createCreateCharacterTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_character',
      description: 'Create a new character with a name and optional static persona fields.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The character's name." },
          persona: { type: 'string', description: 'Optional. The character\'s appearance and personality (static, set at creation).' },
          scenario: { type: 'string', description: 'Optional. The character\'s scenario/backstory text.' },
          system_prompt: { type: 'string', description: 'Optional. Extra system prompt content for this character.' },
          example_dialogue: { type: 'string', description: 'Optional. Example dialogue shown to the model.' },
          greetings: {
            type: 'array',
            items: { type: 'string' },
            description: 'Optional. Alternate opening messages for this character.',
          },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateCharacterArgs(args)) {
        throw new Error('create_character requires a non-empty name: string; optional fields must be strings (greetings a string array)');
      }
      const [row] = await ctx.db.query<CharacterRow>(
        `insert into characters (user_id, name, persona, scenario, system_prompt, example_dialogue, greetings)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning character_id, name`,
        [
          ctx.userId,
          args.name.trim(),
          args.persona ?? '',
          args.scenario ?? '',
          args.system_prompt ?? '',
          args.example_dialogue ?? '',
          args.greetings ?? [],
        ],
      );
      return { characterId: row!.character_id, name: row!.name };
    },
  };
}