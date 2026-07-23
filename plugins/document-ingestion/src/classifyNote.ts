/**
 * @file plugins/document-ingestion/src/classifyNote.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * The "auto-taxonomy" half of docs/spec.md §6.1: a forced tool call (LlmCompleteOptions.forceTool)
 * against a single classify_note tool definition, so the model can't reply with prose instead of
 * the {category, auto_tags, summary_short} shape the caller needs. Validates the result at
 * runtime rather than trusting the cast — forced tool use narrows what the model is *offered*,
 * it doesn't guarantee every field actually arrives with the right type.
 *
 * @api-declaration
 * classifyNote(llm, rawText) — throws if the model doesn't call classify_note, or calls it with
 *   a malformed payload, rather than returning a partially-guessed classification
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';

export interface NoteClassification {
  category: string;
  auto_tags: string[];
  summary_short: string;
}

const classifyNoteTool: ToolDefinition = {
  name: 'classify_note',
  description: 'Classify a raw note into a category, a short list of tags, and a one-line summary.',
  parameters: {
    type: 'object',
    properties: {
      category: { type: 'string', description: 'A single broad category for the note.' },
      auto_tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Several specific, noisy-is-fine tags describing the note.',
      },
      summary_short: { type: 'string', description: 'One sentence summarizing the note.' },
    },
    required: ['category', 'auto_tags', 'summary_short'],
    additionalProperties: false,
  },
};

function isNoteClassification(value: unknown): value is NoteClassification {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.category === 'string' &&
    Array.isArray(v.auto_tags) &&
    v.auto_tags.every((t) => typeof t === 'string') &&
    typeof v.summary_short === 'string'
  );
}

export async function classifyNote(llm: LlmProvider, rawText: string): Promise<NoteClassification> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content: 'Classify the note the user gives you. Always answer by calling classify_note.',
      },
      { role: 'user', content: rawText },
    ],
    [classifyNoteTool],
    { forceTool: 'classify_note' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'classify_note');
  if (!call) {
    throw new Error('classifyNote: model did not call classify_note despite forceTool');
  }
  if (!isNoteClassification(call.arguments)) {
    throw new Error(`classifyNote: model's classify_note call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments;
}
