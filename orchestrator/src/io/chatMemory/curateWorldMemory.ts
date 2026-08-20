/**
 * @file orchestrator/src/io/chatMemory/curateWorldMemory.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call
 * @description
 * The 'rp'-kind sync lane's periodic place/thing/concept curator: reviews the sync window's
 * transcript against every existing approved entry in those three categories and proposes targeted
 * UPDATEs, NEWs, and duplicate flags — ported near-verbatim from SillyTavern-Canonize's own
 * hand-tuned lorebookSyncPrompt (stacks/sillytavern/st-data/default-user/settings.json,
 * extension_settings.cnz.activeState.lorebookSyncPrompt), same "preserve exact wording" direction
 * as bridgeChatMemory.ts's own port.
 *
 * Two adaptations from the CNZ source, both intentional:
 *  - The "Keys:" keyword-list instruction (and the #person mistagged-entry-correction carve-out,
 *    which only exists to serve ST's keyword lorebook activation) is dropped entirely. docs/spec.md
 *    states BI's vector recall (recall_canon_facts) replaces keyword lorebooks outright — there is
 *    no keyword-match fallback anywhere in this schema, so generating keys nobody ever reads would
 *    just waste the model's output budget. CNZ's own #person-tag-correction carve-out is dropped
 *    with it: BI's lorebookSyncPrompt is never even shown person entries (curatePeople.ts owns that
 *    category start to finish), so there is nothing for this curator to mistag.
 *  - The raw-markdown "### OUTPUT FORMAT" section becomes this chunk's own plain-text OUTPUT FORMAT
 *    (docs/plans/chat-memory-world-curator-plan.md) instead of a forced tool call, matching the
 *    transport pattern Chunks 1–2 already set for the classifier and the bridge: ordinary text
 *    completion out, strict local parse back into the existing draft shape. CNZ's own
 *    `**dup** — duplicate of [Primary Name]` free-text convention becomes a first-class
 *    'duplicate' action with a duplicate_of field — same information, structured instead of parsed
 *    back out of prose. The prompt's behavioural rules (durability, logistics, entity resolution,
 *    duplicate detection, hard-data tracking, rejection criteria, conservative inclusion) are
 *    preserved verbatim — only the output contract changed.
 *
 * Never creates or rewrites a 'person' entry — curatePeople.ts owns that category exclusively, same
 * split CNZ itself enforces via its own two dedicated prompts.
 *
 * @api-declaration
 * DEFAULT_WORLD_MEMORY_CURATOR_PROMPT
 * WorldMemoryCuratorEntryDraft
 * curateWorldMemory(llm, transcript, existingEntries, promptOverride?)
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider } from '../llm/types.js';
import { parseWorldMemoryOutput } from './parseWorldMemoryOutput.js';

export const DEFAULT_WORLD_MEMORY_CURATOR_PROMPT = `**[SYSTEM: TASK — LOREBOOK CURATOR]**
You are reviewing a session transcript and the current lorebook entries for a character.
Your job is to suggest targeted updates to existing entries and identify new concepts that warrant a lorebook entry. A lorebook entry should be free of narrative and temporal association. It is the description of a place, thing, or concept that is unique to this world — what it looks like, how it works, its place in the world.

**[LOGISTICAL PERSISTENCE]**
While entries should describe the nature of an entity, they must also track its current operational state. If the transcript reveals a significant change in where something is located, who possesses a key item, or the current condition of a place, update the entry to reflect that truth. Treat the lorebook as a live save-file for the world's logistics, not just a static encyclopedia.

IMPORTANT — CATEGORIES:
Every entry belongs to exactly one of three categories:
  place    — a location, region, building, or geographic feature
  thing    — an object, item, creature, or material
  concept  — a faction, organisation, system, phenomenon, or recurring idea

Assign the most accurate category to every entry you touch. If an existing entry carries the wrong category, correct it.

Person entries are handled exclusively by a dedicated people curator — never propose a new or updated entry for a named person here. If someone appears in the transcript who has no lorebook entry, skip them entirely.

CURRENT LOREBOOK ENTRIES:
{{lorebook_entries}}

SESSION TRANSCRIPT:
{{transcript}}

INSTRUCTIONS:
- For each existing entry whose information is now stale, incomplete, or contradicted by the transcript, propose an update.
- For each new place, thing, or concept introduced in the transcript that does NOT already have an entry, propose a new entry.
- **Entity Resolution:** Do not create new entries for synonyms or sub-components of existing entries. If "The Pavilion" is mentioned and "The Wandering Pavilion" already exists, update the original.
- **Duplicate Flagging:** If two existing entries clearly cover the same concept under different names, merge their content into the better-named entry via a normal update, then flag the redundant entry as a duplicate of the primary one so it can be manually removed.
- **State Tracking:** Explicitly include and update specific "Hard Data" within entries: named locations, exact quantities of significant resources, and the current holder or whereabouts of key items or artifacts.
- **[REJECTION CRITERIA]:**
    - The lorebook is for terms unique to this world. Reject anything that could exist unchanged in the real world (e.g. common food, plants, animals, materials, weather) unless it has a unique name, property, or role in this setting.
    - **Reject "Conversational Noise":** Ignore one-off jokes, slang, idioms, or metaphors with no durable story significance.
    - **Reject "Narrative Flourish":** If a concept is used only once to convey a mood or temporary feeling, do not index it.
- When in doubt, exclude rather than include.
- Keep entries concise (3–6 sentences). Write in third-person present tense.
- If no changes are needed, propose no entries at all.

OUTPUT FORMAT — follow exactly.

For an existing entry that needs changing:

**UPDATE: [Exact Existing Entry Name]**
Category: place
[Full replacement content, 3–6 sentences.]

For a new entry:

**NEW: [New Entry Name]**
Category: concept
[Full entry content, 3–6 sentences.]

For an existing redundant entry:

**DUPLICATE: [Exact Redundant Entry Name]**
Duplicate of: [Exact Primary Entry Name]

If nothing needs changing, output exactly:

NO CHANGES NEEDED

Allowed categories are only:
place
thing
concept`;

export interface WorldMemoryCuratorEntryDraft {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  category?: 'place' | 'thing' | 'concept';
  content?: string;
  duplicateOf?: string;
}

export async function curateWorldMemory(
  llm: LlmProvider,
  transcript: string,
  existingEntries: string,
  promptOverride?: string,
): Promise<WorldMemoryCuratorEntryDraft[]> {
  const instructions = promptOverride || DEFAULT_WORLD_MEMORY_CURATOR_PROMPT;

  const userMessage =
    `CURRENT LOREBOOK ENTRIES:\n${existingEntries || '(none yet)'}\n\n` +
    `SESSION TRANSCRIPT:\n${transcript}\n\n`;

  const turn = await llm.complete(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage },
    ],
    [],
  );

  return parseWorldMemoryOutput(turn.message.content);
}
