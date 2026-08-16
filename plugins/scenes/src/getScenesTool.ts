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
 * Since this is a model-facing lookup surface, it applies docs/plans/vistalyze_integration/segway.md
 * §2.6's eligibility filter to the rows it surfaces: an inactive location/character (a demoted
 * alternate timeline) must recall as absent, never leak into the model's view of the world.
 * Presence characters are eligible iff user-authored (status null) or auto-registered-and-linked to
 * the calling chat via location_chat_links/character_chat_links (db/migrations/0096) and not
 * inactive; a scene itself is eligible iff its active location is null or eligible the same way.
 * With no chat context (ctx.chatId unset), no auto-registered row can be linked, so only
 * user-authored rows surface — the conservative reading of the spec.
 *
 * rp-cast-infrastructure-plan.md Part C fix 1: the returned scenes are also scoped to the
 * calling chat — `and (s.chat_id = $2 or s.chat_id is null)` — so a chat-scoped call (the Cast
 * sidebar's presence read) sees only its own scenes plus user-authored ones (create_scene mints
 * rows with no chat_id, which stay visible everywhere). A stateless call ($2 null) surfaces only
 * user-authored scenes rather than every scene the user has.
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
      // segway.md §2.6: auto-registered rows are eligible only when linked to this chat via the
      // relevant chat-links table and not inactive; `$2` is null for a stateless call, which makes
      // the exists() match nothing (user-authored rows still surface — the conservative reading).
      const eligibleFor = (q: string, linkTable: 'location_chat_links' | 'character_chat_links', idCol: 'location_id' | 'character_id') =>
        `(${q}.status is null or (
          ${q}.status <> 'inactive' and exists (
            select 1 from ${linkTable} where ${idCol} = ${q}.${idCol} and chat_id = $2
          )
        ))`;
      const rows = await ctx.db.query<SceneRow>(
        `select s.scene_id, s.name, s.active_location_id,
                coalesce(array_agg(sp.character_id) filter (
                  where sp.character_id is not null and ${eligibleFor('c', 'character_chat_links', 'character_id')}
                ), '{}') as character_ids
         from scenes s
         left join scene_presence sp on sp.scene_id = s.scene_id
         left join characters c on c.character_id = sp.character_id
         where s.user_id = $1
           and (s.chat_id = $2 or s.chat_id is null)
           and (s.active_location_id is null
                or exists (
                  select 1 from locations l
                  where l.location_id = s.active_location_id and l.user_id = $1
                    and ${eligibleFor('l', 'location_chat_links', 'location_id')}
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
