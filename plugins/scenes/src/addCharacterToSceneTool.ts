/**
 * @file plugins/scenes/src/addCharacterToSceneTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — adds a character to a scene's presence
 * @description
 * Direct mutation of scene_presence (canonize-plan.md §8 — no Director Pass here): inserts the
 * (scene_id, character_id) presence pair with the user's id denormalized onto the junction row,
 * the same way chat_messages.user_id is. This is the trusted scene state recall_canon_facts's
 * scope filter reads (canonize-plan.md §3.4, bi_principles.md §4 — scene scoping is by this table,
 * never by parsing message text). Uses ON CONFLICT DO NOTHING so re-adding an already-present
 * character is a no-op rather than an error.
 *
 * @api-declaration
 * createAddCharacterToSceneTool() — returns the add_character_to_scene RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isAddCharacterToSceneArgs(value: unknown): value is { scene_id: string; character_id: string } {
  const v = value as Record<string, unknown>;
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof v.scene_id === 'string' &&
    v.scene_id.length > 0 &&
    typeof v.character_id === 'string' &&
    v.character_id.length > 0
  );
}

export function createAddCharacterToSceneTool(): RegisteredTool {
  return {
    definition: {
      name: 'add_character_to_scene',
      description: 'Add a character to a scene (its presence). Re-adding an already-present character is a no-op.',
      parameters: {
        type: 'object',
        properties: {
          scene_id: { type: 'string', description: "The scene's id." },
          character_id: { type: 'string', description: "The character's id." },
        },
        required: ['scene_id', 'character_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isAddCharacterToSceneArgs(args)) {
        throw new Error('add_character_to_scene requires scene_id: string and character_id: string arguments');
      }
      await ctx.db.query(
        `insert into scene_presence (scene_id, character_id, user_id) values ($1, $2, $3)
         on conflict (scene_id, character_id) do nothing`,
        [args.scene_id, args.character_id, ctx.userId],
      );
      return { added: true };
    },
  };
}