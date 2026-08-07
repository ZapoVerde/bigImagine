/**
 * @file plugins/locations/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The data-only location slice (canonize-plan.md §8) — deliberately not Vistalyze: no image
 * generation, backend config, or cache-invalidation logic. Exposes create_location (write) and
 * get_locations (id/name summaries, so scenes and canon facts can reference location ids).
 * None of these tools need the LLM/embeddings/cipher providers — they only need ctx.db/ctx.userId,
 * supplied per-call.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_location, get_locations]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateLocationTool } from './createLocationTool.js';
import { createGetLocationsTool } from './getLocationsTool.js';
import { createGenerateLocationImageTool } from './generateLocationImageTool.js';

export const info = {
  id: 'locations',
  name: 'Locations',
  description:
    'Structured location records: create locations, list them for referencing in scenes and canon facts, and regenerate a location\'s cached image (Vistalyze).',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createCreateLocationTool(), createGetLocationsTool(), createGenerateLocationImageTool(deps)];
}