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
 * status is written as null, never left at the migration default ('transient') — a user manually
 * creating a location is explicitly outside the auto-registration lifecycle entirely (this is the
 * deliberate, reusable, cross-chat location library, not a per-chat auto-registered row), the same
 * convention plugins/characters/src/createCharacterTool.ts already uses. The
 * transient/permanent/inactive lifecycle (db/migrations/0096) is reserved for rows the story
 * auto-registers, which are linked to their owning chat via location_chat_links and settle through
 * the sync tick — status='permanent' never means "exempt from chat-scoping," only "settled."
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
  /** Optional logical definition of what this place is (the describer pass's "Definition:" half;
   *  segway.md §2.6 — surfaced to the model alongside the name). */
  definition?: string;
  environment?: Record<string, unknown>;
  seed?: number;
}

function isCreateLocationArgs(value: unknown): value is CreateLocationArgs {
  const v = value as Record<string, unknown>;
  if (typeof value !== 'object' || value === null || typeof v.name !== 'string' || v.name.trim().length === 0) {
    return false;
  }
  if (v.visual_description !== undefined && typeof v.visual_description !== 'string') return false;
  if (v.definition !== undefined && typeof v.definition !== 'string') return false;
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
      description: 'Create a new location with a name and optional visual description, definition, environment, and seed.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: "The location's name." },
          visual_description: { type: 'string', description: 'Optional. What the location looks like (for image generation).' },
          definition: { type: 'string', description: 'Optional. A brief logical definition of what this place is.' },
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
        `insert into locations (user_id, name, visual_description, definition, environment, seed, status)
         values ($1, $2, $3, $4, $5, $6, null)
         returning location_id, name`,
        [ctx.userId, args.name.trim(), args.visual_description ?? '', args.definition ?? null, JSON.stringify(args.environment ?? {}), args.seed ?? null],
      );
      return { locationId: row!.location_id, name: row!.name };
    },
  };
}