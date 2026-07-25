/**
 * @file plugins/documents/src/saveDocumentTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — the documents plugin's create/update tool
 * @description
 * docs/spec.md §6.6's write path. Same call shape as create_note/create_recipe — title + content
 * in, a document row out — but the content is real Markdown that lives canonically in the user's
 * own local git repo (gitRepo.ts), not in Postgres (`documents` stays not-canonical for its own
 * content, per §5). Re-saving the same title/path updates the existing document rather than
 * creating a duplicate (saveDocument.ts's upsert on (repo, file_path)).
 *
 * @api-declaration
 * createSaveDocumentTool(llm, embeddings) — returns the save_document RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (filesystem/git, LLM, embeddings, Postgres via the injected session)
 *     state_ownership: []
 *     external_io:     [filesystem, the local `git` binary, LLM, embeddings provider, Postgres]
 */

import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { saveDocument } from './saveDocument.js';

function isSaveDocumentArgs(
  value: unknown,
): value is { title: string; content_markdown: string; path?: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.title === 'string' && v.title !== '' && typeof v.content_markdown === 'string';
}

export function createSaveDocumentTool(llm: LlmProvider, embeddings: EmbeddingProvider): RegisteredTool {
  return {
    definition: {
      name: 'save_document',
      description:
        "Save a document (Markdown content with a title) to the user's document repository. Re-saving the same title updates the existing document rather than creating a duplicate.",
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'The document title.' },
          content_markdown: { type: 'string', description: 'The document body, as Markdown.' },
          path: { type: 'string', description: 'Optional explicit file path (defaults to a slug of the title).' },
        },
        required: ['title', 'content_markdown'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isSaveDocumentArgs(args)) {
        throw new Error('save_document requires title: string and content_markdown: string arguments');
      }
      const result = await saveDocument({ llm, embeddings, db: ctx.db }, ctx.userId, {
        title: args.title,
        contentMarkdown: args.content_markdown,
        path: args.path,
      });
      return {
        docId: result.docId,
        title: result.title,
        filePath: result.filePath,
        summaryShort: result.summaryShort,
        commitSha: result.commitSha,
      };
    },
    focusHint: (result) => (result as { docId?: string }).docId ?? null,
  };
}
