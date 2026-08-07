/**
 * @file plugins/locations/src/createLocationTool.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — creates a location
 * @description
 * The data-only slice of Vistalyze (canonize-plan.md §8 — deliberately not Vistalyze: no image
 * generation, no backend config, no cache-invalidation logic). A location is a named place with
 * an optional visual_description, an environment jsonb (time_of_day, weather, mood) and an
 * optional seed — the inputs that would later regenerate its cached image (spec.md §4:
 * image_path is cache, not source). Scope for a scene and for canon facts' linked_location_id
 * without any image pipeline.
 *
 * status is written as 'permanent', never left at the migration default ('transient') — a user
 * manually creating a location is the explicit canon signal (bi_principles.md §3,
 * docs/vistalyze_integration/segway.md §2.6), so the row stays eligible for the post-cleanup
 * scraper's name-lookup and for prompt injection. Transient status is reserved for rows the story
 * auto-registers, which are anchored to a turn's swipe and settle through the sync tick.
 *
 * @api-declaration
 * createCreateLocationTool() — returns the create_location RegisteredTool
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

interface CreateLocationArgs {
  name: string;
  visual_description?: string;
  environment?: Record<string, unknown>;
  seed?: number;
}

function isCreateLocationArgs(value: unknown): value is CreateLocationArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.name !== 'string' || v.name.trim().length === 0) {
    return false;
  }
  if (v.visual_description !== undefined && typeof v.visual_description !== 'string') return false;
  if (
    v.environment !== undefined &&
    (typeof v.environment !== 'object' || v.environment === null || Array.isArray(v.environment))
  ) {
    return false;
  }
  if (v.seed !== undefined && typeof v.seed !== 'number') return false;
  return true;
}

export function createCreateLocationTool(): RegisteredTool {
  return {
    definition: {
      name: 'create_location',
      description: 'Create a new location with a name and optional visual description, environment, and seed.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The location's name." },
          visual_description: { type: 'string', description: 'Optional. What the location looks like.' },
          environment: {
            type: 'object',
            description: 'Optional. Environment details: time_of_day, weather, mood.',
          },
          seed: { type: 'number', description: 'Optional. Random seed for future image regeneration.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isCreateLocationArgs(args)) {
        throw new Error('create_location requires a non-empty name: string; optional fields must be strings/object/number');
      }
      const [row] = await ctx.db.query<LocationRow>(
        `insert into locations (user_id, name, visual_description, environment, seed, status)
         values ($1, $2, $3, $4, $5, 'permanent')
         returning location_id, name`,
        [ctx.userId, args.name.trim(), args.visual_description ?? '', JSON.stringify(args.environment ?? {}), args.seed ?? null],
      );
      return { locationId: row!.location_id, name: row!.name };
    },
  };
}