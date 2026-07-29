/**
 * @file orchestrator/src/io/chatMemory/classifyChatChunk.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * One forced-schema step per archived chat chunk, same shape as
 * plugins/documents/src/classifyDocument.ts's summarizeDocument: a short gist stored (and
 * embedded) alongside the chunk's raw content, so recall_chat_history's results are scannable
 * without re-reading the full excerpt.
 *
 * DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT is exported so the Settings tab's "default + bespoke" chat-
 * memory panel (docs/chat-memory.md, mirroring SillyTavern-Canonize's own "Connections & Prompts"
 * section) can show it as a placeholder/reset target; io/orchestratorSettings.ts's
 * chat_memory_chunk_summary_prompt overrides it when set to a non-empty value.
 *
 * @api-declaration
 * DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT — the built-in system prompt, used whenever no override is set
 * summarizeChatChunk(llm, content, promptOverride?) — throws if the model doesn't call
 *   summarize_chat_chunk despite forceTool, or calls it with a malformed payload
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '../llm/types.js';

export const DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT =
  'Summarize the following slice of a conversation in one or two sentences — what was discussed or decided, not a ' +
  'transcript. Always answer by calling summarize_chat_chunk.';

const summarizeChatChunkTool: ToolDefinition = {
  name: 'summarize_chat_chunk',
  description: 'Summarize a slice of conversation in one or two sentences, for use in a search result list.',
  parameters: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One or two sentences summarizing what was discussed or decided in this slice.' },
    },
    required: ['summary'],
    additionalProperties: false,
  },
};

function isSummary(value: unknown): value is { summary: string } {
  return typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).summary === 'string';
}

export async function summarizeChatChunk(llm: LlmProvider, content: string, promptOverride?: string): Promise<string> {
  const turn = await llm.complete(
    [
      { role: 'system', content: promptOverride || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT },
      { role: 'user', content },
    ],
    [summarizeChatChunkTool],
    { forceTool: 'summarize_chat_chunk' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'summarize_chat_chunk');
  if (!call) {
    throw new Error('summarizeChatChunk: model did not call summarize_chat_chunk despite forceTool');
  }
  if (!isSummary(call.arguments)) {
    throw new Error(`summarizeChatChunk: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments.summary;
}
