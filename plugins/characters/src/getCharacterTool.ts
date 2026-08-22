/**
 * @file plugins/characters/src/getCharacterTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — full runtime Character detail
 * @description
 * Runtime-only detail for the Cast and scene/canon callers. A row is visible only
 * when it is linked to the calling chat via character_chat_links and not inactive.
 * Reusable Cards are not served here.
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
  appearance: string;
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
      if (!ctx.chatId) return { found: false, characterId: args.characterId };
      const rows = await ctx.db.query<CharacterDetailRow>(
        `select character_id, name, persona, appearance, scenario, system_prompt, example_dialogue, greetings,
                spec_version, avatar_path is not null as has_avatar, source_json is not null as has_source_json,
                created_at, updated_at
         from characters where character_id = $1 and user_id = $2 and status is not null and status <> 'inactive' and exists (
           select 1 from character_chat_links where character_id = characters.character_id and chat_id = $3
         )`,
        [args.characterId, ctx.userId, ctx.chatId],
      );
      const row = rows[0];
      if (!row) return { found: false, characterId: args.characterId };
      return {
        found: true,
        characterId: row.character_id,
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
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    },
  };
}
