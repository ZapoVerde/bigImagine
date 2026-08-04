/**
 * @file plugins/scenes/src/setActiveLocationTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — updates a scene's active location pointer
 * @description
 * The only way a scene's location changes (spec.md §7.2's set_active_location, data-only slice —
 * canonize-plan.md §8): updates scenes.active_location_id. Moving between locations is an update
 * to this single pointer, never a new scene. Unsets (nulls) the pointer when location_id is null.
 * Scoped via the surrounding RLS session — a scene belonging to another user matches zero rows, so
 * the update reports not-found rather than throwing.
 *
 * @api-declaration
 * createSetActiveLocationTool() — returns the set_active_location RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isSetActiveLocationArgs(value: unknown): value is { scene_id: string; location_id?: string | null } {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.scene_id !== 'string' || v.scene_id.length === 0) {
    return false;
  }
  if (v.location_id !== undefined && v.location_id !== null && typeof v.location_id !== 'string') return false;
  return true;
}

export function createSetActiveLocationTool(): RegisteredTool {
  return {
    definition: {
      name: 'set_active_location',
      description: "Set which location is currently active in a scene. Omit location_id (or pass null) to clear the scene's active location.",
      parameters: {
        type: 'object',
        properties: {
          scene_id: { type: 'string', description: "The scene's id." },
          location_id: { type: 'string', description: 'Optional. The location id to make active, or null to clear.' },
        },
        required: ['scene_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSetActiveLocationArgs(args)) {
        throw new Error('set_active_location requires scene_id: string and an optional location_id: string|null');
      }
      const [row] = await ctx.db.query<{ scene_id: string; active_location_id: string | null }>(
        'update scenes set active_location_id = $2, last_active_at = now() where scene_id = $1 returning scene_id, active_location_id',
        [args.scene_id, args.location_id ?? null],
      );
      return row
        ? { sceneId: row.scene_id, activeLocationId: row.active_location_id }
        : { notFound: true };
    },
  };
}