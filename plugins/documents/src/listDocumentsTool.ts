/**
 * @file plugins/documents/src/listDocumentsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — lists documents (summaries only)
 * @description
 * Deliberately excludes content — this backs a browsing list (the Documents tab, or "what have I
 * saved") where full Markdown would be wasted payload; get_document fetches one document's full
 * content once it's been picked.
 *
 * search is this app's lexical search box (docs/spec.md §6.6): ranked full-text over
 * document_chunks' heading_path/content, not the old title/summary ILIKE — a search box gets a
 * short, deliberately-typed query, which is exactly the case lexical ranking (not semantic/
 * embedding search_documents does) is suited to. heading_path matches outrank body-text matches
 * (setweight 'A' vs 'B'), same idea as a header-field weighting a full-text index gives extra
 * credit to a title match over the same word buried in a paragraph.
 *
 * left join, not inner — a document somehow lacking chunks (shouldn't happen given saveDocument.ts
 * always chunks on save, chunkDocument.ts always returns at least one chunk, but this shouldn't be
 * fragile against it) still shows up in a plain browse (no search, no tags); it just can't match a
 * search term or tag filter, which is the correct behavior for content that isn't there.
 *
 * tags filters by document_chunks.tags overlap (&&) — auto-assigned per chunk at save time
 * (saveDocument.ts's tagChunks); sourced for a picker via list_document_tags.
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

function isListDocumentsArgs(value: unknown): value is { search?: string; tags?: string[] } {
  return typeof value === 'object' && value !== null;
}

const TSVECTOR_EXPR = `(
  setweight(to_tsvector('english', coalesce(dc.heading_path, '')), 'A') ||
  setweight(to_tsvector('english', coalesce(dc.content, '')), 'B')
)`;

export function createListDocumentsTool(): RegisteredTool {
  return {
    definition: {
      name: 'list_documents',
      description:
        "List the user's saved documents (title, summary, and status only, not full content). Optionally search full-text (matches document content and headings, not just title) and/or filter to documents having any of the given tags.",
      parameters: {
        type: 'object',
        properties: {
          search: { type: 'string', description: 'Optional: only return documents whose content matches this text.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional: only return documents having at least one of these tags.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isListDocumentsArgs(args)) {
        throw new Error('list_documents requires an object argument');
      }
      const search = args.search?.trim() || null;
      const tags = args.tags?.length ? args.tags : null;

      const rows = await ctx.db.query<DocumentSummaryRow>(
        `select d.doc_id, d.title, d.summary_short, d.status, d.updated_at
         from documents d
         left join document_chunks dc on dc.doc_id = d.doc_id
         where d.user_id = $1
           and ($2::text is null or ${TSVECTOR_EXPR} @@ plainto_tsquery('english', $2))
           and ($3::text[] is null or dc.tags && $3)
         group by d.doc_id
         order by
           (case when $2::text is null then null
                 else max(ts_rank(${TSVECTOR_EXPR}, plainto_tsquery('english', $2))) end) desc nulls last,
           d.updated_at desc`,
        [ctx.userId, search, tags],
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
