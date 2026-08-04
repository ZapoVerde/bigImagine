/**
 * @file plugins/characters/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The data-only character slice (canonize-plan.md §8) — deliberately not the Character Roster:
 * no PNG/JSON import, no card-spec chunk parsing. Exposes create_character (write) and
 * get_characters (id/name summaries, so scenes and canon facts can reference character ids).
 * Extraction never touches this table — it proposes canon_facts rows instead
 * (canonize-plan.md §3.3). None of these tools need the LLM/embeddings/cipher providers — they
 * only need ctx.db/ctx.userId, supplied per-call.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_character, get_characters]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateCharacterTool } from './createCharacterTool.js';
import { createGetCharactersTool } from './getCharactersTool.js';

export const info = {
  id: 'characters',
  name: 'Characters',
  description: 'Structured character records: create characters and list them for referencing in scenes and canon facts.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createCreateCharacterTool(), createGetCharactersTool()];
}