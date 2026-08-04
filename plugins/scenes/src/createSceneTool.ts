/**
 * @file plugins/scenes/src/createSceneTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — creates a scene
 * @description
 * The data-only slice of the Director-Pass prerequisites (canonize-plan.md §8): a named scene
 * with a nullable active_location_id (a scene has at most one active location; moving between
 * locations is an update to this single pointer, not a new scene — spec.md §4). No Director Pass
 * here: this is direct mutation, the same "smallest possible CRUD" shape as create_character/
 * create_location.
 *
 * @api-declaration
 * createCreateSceneTool() — returns the create_scene RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface SceneRow {
  scene_id: string;
  name: string;
}

function isCreateSceneArgs(value: unknown): value is { name: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.name === 'string' && v.name.trim().length > 0;
}

export function createCreateSceneTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_scene',
      description: 'Create a new scene with a name.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The scene's name." },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateSceneArgs(args)) {
        throw new Error('create_scene requires a non-empty name: string argument');
      }
      const [row] = await ctx.db.query<SceneRow>(
        'insert into scenes (user_id, name) values ($1, $2) returning scene_id, name',
        [ctx.userId, args.name.trim()],
      );
      return { sceneId: row!.scene_id, name: row!.name };
    },
  };
}