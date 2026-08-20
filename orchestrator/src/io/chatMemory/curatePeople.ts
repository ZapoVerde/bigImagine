/**
 * @file orchestrator/src/io/chatMemory/curatePeople.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call
 * @description
 * The 'rp'-kind sync lane's periodic person curator: maintains living, seven-section records for
 * every named person against the sync window's transcript — ported near-verbatim from
 * SillyTavern-Canonize's own hand-tuned peopleSyncPrompt (stacks/sillytavern/st-data/default-user/
 * settings.json, extension_settings.cnz.activeState.peopleSyncPrompt), same "preserve exact
 * wording" direction as bridgeChatMemory.ts's own port. The sole category this curator ever writes
 * is 'person' — curateWorldMemory.ts explicitly refuses to touch it, same split CNZ enforces via its
 * own two dedicated prompts.
 *
 * Three adaptations from the CNZ source, all intentional and all matching the transport the
 * earlier chat-memory chunks set (classifier, bridge, world curator):
 *  - The "Keys:" keyword-list instruction is dropped — docs/spec.md's vector recall replaces
 *    keyword-lorebook matching outright, so there is nothing that would ever read a generated key.
 *  - The raw-markdown "### OUTPUT FORMAT" section becomes this chunk's own plain-text OUTPUT FORMAT
 *    (docs/plans/chat-memory-people-curator-plan.md) instead of a forced tool call: ordinary text
 *    completion out, strict local parse (parsePeopleMemoryOutput.ts) back into the existing
 *    PeopleCuratorEntryDraft shape. The model emits the natural person card it already understands —
 *    ## Appearance as its own card section, Personality/Core Misread free-text prose — and the
 *    parser deterministically carves ## Appearance back out into BI's dedicated `appearance` field.
 *    Nothing else splits: the remaining five sections stay one markdown `content` block, exactly as
 *    CNZ's own card shows them, because nothing downstream needs Personality or Goals in isolation
 *    the way Portrait Studio needs Appearance (its section rule comes from the shared
 *    APPEARANCE_SECTION_RULE constant, personCuratorAppearance.ts, so this curator and the
 *    mint-time describer describeCharacter.ts can never drift apart). CNZ's own
 *    `**dup** — duplicate of [Primary Name]` free-text convention becomes a first-class
 *    'duplicate' action with a duplicate_of field, same structural swap curateWorldMemory.ts makes.
 *
 * {{user}} is resolved via util/interpolateMacros.ts (the household's persona_name), same live-macro
 * shape bridgeChatMemory.ts already uses — kept literal in the ported prompt text below. The
 * relationship heading therefore reaches the model as `## Relationship with {{user}}` and may come
 * back as `## Relationship with <resolved name>`; the parser recognizes it structurally, not by the
 * user's actual name.
 *
 * @api-declaration
 * DEFAULT_PEOPLE_CURATOR_PROMPT
 * PeopleCuratorEntryDraft
 * curatePeople(llm, transcript, existingEntries, userName, promptOverride?)
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider } from '../llm/types.js';
import { interpolateMacros } from '../../util/interpolateMacros.js';
import { APPEARANCE_SECTION_RULE } from '../../orchestrator/personCuratorAppearance.js';
import { parsePeopleMemoryOutput } from './parsePeopleMemoryOutput.js';

export const DEFAULT_PEOPLE_CURATOR_PROMPT = `**[SYSTEM: TASK — PEOPLE CURATOR]**
You will receive a transcript of recent story events and the current person entries for this story. The primary character is {{user}}.
Your job is to maintain accurate, living records of every named person. Each card has seven sections: Appearance, Personality, Core Misread, Connections, Relationship with {{user}}, and Goals. Propose a NEW or UPDATE for each card that requires action.

If a card is missing any section — Appearance, Personality, Core Misread, Connections, Relationship with {{user}}, or Goals — add all missing sections in full as part of its UPDATE.

---

SECTION RULES:

${APPEARANCE_SECTION_RULE}

## Personality — set once at creation.
Choose 3–5 axes genuinely revealing of this specific character. Format:
  [Quality A] ↔ [Quality B]: one sentence on where they sit and why it matters.
  Reproduce exactly in every UPDATE — do not alter, rephrase, or reorder.

## Core Misread — set once at creation.
A deeper misunderstanding that sits at the center of this character's worldview, self-image, or understanding of another person. It is the thing this character keeps getting wrong even when presented with evidence. Write 1–2 sentences.
  Reproduce exactly in every UPDATE — do not alter, rephrase, or reorder.

## Connections — a reference table of this character's direct relationships to other named characters. Omit {{user}} — that axis lives in ## Relationship with {{user}}.

  | Person | Relation | Tone |
  |--------|----------|------|
  | [Two Word Name] | [structural role] | [one word] |

  Person: the exact two-word card name of the connected character. Only include characters with an existing lorebook entry.
  Relation: structural or role relationship, up to three words (grandfather, employer, daughter, rival, father-in-law). Set at creation; update only if the structural fact changes (marriage, death, formal role change).
  Tone: one word describing the current emotional or political quality of the connection. Not a bounded list — choose any single word that is accurate. One word only, no hyphens, no qualifiers. Update when the dynamic meaningfully shifts.

  Add rows as new connections form. If a relationship ends or sours, update Tone — do not remove the row.
  In every UPDATE: reproduce all existing rows exactly; only change Tone values that have meaningfully shifted.

## Relationship with {{user}} — the live state section. Continuous prose.

  Convert events into persistent conditions. This section is not a record of what happened — it is a compression of those events into what remains true after the scene ends.

  Cover: emotional posture toward {{user}}, power balance, any active leverage or asymmetry, and direction of movement. Write 2–4 sentences.

  Persistence test: if a sentence would stop being true once the immediate scene ends, cut it.

  When an event is relevant, express its ongoing consequence instead:
  "She covered for him" → "She is now implicitly aligned with him, carrying shared risk if the truth surfaces."

  Exclude: event narration, references to specific past exchanges, time-based phrasing ("recently", "last time", "since their last meeting"), and scheduled or future actions.

## Goals — one major goal and exactly three minor goals.

  The major goal is this character's own long-term ambition — something that would remain meaningful if {{user}} were removed from the story entirely. It is slow-moving and changes only when something fundamental shifts in the character's situation.

  Minor goals are the character's immediate personal intentions. They may brush against {{user}}'s story at the edges, but they exist because this character has a life of their own.

  If goals are not yet established in the transcript, invent plausible ones consistent with the character's personality and situation.

---

NAMING CONVENTION:
Every entry name is exactly two words. No parenthetical qualifiers — ever.

  Full name known:     Firstname Lastname       → Elara Mornwood, Thomas Harwick
  Title + first name:  Title Firstname          → Queen Elara, Lady Harwick, Guard Renn
  Single name only:    Role Firstname           → Maid Rose, Smith Alvin

No two entries may share the same two-word name. Name is set at creation and never changed.

---

CURRENT PERSON ENTRIES:
{{lorebook_entries}}

TRANSCRIPT:
{{transcript}}

---

INSTRUCTIONS:
Work through these steps internally before writing any output:
1. Identify every named person in the transcript.
2. For each: locate any matching existing entry. A match exists when the person's name appears as either word in an existing entry's two-word name. Check every entry.
3. For existing entries: assess whether Connections Tone, Relationship with {{user}}, or Goals have meaningfully shifted.
4. For new persons: create a full treatment entry, inventing any details not established in the transcript.
5. Propose entries only for cards requiring action.

Rules:
- Never create an entry for {{user}}.
- Before proposing a NEW entry, confirm no existing entry covers this person. If a match exists, propose an UPDATE instead.
- New entry names: exactly two words, no parentheticals.
- **Duplicate Flagging:** If two existing entries clearly cover the same person, merge content into the primary via UPDATE, then flag the redundant entry as a duplicate of the primary one.
- Only update on clear, meaningful change — do not issue micro-adjustments or speculative updates.
- Reproduce ## Appearance, ## Personality, ## Core Misread exactly. Never alter them.
- Write in third-person present tense.
- If no changes are needed, propose no entries at all.

OUTPUT FORMAT — follow exactly.

For a new person:

**NEW: [Two Word Name]**

## Appearance
[Physical appearance treatment.]

## Personality
[Existing required format.]

## Core Misread
[Existing required format.]

## Connections
| Person | Relation | Tone |
|--------|----------|------|
...

## Relationship with {{user}}
[Persistent relationship state.]

## Goals
Major: ...
Minor: ...
Minor: ...
Minor: ...

For an existing person that needs changing:

**UPDATE: [Exact Existing Two Word Name]**

## Appearance
[Reproduce exactly.]

## Personality
[Reproduce exactly.]

## Core Misread
[Reproduce exactly.]

## Connections
...

## Relationship with {{user}}
...

## Goals
...

For a redundant person entry:

**DUPLICATE: [Exact Redundant Two Word Name]**
Duplicate of: [Exact Primary Two Word Name]

If nothing needs changing, output exactly:

NO CHANGES NEEDED`;

export interface PeopleCuratorEntryDraft {
  action: 'update' | 'new' | 'duplicate';
  name: string;
  content?: string;
  appearance?: string;
  duplicateOf?: string;
}

export async function curatePeople(
  llm: LlmProvider,
  transcript: string,
  existingEntries: string,
  userName: string | undefined,
  promptOverride?: string,
): Promise<PeopleCuratorEntryDraft[]> {
  const resolvedUserName = userName && userName.trim() ? userName : 'the protagonist';
  const instructions = interpolateMacros(promptOverride || DEFAULT_PEOPLE_CURATOR_PROMPT, { userName: resolvedUserName });

  const userMessage =
    `CURRENT PERSON ENTRIES:\n${existingEntries || '(none yet)'}\n\n` +
    `TRANSCRIPT:\n${transcript}\n\n`;

  const turn = await llm.complete(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage },
    ],
    [],
  );

  return parsePeopleMemoryOutput(turn.message.content);
}
