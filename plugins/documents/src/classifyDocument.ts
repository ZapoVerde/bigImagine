/**
 * @file plugins/documents/src/classifyDocument.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * Two forced-schema LLM steps for a saved document. summarizeDocument is the §6.1-style
 * one-sentence summary (mirrors plugins/document-ingestion/src/classifyNote.ts's pattern exactly;
 * duplicated rather than imported across the plugin boundary — plugins are siblings with no
 * exports map for cross-plugin imports today). tagChunks is chunk-level, not document-level —
 * search_documents/list_documents rank and filter at chunk granularity, so a tag has to say which
 * chunk it applies to. Fed the user's existing tag vocabulary as a strong nudge toward reuse
 * rather than inventing near-duplicates ("cooking" vs "food") — a nudge, not a guarantee: tags
 * are inexact by nature,
 * same tolerance already extended to unstructured_notes' auto_tags, which has run with zero
 * vocabulary awareness at all. Validation is lenient on coverage (a chunk the model skips just
 * gets no tags) since tagging is supplementary, unlike the summary a document row actually needs.
 *
 * @api-declaration
 * summarizeDocument(llm, title, markdown) — throws if the model doesn't call summarize_document,
 *   or calls it with a malformed payload, rather than returning a partially-guessed summary
 * tagChunks(llm, existingTags, chunks) — throws only on a malformed top-level response; a chunk
 *   the model omits from its answer just gets no tags rather than failing the whole call
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';

const summarizeDocumentTool: ToolDefinition = {
  name: 'summarize_document',
  description: 'Summarize a document in one sentence, for use in a browsing list.',
  parameters: {
    type: 'object',
    properties: {
      summary_short: { type: 'string', description: 'One sentence summarizing the document.' },
    },
    required: ['summary_short'],
    additionalProperties: false,
  },
};

function isSummary(value: unknown): value is { summary_short: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).summary_short === 'string'
  );
}

export async function summarizeDocument(llm: LlmProvider, title: string, markdown: string): Promise<string> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content: 'Summarize the document the user gives you in one sentence. Always answer by calling summarize_document.',
      },
      { role: 'user', content: `Title: ${title}\n\n${markdown}` },
    ],
    [summarizeDocumentTool],
    { forceTool: 'summarize_document' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'summarize_document');
  if (!call) {
    throw new Error('summarizeDocument: model did not call summarize_document despite forceTool');
  }
  if (!isSummary(call.arguments)) {
    throw new Error(`summarizeDocument: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments.summary_short;
}

const tagChunksTool: ToolDefinition = {
  name: 'tag_chunks',
  description: 'Assign a few specific tags to each numbered chunk of a document.',
  parameters: {
    type: 'object',
    properties: {
      chunks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            ordinal: { type: 'number', description: 'The chunk number this tag list is for.' },
            tags: { type: 'array', items: { type: 'string' } },
          },
          required: ['ordinal', 'tags'],
          additionalProperties: false,
        },
      },
    },
    required: ['chunks'],
    additionalProperties: false,
  },
};

interface TagChunksResponse {
  chunks: { ordinal: number; tags: string[] }[];
}

function isChunkTagEntry(value: unknown): value is { ordinal: number; tags: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const ordinal = (value as Record<string, unknown>).ordinal;
  const tags = (value as Record<string, unknown>).tags;
  return typeof ordinal === 'number' && Array.isArray(tags) && tags.every((t) => typeof t === 'string');
}

function isTagChunksResponse(value: unknown): value is TagChunksResponse {
  if (typeof value !== 'object' || value === null) return false;
  const chunks = (value as Record<string, unknown>).chunks;
  return Array.isArray(chunks) && chunks.every(isChunkTagEntry);
}

export async function tagChunks(
  llm: LlmProvider,
  existingTags: string[],
  chunks: { ordinal: number; headingPath: string | null; content: string }[],
): Promise<Map<number, string[]>> {
  const vocabulary = existingTags.length ? existingTags.join(', ') : '(none yet)';
  const chunkList = chunks
    .map((c) => `Chunk ${c.ordinal} (${c.headingPath ?? 'no heading'}):\n${c.content}`)
    .join('\n\n');

  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          `Tag each numbered chunk below with a few specific tags. Strongly prefer reusing one of ` +
          `the existing tags if it fits; only add a new tag if none of them do. Always answer by ` +
          `calling tag_chunks, with one entry per chunk number given.\n\nExisting tags: ${vocabulary}`,
      },
      { role: 'user', content: chunkList },
    ],
    [tagChunksTool],
    { forceTool: 'tag_chunks' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'tag_chunks');
  if (!call) {
    throw new Error('tagChunks: model did not call tag_chunks despite forceTool');
  }
  if (!isTagChunksResponse(call.arguments)) {
    throw new Error(`tagChunks: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }

  const byOrdinal = new Map<number, string[]>();
  for (const entry of call.arguments.chunks) {
    byOrdinal.set(entry.ordinal, entry.tags);
  }
  return byOrdinal;
}
