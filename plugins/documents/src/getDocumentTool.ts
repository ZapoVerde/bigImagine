/**
 * @file plugins/documents/src/getDocumentTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — reads one document's full content
 * @description
 * Companion to list_documents: that lists titles/summaries only, this fetches the row plus the
 * actual Markdown from the user's own git working tree (gitRepo.ts) once a document's been picked.
 * found: false (rather than throwing) when the id doesn't exist or belongs to another user — RLS
 * makes cross-user rows simply not match, same as every other by-id lookup in this codebase.
 *
 * @api-declaration
 * createGetDocumentTool() — returns the get_document RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, filesystem read)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), filesystem]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { readDocumentFile } from './gitRepo.js';

interface DocumentRow {
  doc_id: string;
  title: string | null;
  file_path: string;
  summary_short: string | null;
  status: string;
  updated_at: string;
  source_url: string | null;
  site_name: string | null;
  author: string | null;
  published_at: string | null;
}

function isGetDocumentArgs(value: unknown): value is { doc_id: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).doc_id === 'string'
  );
}

export function createGetDocumentTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_document',
      description: "Get one document's full Markdown content by id.",
      parameters: {
        type: 'object',
        properties: {
          doc_id: { type: 'string', description: 'The document to fetch.' },
        },
        required: ['doc_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetDocumentArgs(args)) {
        throw new Error('get_document requires a doc_id: string argument');
      }
      const [row] = await ctx.db.query<DocumentRow>(
        `select doc_id, title, file_path, summary_short, status, updated_at,
                source_url, site_name, author, published_at
         from documents where doc_id = $1 and user_id = $2`,
        [args.doc_id, ctx.userId],
      );
      if (!row) return { found: false, docId: args.doc_id };

      let content: string;
      try {
        content = await readDocumentFile(ctx.userId, row.file_path);
      } catch (err) {
        // The Postgres row is only ever an index over the git-canonical file (§5) — if the file is
        // missing from under it, that's a real, surfaceable inconsistency, not a silent empty read.
        log.error(
          `get_document: row ${row.doc_id} points at missing file ${row.file_path} for user ${ctx.userId}`,
          err,
        );
        return { found: false, docId: args.doc_id };
      }

      return {
        found: true,
        docId: row.doc_id,
        title: row.title ?? row.file_path,
        content,
        summaryShort: row.summary_short,
        status: row.status,
        updatedAt: row.updated_at,
        sourceUrl: row.source_url,
        siteName: row.site_name,
        author: row.author,
        publishedAt: row.published_at,
      };
    },
  };
}
