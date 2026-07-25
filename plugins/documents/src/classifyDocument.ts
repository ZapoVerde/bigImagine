/**
 * @file plugins/documents/src/classifyDocument.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * The §6.1-style summarization step for a saved document, scoped to what `documents` actually has
 * a column for (`summary_short` — no `category`/`auto_tags`, unlike `unstructured_notes`; a
 * document is found by browsing/search over title and this summary, not tag filtering). Mirrors
 * plugins/document-ingestion/src/classifyNote.ts's forced-tool-call pattern exactly; duplicated
 * rather than imported across the plugin boundary, same precedent plugins/recipes' meal-plan
 * shopping-list tool already set — plugins are siblings with no exports map for cross-plugin
 * imports today, and this is a small enough amount of logic that a first-ever plugin-to-plugin
 * dependency isn't worth introducing for it.
 *
 * @api-declaration
 * summarizeDocument(llm, title, markdown) — throws if the model doesn't call summarize_document,
 *   or calls it with a malformed payload, rather than returning a partially-guessed summary
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
