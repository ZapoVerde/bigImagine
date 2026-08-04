/**
 * @file plugins/context-stack-presets/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as prompt-presets/notes/lists): an
 * `info` object and an async `registerTools`. These tools only need ctx.db/ctx.userId, supplied
 * per-call — no LLM/embeddings/cipher/Notion providers. assemblePromptStack.ts is deliberately
 * not exposed as a tool here: it's a pure function meant to be called directly by whatever
 * resolves a turn's effective preset (an Orchestrator, once scenes/characters exist), not
 * something an LLM invokes on demand.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_context_stack_preset, get_context_stack_presets,
 *   update_context_stack_preset, delete_context_stack_preset]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateContextStackPresetTool } from './createContextStackPresetTool.js';
import { createGetContextStackPresetsTool } from './getContextStackPresetsTool.js';
import { createUpdateContextStackPresetTool } from './updateContextStackPresetTool.js';
import { createDeleteContextStackPresetTool } from './deleteContextStackPresetTool.js';

export const info = {
  id: 'context-stack-presets',
  name: 'Context Stack Presets',
  description: 'Reusable, ordered prompt-stack presets — which context slots go into an assembled turn, and in what order: create, list, edit, delete.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreateContextStackPresetTool(),
    createGetContextStackPresetsTool(),
    createUpdateContextStackPresetTool(),
    createDeleteContextStackPresetTool(),
  ];
}
