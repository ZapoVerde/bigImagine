/**
 * @file plugins/characters/src/getCharacterTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — full single-character detail
 * @description
 * The detail half of the Character Roster (docs/spec.md §6) — get_characters (getCharactersTool.ts)
 * stays summary-only for the scene/canon-fact reference use case it was built for; this is what the
 * Roster's editor pane loads once a card is picked. source_json (the exact original import, kept
 * for lossless export per bi_principles.md §7) is never returned verbatim here — it can be large
 * and the editor has no use for it — only whether one is present.
 *
 * Applies docs/vistalyze_integration/segway.md §2.6's eligibility filter, same as get_characters:
 * a lookup of an ineligible row (inactive, or transient not provably on the calling chat's active
 * swipe path) reports not-found, so the model can't pull detail on a demoted alternate timeline.
 * The Roster only ever passes ids that the filtered get_characters list returned, so its editor
 * flow is unaffected.
 *
 * @api-declaration
 * createGetCharacterTool() — returns the get_character RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface CharacterDetailRow {
  character_id: string;
  name: string;
  persona: string;
  scenario: string;
  system_prompt: string;
  example_dialogue: string;
  greetings: string[];
  spec_version: string;
  has_avatar: boolean;
  has_source_json: boolean;
  created_at: string;
  updated_at: string;
}

function isGetCharacterArgs(value: unknown): value is { characterId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.characterId === 'string' && v.characterId.length > 0;
}

export function createGetCharacterTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_character',
      description: 'Get the full detail of one character by id.',
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: 'The character id returned by get_characters.' },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetCharacterArgs(args)) {
        throw new Error('get_character requires a characterId: string');
      }
      const rows = await ctx.db.query<CharacterDetailRow>(
        `select character_id, name, persona, scenario, system_prompt, example_dialogue, greetings,
                spec_version, avatar_path is not null as has_avatar, source_json is not null as has_source_json,
                created_at, updated_at
         from characters where character_id = $1 and user_id = $2 and (
           status = 'permanent' or status is null or
           (status = 'transient' and anchor_swipe_id in (
             select active_swipe_id from chat_messages where chat_id = $3 and active_swipe_id is not null
           ))
         )`,
        [args.characterId, ctx.userId, ctx.chatId ?? null],
      );
      const row = rows[0];
      if (!row) return { found: false, characterId: args.characterId };
      return {
        found: true,
        characterId: row.character_id,
        name: row.name,
        persona: row.persona,
        scenario: row.scenario,
        systemPrompt: row.system_prompt,
        exampleDialogue: row.example_dialogue,
        greetings: row.greetings,
        specVersion: row.spec_version,
        hasAvatar: row.has_avatar,
        hasSourceJson: row.has_source_json,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  };
}
