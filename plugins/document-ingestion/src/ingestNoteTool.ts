/**
 * @file plugins/document-ingestion/src/ingestNoteTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — the Document Ingestion plugin's orchestrator-facing tool
 * @description
 * docs/spec.md §6.1, wired as an orchestrator tool per bb_principles.md §8: classifies the note
 * (classifyNote.ts), embeds the raw text, and writes both to unstructured_notes in one call.
 * pinned_tags is never written here — only auto_tags, category, summary_short — promotion to
 * pinned_tags is an explicit user action elsewhere (bb_principles.md §3), never something this
 * pipeline decides on its own.
 *
 * raw_text and summary_short are encrypted (io/fieldCipher.ts) before the insert — classification
 * and embedding both run on plaintext first, since that's the whole point of the cipher living at
 * the IO boundary rather than upstream of it. category and auto_tags stay plaintext: they're
 * lower-sensitivity structured metadata, and encrypting them would block filtering by them later.
 *
 * llm, embeddings, and cipher are closed over at construction time rather than threaded through
 * ToolHandlerContext, so the shared context type doesn't grow per-plugin-need — each plugin
 * gets exactly the IO wrappers it uses, wired once by whatever composes the tool registry.
 *
 * @api-declaration
 * createIngestNoteTool(llm, embeddings, cipher) — returns the ingest_note RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (LLM, embeddings, and Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [LLM, embeddings provider, Postgres (via the DbSession it's given)]
 */

import { toPgVectorLiteral } from '@bigbrain/orchestrator/pgvector';
import type { EmbeddingProvider } from '@bigbrain/orchestrator/embeddings';
import type { FieldCipher } from '@bigbrain/orchestrator/field-cipher';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { classifyNote } from './classifyNote.js';

function isIngestArgs(value: unknown): value is { raw_text: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).raw_text === 'string' &&
    (value as Record<string, unknown>).raw_text !== ''
  );
}

export function createIngestNoteTool(
  llm: LlmProvider,
  embeddings: EmbeddingProvider,
  cipher: FieldCipher,
): RegisteredTool {
  return {
    definition: {
      name: 'ingest_note',
      description:
        'Ingest a raw note: classify it, extract tags and a short summary, embed it, and store it.',
      parameters: {
        type: 'object',
        properties: {
          raw_text: { type: 'string', description: 'The raw note text to ingest.' },
        },
        required: ['raw_text'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isIngestArgs(args)) {
        throw new Error('ingest_note requires a non-empty raw_text: string argument');
      }
      const rawText = args.raw_text;

      const classification = await classifyNote(llm, rawText);
      const [vector] = await embeddings.embed([rawText]);

      const rows = await ctx.db.query<{ note_id: string }>(
        `insert into unstructured_notes (user_id, raw_text, vector_embed, auto_tags, category, summary_short)
         values ($1, $2, $3, $4, $5, $6)
         returning note_id`,
        [
          ctx.userId,
          cipher.encrypt(rawText),
          toPgVectorLiteral(vector),
          classification.auto_tags,
          classification.category,
          cipher.encrypt(classification.summary_short),
        ],
      );

      return {
        noteId: rows[0]?.note_id,
        category: classification.category,
        autoTags: classification.auto_tags,
        summaryShort: classification.summary_short,
      };
    },
  };
}
