/**
 * @file plugins/scenes/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The data-only scene slice (canonize-plan.md §8) — the smallest possible scene tooling so
 * canon_facts and recall_canon_facts are exercisable: create_scene, get_scenes (with presence and
 * active location), set_active_location, and add_character_to_scene. Direct mutations, no Director
 * Pass. None of these tools need the LLM/embeddings/cipher providers — they only need
 * ctx.db/ctx.userId, supplied per-call.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_scene, get_scenes, set_active_location,
 *   add_character_to_scene]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateSceneTool } from './createSceneTool.js';
import { createGetScenesTool } from './getScenesTool.js';
import { createSetActiveLocationTool } from './setActiveLocationTool.js';
import { createAddCharacterToSceneTool } from './addCharacterToSceneTool.js';

export const info = {
  id: 'scenes',
  name: 'Scenes',
  description: 'Scenes and presence: create scenes, set their active location, and manage which characters are present.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreateSceneTool(),
    createGetScenesTool(),
    createSetActiveLocationTool(),
    createAddCharacterToSceneTool(),
  ];
}