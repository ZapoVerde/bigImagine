/**
 * @file plugins/locations/src/getLocationsTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — lists locations (summaries only)
 * @description
 * The read-back half of the data-only location slice (canonize-plan.md §8): returns location ids
 * and names so scenes (set_active_location) and canon facts (propose_canon_fact's
 * linked_location_id) can reference them. Summary-only, same shape as get_characters —
 * visual_description/environment aren't needed to pick an id.
 *
 * Applies docs/plans/vistalyze_integration/segway.md §2.6's eligibility filter — same clause as
 * get_scenes (plugins/scenes/src/getScenesTool.ts): an inactive location (a demoted alternate
 * timeline) must never be model-visible, or the model could hand its id straight back into
 * set_active_location and undo the sync tick's exclusion. Transient rows surface only when their
 * anchor is provably on the calling chat's active swipe path; with no chat context (ctx.chatId
 * unset) only user-authored/permanent rows surface — the conservative reading.
 *
 * @api-declaration
 * createGetLocationsTool() — returns the get_locations RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface LocationRow {
  location_id: string;
  name: string;
  definition: string | null;
}

export function createGetLocationsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_locations',
      description:
        "List the user's locations (id, name, and a brief definition when one exists). Use the returned location ids to reference locations in scenes or canon facts.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      // segway.md §2.6 eligibility, copied from getScenesTool.ts: transient rows count only when
      // their anchor is on the calling chat's active swipe path ($2; null chat -> none).
      const rows = await ctx.db.query<LocationRow>(
        `select location_id, name, definition from locations
         where user_id = $1 and (
           status = 'permanent' or status is null or
           (status = 'transient' and anchor_swipe_id in (
             select active_swipe_id from chat_messages where chat_id = $2 and active_swipe_id is not null
           ))
         )
         order by name`,
        [ctx.userId, ctx.chatId ?? null],
      );
      return rows.map((r) => ({
        locationId: r.location_id,
        name: r.name,
        ...(r.definition ? { definition: r.definition } : {}),
      }));
    },
  };
}