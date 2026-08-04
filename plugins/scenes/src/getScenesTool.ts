/**
 * @file plugins/scenes/src/getScenesTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — lists scenes with presence and active location
 * @description
 * The read-back half of the data-only scene slice (canonize-plan.md §8): returns scene ids/names,
 * each scene's active_location_id, and the character_ids present in it. This is what recall
 * scoping and any future Director Pass read scene state from (bi_principles.md §4) — a scene row's
 * presence comes from a LEFT JOIN over scene_presence, not from parsing anything.
 *
 * @api-declaration
 * createGetScenesTool() — returns the get_scenes RegisteredTool
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
  active_location_id: string | null;
  character_ids: string[] | null;
}

export function createGetScenesTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_scenes',
      description: "List the user's scenes with their active location and present characters.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<SceneRow>(
        `select s.scene_id, s.name, s.active_location_id,
                coalesce(array_agg(sp.character_id) filter (where sp.character_id is not null), '{}') as character_ids
         from scenes s
         left join scene_presence sp on sp.scene_id = s.scene_id
         where s.user_id = $1
         group by s.scene_id
         order by s.name`,
        [ctx.userId],
      );
      return rows.map((r) => ({
        sceneId: r.scene_id,
        name: r.name,
        activeLocationId: r.active_location_id,
        characterIds: r.character_ids ?? [],
      }));
    },
  };
}
