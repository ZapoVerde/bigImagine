/**
 * @file plugins/lists/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as document-ingestion and
 * shopping-analytics): an `info` object and an async `registerTools`. None of these tools need
 * the LLM/embeddings/cipher providers — they only need ctx.db/ctx.userId, supplied per-call.
 * add_list_item and complete_list_item do use deps.notion (best-effort outbound Notion sync,
 * notionSync.ts) — deps.notion is undefined when Notion isn't configured, and both tools work
 * fully without it either way.
 *
 * registerTools is also where the inbound half starts: if deps.notion is set, it starts a
 * background poll loop (notionReconcile.ts) using deps.db directly — not through any tool call.
 * This has to live here rather than in orchestrator/src/index.ts specifically because the
 * orchestrator must never statically import a plugin package (that's the whole reason plugins are
 * dynamically loaded at all, per pluginLoader.ts's docstring) — so a plugin that needs background
 * behavior beyond responding to tool calls has to start it itself, using the deps it's handed.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_list, add_list_item, complete_list_item, get_list_items]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; starts a background poll timer when
 *                      Notion is configured)
 *     state_ownership: [the Notion reconciliation poll timer, when started]
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateListTool } from './createListTool.js';
import { createAddListItemTool } from './addListItemTool.js';
import { createCompleteListItemTool } from './completeListItemTool.js';
import { createGetListItemsTool } from './getListItemsTool.js';
import { startNotionReconcileLoop } from './notionReconcile.js';

const NOTION_POLL_INTERVAL_MS = 30_000; // imperceptible delay at household scale; see notionReconcile.ts

export const info = {
  id: 'lists',
  name: 'Lists',
  description: 'Generic named todo lists: create, add items, check them off, read them back.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  if (deps.notion) {
    startNotionReconcileLoop(deps.db, deps.notion, NOTION_POLL_INTERVAL_MS);
  }

  return [
    createCreateListTool(),
    createAddListItemTool(deps.notion),
    createCompleteListItemTool(deps.notion),
    createGetListItemsTool(),
  ];
}
