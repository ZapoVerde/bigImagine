/**
 * @file plugins/documents/src/listDocumentsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — lists documents (summaries only)
 * @description
 * Deliberately excludes content — this backs a browsing list (the Documents tab, or "what have I
 * saved") where full Markdown would be wasted payload; get_document fetches one document's full
 * content once it's been picked. search matches title or summary case-insensitively, same ILIKE
 * approach get_notes uses for notes.
 *
 * @api-declaration
 * createListDocumentsTool() — returns the list_documents RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface DocumentSummaryRow {
  doc_id: string;
  title: string | null;
  summary_short: string | null;
  status: string;
  updated_at: string;
}

function isListDocumentsArgs(value: unknown): value is { search?: string } {
  return typeof value === 'object' && value !== null;
}

export function createListDocumentsTool(): RegisteredTool {
  return {
    definition: {
      name: 'list_documents',
      description:
        "List the user's saved documents (title, summary, and status only, not full content). Optionally filter by a search term matched against title or summary.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: only return documents matching this text.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isListDocumentsArgs(args)) {
        throw new Error('list_documents requires an object argument');
      }
      const like = args.search?.trim() ? `%${args.search.trim()}%` : null;
      const rows = await ctx.db.query<DocumentSummaryRow>(
        `select doc_id, title, summary_short, status, updated_at from documents
         where user_id = $1 and ($2::text is null or title ilike $2 or summary_short ilike $2)
         order by updated_at desc`,
        [ctx.userId, like],
      );
      return rows.map((r) => ({
        docId: r.doc_id,
        title: r.title,
        summaryShort: r.summary_short,
        status: r.status,
        updatedAt: r.updated_at,
      }));
    },
  };
}
