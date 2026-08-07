/**
 * @file plugins/scenes/src/getScenesTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — lists scenes with presence and active location
 * @description
 * The read-back half of the data-only scene slice (canonize-plan.md §8): returns scene ids/names,
 * each scene's active_location_id, and the character_ids present in it. This is what recall
 * scoping and any future Director Pass read scene state from (bi_principles.md §4) — a scene row's
 * presence comes from a LEFT JOIN over scene_presence, not from parsing anything.
 *
 * Since this is a model-facing lookup surface, it applies docs/vistalyze_integration/segway.md
 * §2.6's eligibility filter to the rows it surfaces: an inactive location/character (a demoted
 * alternate timeline) must recall as absent, never leak into the model's view of the world.
 * Presence characters are eligible iff user-authored (status null), permanent, or transient with
 * their anchor on the calling chat's active swipe path; a scene itself is eligible iff its active
 * location is null or eligible the same way. With no chat context (ctx.chatId unset), the
 * active-path condition can't be proven, so transient rows are excluded — only user-authored and
 * permanent rows surface, the conservative reading of the spec.
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
      // segway.md §2.6: transient rows are eligible only when their anchor is provably on this
      // chat's active swipe path; `$2` is null for a stateless call, which makes the subquery
      // match nothing (user-authored/permanent rows still surface — the conservative reading).
      const eligibleFor = (q: string) =>
        `(${q}.status = 'permanent' or ${q}.status is null or
          (${q}.status = 'transient' and ${q}.anchor_swipe_id in (
            select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
          )))`;
      const rows = await ctx.db.query<SceneRow>(
        `select s.scene_id, s.name, s.active_location_id,
                coalesce(array_agg(sp.character_id) filter (
                  where sp.character_id is not null and ${eligibleFor('c')}
                ), '{}') as character_ids
         from scenes s
         left join scene_presence sp on sp.scene_id = s.scene_id
         left join characters c on c.character_id = sp.character_id
         where s.user_id = $1
           and (s.active_location_id is null
                or exists (
                  select 1 from locations l
                  where l.location_id = s.active_location_id and l.user_id = $1
                    and ${eligibleFor('l')}
                ))
         group by s.scene_id
         order by s.name`,
        [ctx.userId, ctx.chatId ?? null],
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
