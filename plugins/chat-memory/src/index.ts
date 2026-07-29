/**
 * @file plugins/chat-memory/src/index.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as documents/notes/lists): an `info`
 * object and an async `registerTools`. No `startBackgroundJobs` here — unlike those plugins, the
 * actual rolling-sync/RAG pipeline this feature is built on
 * (orchestrator/src/orchestrator/chatMemorySync.ts) lives in orchestrator core, not this plugin,
 * because it needs io/llm/callContext.ts's runWithCallContext (bb_principles.md §14's gate),
 * which — like runTurn/ToolRegistry — isn't in the plugin-facing exports map
 * (orchestrator/package.json). This plugin only contributes the LLM-facing tools, which need
 * nothing beyond what PluginDeps already provides (embeddings for recall_chat_history; the rest
 * are plain Postgres CRUD needing only ctx.db/ctx.userId).
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [recall_chat_history, get_household_memory,
 *   create_household_memory, update_household_memory, delete_household_memory]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createRecallChatHistoryTool } from './recallChatHistoryTool.js';
import { createGetHouseholdMemoryTool } from './getHouseholdMemoryTool.js';
import { createCreateHouseholdMemoryTool } from './createHouseholdMemoryTool.js';
import { createUpdateHouseholdMemoryTool } from './updateHouseholdMemoryTool.js';
import { createDeleteHouseholdMemoryTool } from './deleteHouseholdMemoryTool.js';

export const info = {
  id: 'chat-memory',
  name: 'Chat Memory',
  description: 'Rolling chat summarization and recall: full-turn search over archived turns, plus cross-chat household memory.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createRecallChatHistoryTool(deps.embeddings),
    createGetHouseholdMemoryTool(),
    createCreateHouseholdMemoryTool(),
    createUpdateHouseholdMemoryTool(),
    createDeleteHouseholdMemoryTool(),
  ];
}
