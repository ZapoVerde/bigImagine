/**
 * @file plugins/characters/src/updateCharacterTool.ts
 * @stamp 2026-08-05
 * @architectural-role IO Wrapper — patches a character's editable fields
 * @description
 * The write half of the Roster editor pane (get_character is the read half). Only the same static
 * fields create_character accepts are patchable — source_json and avatar_path are never touched
 * here, so hand-editing a card's text after import doesn't silently invalidate the exact original
 * JSON export losslessness depends on (bi_principles.md §7); export always prefers source_json
 * verbatim over these columns regardless of what's been edited since import.
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
  scenario?: string;
  system_prompt?: string;
  example_dialogue?: string;
  greetings?: string[];
}

function isUpdateCharacterArgs(value: unknown): value is UpdateCharacterArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.characterId !== 'string' || v.characterId.length === 0) {
    return false;
  }
  if (v.name !== undefined && (typeof v.name !== 'string' || v.name.trim().length === 0)) return false;
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

export function createUpdateCharacterTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_character',
      description: "Patch one of a character's editable fields (name, persona, scenario, system_prompt, example_dialogue, greetings).",
      parameters: {
        type: 'object',
        properties: {
          characterId: { type: 'string', description: 'The character id to update.' },
          name: { type: 'string' },
          persona: { type: 'string' },
          scenario: { type: 'string' },
          system_prompt: { type: 'string' },
          example_dialogue: { type: 'string' },
          greetings: { type: 'array', items: { type: 'string' } },
        },
        required: ['characterId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateCharacterArgs(args)) {
        throw new Error('update_character requires characterId: string; any patched field must match create_character\'s types');
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
      if (args.scenario !== undefined) {
        params.push(args.scenario);
        sets.push(`scenario = $${params.length}`);
      }
      if (args.system_prompt !== undefined) {
        params.push(args.system_prompt);
        sets.push(`system_prompt = $${params.length}`);
      }
      if (args.example_dialogue !== undefined) {
        params.push(args.example_dialogue);
        sets.push(`example_dialogue = $${params.length}`);
      }
      if (args.greetings !== undefined) {
        params.push(args.greetings);
        sets.push(`greetings = $${params.length}`);
      }
      const rows = await ctx.db.query<CharacterRow>(
        `update characters set ${sets.join(', ')} where character_id = $1 and user_id = $2 returning character_id, name`,
        params,
      );
      const row = rows[0];
      if (!row) return { found: false, characterId: args.characterId };
      return { found: true, characterId: row.character_id, name: row.name };
    },
  };
}
