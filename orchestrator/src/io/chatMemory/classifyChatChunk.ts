/**
 * @file orchestrator/src/io/chatMemory/classifyChatChunk.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call with local parsing
 * @description
 * One ordinary-completion step per archived chat chunk, same shape as
 * plugins/documents/src/classifyDocument.ts's summarizeDocument: a short gist stored (and
 * embedded) alongside the chunk's raw content, so recall_chat_history's results are scannable
 * without re-reading the full excerpt.
 *
 * The LLM call is a plain-text completion (empty tools, no forceTool) whose raw text is parsed
 * locally — the same transport SillyTavern-Canonize uses, so the classifier works across whatever
 * connection is active, including routes that reject or mishandle forced tool_choice
 * (docs/plans/chat-memory-structured-output-plan.md).
 *
 * DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT is exported so the Settings tab's "default + bespoke" chat-
 * memory panel (docs/chat-memory.md, mirroring SillyTavern-Canonize's own "Connections & Prompts"
 * section) can show it as a placeholder/reset target; io/orchestratorSettings.ts's
 * chat_memory_chunk_summary_prompt overrides it when set to a non-empty value.
 *
 * @api-declaration
 * DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT — the built-in system prompt, used whenever no override is set
 * summarizeChatChunk(llm, content, promptOverride?) — throws if the model returns a response that
 *   is empty after trimming and stripping one enclosing markdown fence
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider } from '../llm/types.js';

export const DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT = `You are a precise conversation memory classifier.

Write a compact memory header for the conversation slice provided below. This header will be embedded and used later to decide whether the underlying conversation is relevant to a future query.

Identify the most important durable development in the slice rather than summarising every exchange.

For roleplay or narrative conversation, prioritise:
- significant events or actions
- revelations or discoveries
- confrontations or decisions
- meaningful relationship or emotional shifts
- changes in goals, threats, circumstances, or story state

For ordinary conversation, prioritise:
- decisions or conclusions
- important facts established
- plans or commitments
- corrections or changed understanding
- the central subject when no stronger development occurred

Preserve the concrete names, places, objects, concepts, and distinctive terms that would make this memory discoverable later.

Do not include conversational filler, repeated detail, prose atmosphere with no lasting significance, or a turn-by-turn recap.

Write 2–4 concise sentences in past tense.

Output only the memory header. No title, label, bullets, explanation, quotes, or markdown.`;

function parseSummary(raw: string): string {
  let text = raw.trim();
  if (text.startsWith('```') && text.endsWith('```')) {
    text = text
      .replace(/^```[^\n]*\n/, '')
      .replace(/\n```\s*$/, '')
      .trim();
  }
  if (text.length === 0) {
    throw new Error('summarizeChatChunk: model returned an empty response');
  }
  return text;
}

export async function summarizeChatChunk(llm: LlmProvider, content: string, promptOverride?: string): Promise<string> {
  const turn = await llm.complete(
    [
      { role: 'system', content: promptOverride || DEFAULT_CHAT_CHUNK_SUMMARY_PROMPT },
      { role: 'user', content },
    ],
    [],
  );
  return parseSummary(turn.message.content);
}
