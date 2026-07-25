/**
 * @file plugins/prompt-presets/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as notes/lists/recipes): an `info`
 * object and an async `registerTools`. None of these tools need the LLM/embeddings/cipher/Notion
 * providers — they only need ctx.db/ctx.userId, supplied per-call. Reachable both from
 * conversation (the LLM calling these tools) and from the Chat tab's per-chat settings pane (via
 * the generic callTool API) — same dual-surface shape as notes.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_prompt_preset, get_prompt_presets, update_prompt_preset,
 *   delete_prompt_preset]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreatePromptPresetTool } from './createPromptPresetTool.js';
import { createGetPromptPresetsTool } from './getPromptPresetsTool.js';
import { createUpdatePromptPresetTool } from './updatePromptPresetTool.js';
import { createDeletePromptPresetTool } from './deletePromptPresetTool.js';

export const info = {
  id: 'prompt-presets',
  name: 'Prompt Presets',
  description: 'Reusable named system-prompt snippets ("instruction sets"): create, list, edit, delete.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreatePromptPresetTool(),
    createGetPromptPresetsTool(),
    createUpdatePromptPresetTool(),
    createDeletePromptPresetTool(),
  ];
}
