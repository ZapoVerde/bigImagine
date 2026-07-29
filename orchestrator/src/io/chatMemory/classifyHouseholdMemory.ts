/**
 * @file orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * The end-of-chat judgment call behind household_memory (db/migrations/0039_household_memory.sql):
 * given everything known about a chat being archived — its full chat_memory_entries digest plus
 * any still-live raw tail — decide whether anything in it is worth remembering beyond this one
 * chat. Triggered exactly once, by the explicit archive_chat action (docs/bb_principles.md §3),
 * never inferred from idle time.
 *
 * An empty memories array is the common, expected answer — most chats have nothing that rises
 * above "specific to this conversation." Only call this at archive time, not on every sync; it's
 * a one-shot judgment about the whole chat, not an incremental digest like distillChatMemory.
 *
 * @api-declaration
 * classifyHouseholdMemory(llm, chatSummary) — throws only on a malformed top-level response;
 *   returns [] when nothing is worth keeping long-term
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '../llm/types.js';

export const DEFAULT_HOUSEHOLD_MEMORY_PROMPT =
  'This conversation just ended. Decide whether anything in it is worth remembering beyond this one chat. Always ' +
  'answer by calling classify_household_memory, with an empty list if nothing qualifies.';

const classifyHouseholdMemoryTool: ToolDefinition = {
  name: 'classify_household_memory',
  description:
    'Decide whether anything from this now-finished conversation is worth remembering in future, unrelated ' +
    'conversations — a standing preference, a correction, a fact about the household that will stay true. Return an ' +
    'empty list if nothing rises above being specific to this one conversation.',
  parameters: {
    type: 'object',
    properties: {
      memories: {
        type: 'array',
        items: {
          type: 'string',
          description: 'One durable, self-contained fact or preference worth recalling later, written so it makes sense with no other context.',
        },
      },
    },
    required: ['memories'],
    additionalProperties: false,
  },
};

function isMemoriesResponse(value: unknown): value is { memories: string[] } {
  if (typeof value !== 'object' || value === null) return false;
  const memories = (value as Record<string, unknown>).memories;
  return Array.isArray(memories) && memories.every((m) => typeof m === 'string');
}

export async function classifyHouseholdMemory(llm: LlmProvider, chatSummary: string, promptOverride?: string): Promise<string[]> {
  const turn = await llm.complete(
    [
      { role: 'system', content: promptOverride || DEFAULT_HOUSEHOLD_MEMORY_PROMPT },
      { role: 'user', content: chatSummary },
    ],
    [classifyHouseholdMemoryTool],
    { forceTool: 'classify_household_memory' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'classify_household_memory');
  if (!call) {
    throw new Error('classifyHouseholdMemory: model did not call classify_household_memory despite forceTool');
  }
  if (!isMemoriesResponse(call.arguments)) {
    throw new Error(`classifyHouseholdMemory: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments.memories;
}
