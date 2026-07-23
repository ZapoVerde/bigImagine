/**
 * @file plugins/document-ingestion/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (mirrors SillyTavern's own server plugins):
 * an `info` object identifying the plugin, and an async `registerTools` that returns whatever
 * RegisteredTools it contributes, given the shared IO wrappers (llm, embeddings) the loader
 * already constructed once from env config. This plugin doesn't construct its own providers —
 * that stays centralized so config (which model, which embeddings provider) is read in exactly
 * one place, per bb_principles.md §6.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [ingest_note]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs a tool that does IO; registration itself does none)
 *     state_ownership: []
 *     external_io:     []
 */

import { createIngestNoteTool } from './ingestNoteTool.js';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

export const info = {
  id: 'document-ingestion',
  name: 'Document Ingestion',
  description: 'Classifies, tags, embeds, and stores raw notes (docs/spec.md §6.1).',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [createIngestNoteTool(deps.llm, deps.embeddings, deps.cipher)];
}
