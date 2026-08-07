/**
 * @file plugins/locations/src/generateLocationImageTool.ts
 * @stamp 2026-08-13
 * @architectural-role IO Wrapper — manual/model-triggered location image regeneration
 * @description
 * docs/vistalyze_integration/endpoint.md §6.3: the thin RegisteredTool wrapper around
 * orchestrator/generateLocationImage.ts for *manual* regeneration only — a location edit, an
 * explicit model request, or the CanvasPanel's re-render trigger. The automatic post-cleanup-pass
 * trigger (server/httpServer.ts's fireLocationImageGeneration) calls generateLocationImage.ts
 * directly, deliberately not through this tool: that machinery doesn't apply to a deterministic
 * background pass, and routing it through LLM tool-dispatch would reintroduce the token cost the
 * whole point of endpoint.md §5 is to avoid (segway.md §4).
 *
 * The store is built here from the plugin's own deps (db + cipher) rather than injected — the
 * plugin loader has no image-connection concept, and generateLocationImage needs the real
 * PostgresClient (not the per-call session) plus the cipher to decrypt the active connection's
 * key. This is the same "construct what you need from PluginDeps" shape registerTools already
 * uses elsewhere (e.g. plugins/canonize building its recall store).
 *
 * @api-declaration
 * createGenerateLocationImageTool(deps: PluginDeps) -> RegisteredTool — regenerate_location_image
 *   ({ locationId }); returns LocationImageGenResult { ok, cached?, imageUrl?, error? } — never
 *   throws (generateLocationImage is fail-open; an unavailable connection is a result, not a 500)
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO + provider network call via generateLocationImage)
 *     state_ownership: []
 *     external_io:     [Postgres (via the store), the active image provider]
 */

import { generateLocationImage } from '@bigbrain/orchestrator/generate-location-image';
import { createImageConnectionStore } from '@bigbrain/orchestrator/image-connections';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isGenerateLocationImageArgs(value: unknown): value is { locationId: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.locationId === 'string' && v.locationId.length > 0;
}

export function createGenerateLocationImageTool(deps: PluginDeps): RegisteredTool {
  const imageConnections = createImageConnectionStore(deps.db, deps.cipher);
  return {
    definition: {
      name: 'regenerate_location_image',
      description:
        'Re-render the cached image for one location id (returned by get_locations). Skips the render if the location already has a fresh image; otherwise regenerates through the active image connection and stores the new CDN URL.',
      parameters: {
        type: 'object',
        properties: {
          locationId: { type: 'string', description: 'The location id returned by get_locations.' },
        },
        required: ['locationId'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGenerateLocationImageArgs(args)) {
        throw new Error('regenerate_location_image requires a locationId: string');
      }
      return generateLocationImage(
        { db: deps.db, settings: deps.settings, imageConnections },
        ctx.userId,
        args.locationId,
        ctx.chatId,
      );
    },
  };
}
