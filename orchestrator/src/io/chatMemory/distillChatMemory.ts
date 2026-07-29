/**
 * @file orchestrator/src/io/chatMemory/distillChatMemory.ts
 * @stamp 2026-07-28
 * @architectural-role IO Wrapper — forced-schema LLM call
 * @description
 * Maintains the per-chat "key ideas" digest (chat_memory_entries — see
 * db/migrations/0038_chat_memory_entries.sql). Given the chat's current entries and the newly
 * archived chunk summaries, the model returns only the entries that are new or need updating —
 * anything it doesn't mention is left exactly as stored (never silently deleted, matching
 * Canonize's plot-lorebook curator). Reusing an existing topic_key is how an ongoing thread stays
 * one row instead of accumulating a new one every sync; a new topic_key is coined only for a
 * genuinely new idea. runChatSync.ts upserts the returned entries on (chat_id, topic_key).
 *
 * An empty entries array is a legitimate answer ("nothing new or changed worth tracking this
 * round"), not treated as a failure — distinct from summarizeChatChunk, which always has
 * something to summarize.
 *
 * @api-declaration
 * distillChatMemory(llm, existingEntries, newChunkSummaries) — throws only on a malformed
 *   top-level response; returns [] when nothing needs to change
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '../llm/types.js';

export const DEFAULT_DISTILL_CHAT_MEMORY_PROMPT =
  'You maintain a short running digest of key ideas for one ongoing conversation, so its important context ' +
  'survives even after the raw messages it came from are no longer sent to you. Always answer by calling ' +
  'distill_chat_memory, with an empty entries array if nothing needs to change.';

export interface ChatMemoryEntryDraft {
  topicKey: string;
  content: string;
}

const distillChatMemoryTool: ToolDefinition = {
  name: 'distill_chat_memory',
  description:
    'Propose new or updated key-idea entries for this chat, based on what just happened. Only include entries that ' +
    'are genuinely new or need a change — omit anything already covered and unaffected.',
  parameters: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            topic_key: {
              type: 'string',
              description:
                'A short, stable snake_case key. Reuse an existing one exactly when this is a continuation of the ' +
                'same idea; invent a new one only for a genuinely new topic.',
            },
            content: { type: 'string', description: '1-3 sentences capturing the current state of this idea.' },
          },
          required: ['topic_key', 'content'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
};

interface DistillResponse {
  entries: { topic_key: string; content: string }[];
}

function isDistillResponse(value: unknown): value is DistillResponse {
  if (typeof value !== 'object' || value === null) return false;
  const entries = (value as Record<string, unknown>).entries;
  if (!Array.isArray(entries)) return false;
  return entries.every(
    (e) =>
      typeof e === 'object' &&
      e !== null &&
      typeof (e as Record<string, unknown>).topic_key === 'string' &&
      typeof (e as Record<string, unknown>).content === 'string',
  );
}

export async function distillChatMemory(
  llm: LlmProvider,
  existingEntries: ChatMemoryEntryDraft[],
  newChunkSummaries: string[],
  promptOverride?: string,
): Promise<ChatMemoryEntryDraft[]> {
  const existingList = existingEntries.length
    ? existingEntries.map((e) => `- [${e.topicKey}] ${e.content}`).join('\n')
    : '(none yet)';
  const newList = newChunkSummaries.map((s, i) => `${i + 1}. ${s}`).join('\n');

  const turn = await llm.complete(
    [
      {
        role: 'system',
        content: `${promptOverride || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT}\n\nCurrent entries:\n${existingList}`,
      },
      { role: 'user', content: `What just happened (newly archived, in order):\n${newList}` },
    ],
    [distillChatMemoryTool],
    { forceTool: 'distill_chat_memory' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'distill_chat_memory');
  if (!call) {
    throw new Error('distillChatMemory: model did not call distill_chat_memory despite forceTool');
  }
  if (!isDistillResponse(call.arguments)) {
    throw new Error(`distillChatMemory: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments.entries.map((e) => ({ topicKey: e.topic_key, content: e.content }));
}
