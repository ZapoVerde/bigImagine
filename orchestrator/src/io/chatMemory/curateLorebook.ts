/**
 * @file orchestrator/src/io/chatMemory/curateLorebook.ts
 * @stamp 2026-08-07
 * @architectural-role IO Wrapper — forced-schema LLM call
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
 *  - The raw-markdown "### OUTPUT FORMAT" section is replaced by a forced tool call
 *    (curate_lorebook), same structural swap bridgeChatMemory.ts already made for its own three
 *    parts. CNZ's own `**dup** — duplicate of [Primary Name]` free-text convention becomes a
 *    first-class 'duplicate' action with a duplicate_of field — same information, structured
 *    instead of parsed back out of prose.
 *
 * Never creates or rewrites a 'person' entry — curatePeople.ts owns that category exclusively, same
 * split CNZ itself enforces via its own two dedicated prompts.
 *
 * @api-declaration
 * DEFAULT_LOREBOOK_CURATOR_PROMPT
 * LorebookCuratorEntryDraft
 * curateLorebook(llm, transcript, existingEntries, promptOverride?)
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '../llm/types.js';

export const DEFAULT_LOREBOOK_CURATOR_PROMPT = `**[SYSTEM: TASK — LOREBOOK CURATOR]**
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
- If no changes are needed, propose no entries at all.`;

const curateLorebookTool: ToolDefinition = {
  name: 'curate_lorebook',
  description:
    "Record this sync window's place/thing/concept lorebook updates, new entries, and duplicate flags, per the curator task above. " +
    'entries is empty when nothing in the transcript warrants a change.',
  parameters: {
    type: 'object',
    properties: {
      entries: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['update', 'new', 'duplicate'],
              description:
                "'update' rewrites an existing entry's full content, 'new' creates one, 'duplicate' flags this entry as redundant with another (existing) entry.",
            },
            name: {
              type: 'string',
              description:
                'For update/duplicate: the exact existing entry name to match. For new: the entry name to create.',
            },
            category: {
              type: 'string',
              enum: ['place', 'thing', 'concept'],
              description: "The entry's category. Required for 'update'/'new'; omit for 'duplicate'.",
            },
            content: {
              type: 'string',
              description: "Full replacement or new content, 3-6 sentences, third-person present tense. Required for 'update'/'new'; omit for 'duplicate'.",
            },
            duplicate_of: {
              type: 'string',
              description: "For 'duplicate' only: the exact name of the primary entry this one duplicates.",
            },
          },
          required: ['action', 'name'],
          additionalProperties: false,
        },
      },
    },
    required: ['entries'],
    additionalProperties: false,
  },
};

export interface LorebookCuratorEntryDraft {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  category?: 'place' | 'thing' | 'concept';
  content?: string;
  duplicateOf?: string;
}

interface LorebookCuratorToolResponse {
  entries: {
    action: 'update' | 'new' | 'duplicate';
    name: string;
    category?: 'place' | 'thing' | 'concept';
    content?: string;
    duplicate_of?: string;
  }[];
}

function isLorebookCuratorResponse(value: unknown): value is LorebookCuratorToolResponse {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.entries)) return false;
  return v.entries.every((e) => {
    if (typeof e !== 'object' || e === null) return false;
    const entry = e as Record<string, unknown>;
    if (typeof entry.name !== 'string') return false;
    if (entry.action !== 'update' && entry.action !== 'new' && entry.action !== 'duplicate') return false;
    return true;
  });
}

export async function curateLorebook(
  llm: LlmProvider,
  transcript: string,
  existingEntries: string,
  promptOverride?: string,
): Promise<LorebookCuratorEntryDraft[]> {
  const instructions = promptOverride || DEFAULT_LOREBOOK_CURATOR_PROMPT;

  const userMessage =
    `CURRENT LOREBOOK ENTRIES:\n${existingEntries || '(none yet)'}\n\n` +
    `SESSION TRANSCRIPT:\n${transcript}\n\n` +
    'Answer by calling curate_lorebook with any updates, new entries, and duplicate flags.';

  const turn = await llm.complete(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage },
    ],
    [curateLorebookTool],
    { forceTool: 'curate_lorebook' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'curate_lorebook');
  if (!call) {
    throw new Error('curateLorebook: model did not call curate_lorebook despite forceTool');
  }
  if (!isLorebookCuratorResponse(call.arguments)) {
    throw new Error(`curateLorebook: model's call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments.entries.map((e) => ({
    action: e.action,
    name: e.name,
    category: e.category,
    content: e.content,
    duplicateOf: e.duplicate_of,
  }));
}
