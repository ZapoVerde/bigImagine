/**
 * @file plugins/notes/src/index.ts
 * @stamp 2026-07-24
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as lists/recipes/document-ingestion):
 * an `info` object and an async `registerTools`. None of these tools need the LLM/embeddings/
 * cipher/Notion providers — they only need ctx.db/ctx.userId, supplied per-call. Reachable both
 * from conversation (the LLM calling these tools) and from the frontend's Notes tab
 * (NotesView.tsx, via the generic callTool API) — same dual-surface shape as lists/recipes.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [create_note, get_notes, get_note, update_note, delete_note]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createCreateNoteTool } from './createNoteTool.js';
import { createGetNotesTool } from './getNotesTool.js';
import { createGetNoteTool } from './getNoteTool.js';
import { createUpdateNoteTool } from './updateNoteTool.js';
import { createDeleteNoteTool } from './deleteNoteTool.js';

export const info = {
  id: 'notes',
  name: 'Notes',
  description: 'Freeform notes: create, read, edit, delete, search by title/content.',
};

export async function registerTools(_deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createCreateNoteTool(),
    createGetNotesTool(),
    createGetNoteTool(),
    createUpdateNoteTool(),
    createDeleteNoteTool(),
  ];
}
