/**
 * @file orchestrator/src/io/chatMemory/classifyHouseholdMemory.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call with local parsing
 * @description Makes the archive-only cross-chat persistence judgment for household_memory.
 * The input remains the complete chat digest plus live tail; most chats correctly produce no memory.
 * @api-declaration DEFAULT_HOUSEHOLD_MEMORY_PROMPT; classifyHouseholdMemory(llm, chatSummary, promptOverride?)
 * @contract purity: impure (LLM); state_ownership: []; external_io: [LLM]
 */

import type { LlmProvider } from '../llm/types.js';
import { parseHouseholdMemoryOutput } from './parseHouseholdMemoryOutput.js';

export const DEFAULT_HOUSEHOLD_MEMORY_PROMPT = `**[SYSTEM: TASK — HOUSEHOLD MEMORY CLASSIFIER]**
This conversation has ended.

Decide whether anything established in it is worth remembering beyond this one chat and recalling in future, unrelated conversations.

Keep only durable information about the user or household, such as:
- standing preferences
- stable personal or household facts
- explicit corrections to previously held information
- recurring constraints or circumstances
- durable decisions that will remain relevant outside this conversation

Reject:
- facts that matter only to this specific conversation
- temporary plans, tasks, or current-session state
- narrative or roleplay events
- generic world knowledge
- things that can be inferred again easily
- conversational filler
- duplicated statements of the same underlying fact

Each retained memory must:
- be one durable fact or preference
- be self-contained and understandable with no surrounding chat
- state what remains true, not narrate how it was learned
- preserve concrete names/details when necessary for future recall

Most conversations should produce no household memory.

OUTPUT FORMAT — follow exactly:
- [one durable self-contained memory]
- [another durable self-contained memory]

If nothing qualifies, output exactly:
NO MEMORIES`;

export async function classifyHouseholdMemory(llm: LlmProvider, chatSummary: string, promptOverride?: string): Promise<string[]> {
  const turn = await llm.complete(
    [
      { role: 'system', content: promptOverride || DEFAULT_HOUSEHOLD_MEMORY_PROMPT },
      { role: 'user', content: chatSummary },
    ],
    [],
  );
  return parseHouseholdMemoryOutput(turn.message.content);
}
