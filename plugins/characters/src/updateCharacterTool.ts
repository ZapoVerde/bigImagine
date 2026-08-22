/**
 * @file plugins/characters/src/updateCharacterTool.ts
 * @stamp 2026-08-22
 * @architectural-role IO Wrapper — patches a runtime Character's editable fields
 * @description
 * Runtime-only: edits persona/appearance/name for the Cast. Card fields are not
 * applicable to runtime Characters.
 *
 * @api-declaration
 * createUpdateCharacterTool() — returns the update_character RegisteredTool
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

interface UpdateCharacterArgs {
  characterId: string;
  name?: string;
  persona?: string;
  appearance?: string;
}

function isUpdateCharacterArgs(value: unknown): value is UpdateCharacterArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.characterId !== 'string' || v.characterId.length === 0) {
    return false;
  }
  if (v.name !== undefined && (typeof v.name !== 'string' || v.name.trim().length === 0)) return false;
  if (v.persona !== undefined && typeof v.persona !== 'string') return false;
  if (v.appearance !== undefined && typeof v.appearance !== 'string') return false;
  return true;
}

export function createUpdateCharacterTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_character',
      description: "Patch a runtime character's editable fields (name, persona, appearance).",
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: 'The character id to update.' },
          name: { type: 'string' },
          persona: { type: 'string' },
          appearance: {
            type: 'string',
            description:
              "The character's physical appearance only (body type, height, build, facial features, natural hair colour, permanent features such as scars or birthmarks; exclude clothing, accessories, current hairstyle, injuries).",
          },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateCharacterArgs(args)) {
        throw new Error('update_character requires characterId: string; any patched field must be name/persona/appearance');
      }
      const sets: string[] = ['updated_at = now()'];
      const params: unknown[] = [args.characterId, ctx.userId];
      if (args.name !== undefined) {
        params.push(args.name.trim());
        sets.push(`name = $${params.length}`);
      }
      if (args.persona !== undefined) {
        params.push(args.persona);
        sets.push(`persona = $${params.length}`);
      }
      if (args.appearance !== undefined) {
        params.push(args.appearance);
        sets.push(`appearance = $${params.length}`);
      }
      const rows = await ctx.db.query<CharacterRow>(
        `update characters set ${sets.join(', ')} where character_id = $1 and user_id = $2 and status is not null returning character_id, name`,
        params,
      );
      const row = rows[0];
      if (!row) return { found: false, characterId: args.characterId };
      return { found: true, characterId: row.character_id, name: row.name };
    },
  };
}
