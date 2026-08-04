/**
 * @file plugins/canonize/src/index.ts
 * @stamp 2026-08-04
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The Canonize plugin (canonize-plan.md §5): propose/approve/reject/get_proposals/recall around
 * the canon_facts table. propose and get_proposals need the embeddings provider (proposal embeds
 * its own summary+detail at write time); recall needs both embeddings and the orchestrator
 * settings store (canon_recall_top_k). Approve/reject are plain Postgres CRUD needing only
 * ctx.db/ctx.userId. This plugin is the canon-facts boundary only — characters/locations/scenes
 * live in their own plugin packages.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [propose_canon_fact, approve_canon_fact, reject_canon_fact,
 *   get_canon_fact_proposals, recall_canon_facts]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createProposeCanonFactTool } from './proposeCanonFactTool.js';
import { createApproveCanonFactTool } from './approveCanonFactTool.js';
import { createRejectCanonFactTool } from './rejectCanonFactTool.js';
import { createGetCanonFactProposalsTool } from './getCanonFactProposalsTool.js';
import { createRecallCanonFactsTool } from './recallCanonFactsTool.js';

export const info = {
  id: 'canonize',
  name: 'Canonize',
  description: 'Approved Canon Facts with human-in-the-loop proposal review: propose, approve/reject, recall.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createProposeCanonFactTool(deps.embeddings),
    createApproveCanonFactTool(),
    createRejectCanonFactTool(),
    createGetCanonFactProposalsTool(),
    createRecallCanonFactsTool(deps.embeddings, deps.settings),
  ];
}