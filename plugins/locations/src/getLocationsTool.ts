/**
 * @file plugins/locations/src/getLocationsTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — lists locations (summaries only)
 * @description
 * The read-back half of the data-only location slice (canonize-plan.md §8): returns location ids
 * and names so scenes (set_active_location) and canon facts (propose_canon_fact's
 * linked_location_id) can reference them. Summary-only, same shape as get_characters —
 * visual_description/environment aren't needed to pick an id.
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
}

export function createGetLocationsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_locations',
      description: "List the user's locations (id and name only). Use the returned location ids to reference locations in scenes or canon facts.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<LocationRow>(
        'select location_id, name from locations where user_id = $1 order by name',
        [ctx.userId],
      );
      return rows.map((r) => ({ locationId: r.location_id, name: r.name }));
    },
  };
}