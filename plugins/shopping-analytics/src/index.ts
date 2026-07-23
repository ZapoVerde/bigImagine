/**
 * @file plugins/shopping-analytics/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as document-ingestion): an `info`
 * object and an async `registerTools`. Unlike document-ingestion, this plugin needs none of the
 * shared providers in PluginDeps (no LLM classification step, no embeddings, no field cipher —
 * see logPurchaseTool.ts and shoppingAnalyticsTool.ts for why) — it still accepts the same
 * PluginDeps shape the loader always passes, it just doesn't use any of it.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [log_purchase, get_shopping_patterns]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO; registration itself does none)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createLogPurchaseTool } from './logPurchaseTool.js';
import { createShoppingAnalyticsTool } from './shoppingAnalyticsTool.js';

export const info = {
  id: 'shopping-analytics',
  name: 'Shopping Analytics',
  description: 'Logs purchases and answers chronological repurchase-pattern questions (docs/spec.md §6.2).',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createLogPurchaseTool(), createShoppingAnalyticsTool()];
}
