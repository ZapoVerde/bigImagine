/**
 * @file plugins/documents/src/searchDocumentsTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — semantic search over document chunks
 * @description
 * The first thing in bigBrain that actually queries a vector_embed column by similarity — every
 * other embedding (documents.vector_embed, unstructured_notes.vector_embed) is written on save
 * but never read back. Ranks document_chunks by cosine distance to the embedded query via
 * pgvector's `<->` operator; no ivfflat/hnsw index yet (household-scale row counts don't need
 * one, a sequential scan is fine — add one later without touching this file if that changes).
 * Distinct from list_documents' exact-substring ILIKE match: this finds chunks by meaning, not
 * by matching text in the title/summary.
 *
 * @api-declaration
 * createSearchDocumentsTool(embeddings) — returns the search_documents RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (embeddings provider call, Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [embeddings provider, Postgres (via the DbSession it's given)]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';

interface ChunkRow {
  doc_id: string;
  title: string | null;
  heading_path: string | null;
  content: string;
}

function isSearchDocumentsArgs(value: unknown): value is { query: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).query === 'string'
  );
}

export function createSearchDocumentsTool(embeddings: EmbeddingProvider): RegisteredTool {
  return {
    definition: {
      name: 'search_documents',
      description:
        "Semantic search over the user's saved documents: finds the passages whose meaning best matches the query, not just matching text. Returns ranked excerpts — follow up with get_document for a full document.",
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'What to search for.' },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSearchDocumentsArgs(args)) {
        throw new Error('search_documents requires a query: string argument');
      }
      const [vector] = await embeddings.embed([args.query]);
      const rows = await ctx.db.query<ChunkRow>(
        `select dc.doc_id, d.title, dc.heading_path, dc.content
         from document_chunks dc
         join documents d on d.doc_id = dc.doc_id
         where dc.user_id = $1
         order by dc.vector_embed <-> $2
         limit 8`,
        [ctx.userId, toPgVectorLiteral(vector!)],
      );
      return rows.map((r) => ({
        docId: r.doc_id,
        title: r.title,
        headingPath: r.heading_path,
        excerpt: r.content,
      }));
    },
  };
}
