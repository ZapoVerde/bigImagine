/**
 * @file plugins/context-stack-presets/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as prompt-presets/notes/lists): an
 * `info` object and an async `registerTools`. Most of these tools only need ctx.db/ctx.userId,
 * supplied per-call — no LLM/embeddings/cipher/Notion providers. assemblePromptStack (now a core
 * util, orchestrator/src/util/assemblePromptStack.ts — moved out of this plugin 2026-08-06 so
 * server/httpServer.ts's per-turn narrator assembly, docs/turn-loop-plan.md §3.2, could call it
 * without inverting the plugin/core dependency direction) is deliberately not exposed as a tool
 * here: it's a pure function. apply_prompt_stack_to_chat is this plugin's own IO-performing
 * caller of it (the RP settings panel's "Apply" action, frontend/src/views/ChatView.tsx) — a
 * second caller now lives in core, not a replacement for this one. It alone needs deps.settings,
 * to read the persona_name/persona_description settings (migration 0053, docs/prompt-macros.md's
 * Stage 1) it folds into the 'persona' marker slot.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_context_stack_preset, get_context_stack_presets,
 *   update_context_stack_preset, delete_context_stack_preset, apply_prompt_stack_to_chat,
 *   set_default_context_stack_preset]
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
import { createApplyPromptStackToChatTool } from './applyPromptStackToChatTool.js';
import { createSetDefaultContextStackPresetTool } from './setDefaultContextStackPresetTool.js';

export const info = {
  id: 'context-stack-presets',
  name: 'Context Stack Presets',
  description: 'Reusable, ordered prompt-stack presets — which context slots go into an assembled turn, and in what order: create, list, edit, delete.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreateContextStackPresetTool(),
    createGetContextStackPresetsTool(),
    createUpdateContextStackPresetTool(),
    createDeleteContextStackPresetTool(),
    createApplyPromptStackToChatTool(deps.settings),
    createSetDefaultContextStackPresetTool(),
  ];
}
