/**
 * @file plugins/documents/src/index.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as notes/lists/recipes/document-
 * ingestion): an `info` object and an async `registerTools`. Needs deps.llm/deps.embeddings for
 * save_document/ingest_url's summarize+embed step (classifyDocument.ts) — everything else
 * (gitRepo.ts's local repos, ctx.db) is either plugin-local or supplied per-call, same as notes.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [save_document, get_document, list_documents, ingest_url]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createGetDocumentTool } from './getDocumentTool.js';
import { createIngestUrlTool } from './ingestUrlTool.js';
import { createListDocumentsTool } from './listDocumentsTool.js';
import { createSaveDocumentTool } from './saveDocumentTool.js';

export const info = {
  id: 'documents',
  name: 'Documents',
  description: 'Markdown documents backed by a local per-user git repository: save, read, list, and clip web pages.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createSaveDocumentTool(deps.llm, deps.embeddings),
    createGetDocumentTool(),
    createListDocumentsTool(),
    createIngestUrlTool(deps.llm, deps.embeddings),
  ];
}
