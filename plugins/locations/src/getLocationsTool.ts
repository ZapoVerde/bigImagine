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
 * set_active_location and undo the sync tick's exclusion. Auto-registered rows (status is not
 * null) surface only when linked to the calling chat via location_chat_links (db/migrations/0096)
 * — with no chat context (ctx.chatId unset) none of them surface. User-authored rows (status is
 * null) are always eligible, chat context or not — that's the deliberate, reusable, cross-chat
 * library.
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
      // segway.md §2.6 eligibility: user-authored rows (status null) always count; auto-registered
      // rows count only when linked to the calling chat and not demoted ($2; null chat -> none).
      const rows = await ctx.db.query<LocationRow>(
        `select location_id, name, definition from locations
         where user_id = $1 and (
           status is null or (
             status <> 'inactive' and exists (
               select 1 from location_chat_links where location_id = locations.location_id and chat_id = $2
             )
           )
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