/**
 * @file orchestrator/src/io/chatMemory/distillChatMemory.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call with local parsing
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
 * Transport follows the same migration every sibling caller (bridgeChatMemory.ts,
 * curateWorldMemory.ts, curatePeople.ts) already landed (chat-memory-structured-output-plan.md):
 * the forced `distill_chat_memory` tool call is gone, replaced by an ordinary text completion
 * whose OUTPUT FORMAT is a sequence of `[topic_key]` blocks plus the exact `NO CHANGES NEEDED`
 * sentinel, parsed locally by parseDistillMemoryOutput.ts back into the same ChatMemoryEntryDraft
 * shape — so nothing downstream (chatMemorySync.ts's upsert_entries step) changes. The behavioral
 * contract that used to live partly in the tool schema (only new/changed entries, reuse keys
 * exactly, 1-3 sentences, empty result valid) now lives entirely in the default prompt.
 *
 * @api-declaration
 * DEFAULT_DISTILL_CHAT_MEMORY_PROMPT
 * ChatMemoryEntryDraft
 * distillChatMemory(llm, existingEntries, newChunkSummaries, promptOverride?) — throws only on a
 *   malformed response; returns [] when nothing needs to change
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider } from '../llm/types.js';
import { parseDistillMemoryOutput } from './parseDistillMemoryOutput.js';

export const DEFAULT_DISTILL_CHAT_MEMORY_PROMPT = `**[SYSTEM: TASK — CHAT MEMORY DISTILLER]**
You maintain the persistent key-idea digest for one ongoing conversation.

You will receive:
- CURRENT ENTRIES: the key ideas already stored for this conversation
- NEWLY ARCHIVED MEMORY: summaries of the latest conversation chunks

Your job is to return only the entries that are new or whose current state has meaningfully changed.

Rules:
- Reuse an existing topic key exactly when the new material continues or changes the same underlying idea.
- Create a new topic key only when the new material introduces a genuinely distinct idea worth retaining.
- Do not restate entries that remain accurate and unchanged.
- Do not delete or retire entries. Anything you omit remains stored unchanged.
- Each entry should describe the current state of that idea, not narrate the sequence of turns that produced it.
- Preserve concrete names, decisions, commitments, constraints, corrections, preferences, and unresolved matters that will matter later.
- Exclude conversational filler, transient phrasing, repeated information, and details with no likely future value.
- Write each entry in 1–3 concise sentences.
- Topic keys must be short, stable, lowercase snake_case identifiers.

OUTPUT FORMAT — follow exactly:

[topic_key]
Current state of this idea in 1–3 sentences.

[another_topic_key]
Current state of this idea in 1–3 sentences.

If nothing is new or meaningfully changed, output exactly:

NO CHANGES NEEDED`;

export interface ChatMemoryEntryDraft {
  topicKey: string;
  content: string;
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
      { role: 'system', content: promptOverride || DEFAULT_DISTILL_CHAT_MEMORY_PROMPT },
      {
        role: 'user',
        content: `CURRENT ENTRIES:\n${existingList}\n\nNEWLY ARCHIVED MEMORY:\n${newList}`,
      },
    ],
    [],
  );

  return parseDistillMemoryOutput(turn.message.content);
}
