/**
 * @file plugins/documents/src/listDocumentTagsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — lists the user's document tag vocabulary
 * @description
 * Sources the tag picker in DocumentsView (frontend/src/views/DocumentsView.tsx) — that view gets
 * everything through callTool against this same tool surface, no separate REST API exists for it.
 * Also the same vocabulary saveDocument.ts's tagChunks is fed as a reuse nudge, so what a picker
 * shows and what a new save is nudged to reuse are always the same query, not two copies that can
 * drift apart.
 *
 * @api-declaration
 * createListDocumentTagsTool() — returns the list_document_tags RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface TagRow {
  tag: string;
}

export function createListDocumentTagsTool(): RegisteredTool {
  return {
    definition: {
      name: 'list_document_tags',
      description: "List the distinct tags in use across the user's saved documents.",
      parameters: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<TagRow>(
        'select distinct unnest(tags) as tag from document_chunks where user_id = $1 order by tag',
        [ctx.userId],
      );
      return rows.map((r) => r.tag);
    },
  };
}
