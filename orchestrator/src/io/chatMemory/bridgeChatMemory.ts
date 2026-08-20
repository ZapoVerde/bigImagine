/**
 * @file orchestrator/src/io/chatMemory/bridgeChatMemory.ts
 * @stamp 2026-08-20
 * @architectural-role IO Wrapper — plain-text LLM call with local parsing
 * @description
 * The 'rp'-kind sync lane's hookseeker-parity bridge: maintains an evolving SCENE (present-tense
 * prose, carried forward and revised, never reset), an EVENTS text block (upcoming confirmed
 * scheduled events), and arc-tagged PLOT entries — ported near-verbatim from
 * SillyTavern-Canonize's own hand-tuned hookseekerPrompt (stacks/sillytavern/st-data/default-user/
 * settings.json, extension_settings.cnz.activeState.hookseekerPrompt) per the user's explicit
 * direction to preserve exact wording/shape rather than re-paraphrase it — years of tuning in CNZ
 * eventually let it "ride between syncs without adjustment," and that property is the whole point
 * of this port.
 *
 * Reads the RAW transcript of the sync window plus this chat's own PREVIOUS bridge output (SCENE+
 * EVENTS combined, exactly as CNZ's own "PREVIOUS OUTPUT" placeholder works) every tick — never a
 * summary-of-summary the way distillChatMemory.ts's household lane does. SCENE/EVENTS are plain
 * text (stored as chat_memory_entries rows, topic_key 'scene'/'events') — a structured EVENTS
 * table is deferred per the user's explicit "nearly free, do it later" call. PLOT entries become
 * proposed canon_facts rows (category='plot', status='proposed'); chatMemorySync.ts's existing
 * promote_canon_facts step (0058_canon_facts_chat_scoped.sql) is what gives them the same one-tick
 * settling window as every other canon fact, with zero special-casing needed here.
 *
 * {{user}} is resolved via util/interpolateMacros.ts (the household's persona_name) — the same
 * live-macro shape CNZ's own {{user}} resolves against — kept literal in the ported prompt text
 * below rather than rewritten, since BI already has the equivalent macro. CNZ's own {{transcript}}/
 * {{prev_scene}}/{{#if existing_threads}} placeholders are resolved by this wrapper building the
 * user message directly (mirroring what CNZ's own client-side interpolate() does before the prompt
 * ever reaches an LLM — the model itself never saw literal Handlebars tokens there either), and the
 * user message's tail carries Canonize's own literal "OUTPUT FORMAT" block (EVENTS table, SCENE
 * prose, `**NEW:` plot entries with arc tags) — the raw-text convention the old forced
 * `bridge_chat_memory` tool call replaced. That restoration (plus local parsing via
 * parseBridgeOutput.ts) is the only adaptation; everything upstream of it in DEFAULT_BRIDGE_PROMPT
 * is verbatim. The forced-tool transport is gone because it tied sync's reliability to whichever
 * model/route is active (chat-memory-structured-output-plan.md): plain text extraction works across
 * every connection the household connects, including ones that reject or mishandle forced
 * tool_choice.
 *
 * @api-declaration
 * DEFAULT_BRIDGE_PROMPT
 * BridgePlotEntryDraft, BridgeResult
 * bridgeChatMemory(llm, transcript, previousOutput, existingThreads, userName, promptOverride?)
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider } from '../llm/types.js';
import { interpolateMacros } from '../../util/interpolateMacros.js';
import { parseBridgeOutput } from './parseBridgeOutput.js';

export const DEFAULT_BRIDGE_PROMPT = `**[SYSTEM: TASK — NARRATIVE CHRONICLER]**

You are a Narrative Chronicler maintaining a living record of an ongoing story. Your output has exactly three parts: an EVENTS block, a SCENE block, and plot entries.

---

**PART 1 — EVENTS**

Maintain a table of upcoming confirmed scheduled events. Read the current table from PREVIOUS OUTPUT below.

Insert any event confirmed at a specific time or day in the transcript — not merely proposed or discussed as a possibility.
Remove any event whose timeframe has passed, or that the transcript shows has already occurred.

Output the full table every time, even if unchanged. If there are no upcoming events, output the header with no rows.

| When | What | Who |
|------|------|-----|
| [specific or relative time] | [one or two sentences] | [who is involved] |

Order rows by When, soonest first.

---

**PART 2 — SCENE**

Write approximately 150–200 words beginning with SCENE: on its own line. Describe the current moment in flowing present tense — the physical situation, emotional atmosphere, sensory details, and active pressures. Use the full transcript for context: recent events should feel most vivid, but earlier events in the window should still colour the tone and stakes. Do not lose threads that remain alive; carry forward anything unresolved. Maintain strict continuity with the PREVIOUS SCENE in the previous output — do not reset it; evolve it naturally. Do not invent events, motivations, or outcomes not supported by the transcript.

---

**PART 3 — PLOT ENTRIES**

Create a NEW: entry only when at least one of the following occurs:
- A character's goal, motivation, or allegiance changes
- A major decision is made or a consequential action taken
- Important information is revealed — a secret exposed, a mystery deepened or resolved
- A threat escalates or resolves
- An alliance or relationship dynamic shifts
- A lasting consequence takes hold
- A new narrative thread begins

Do not restate previously recorded developments unless the situation has materially changed. "The siege continues" is not an entry. "The siege wall breached" is. Extend existing threads through tags rather than creating duplicate entries with slightly different names.

One entry per arc per review window. If multiple developments occurred within the same arc, capture them together in a single entry rather than splitting across cards.

Rules:
- **Entry name:** A vivid label for this arc's progression in this window (e.g. "The Ashford Siege Breaks Open", "Elena's Allegiance Fractures").
- **Content:** 2–4 sentences in past tense covering the arc's developments this window. What happened, why it matters, what tension or possibility it creates. Only create an entry when the narrative state has clearly shifted — not when it is merely developing or being explored.
- **Tag:** End every entry with exactly one arc tag. Entries are not cross-tagged.

  Arcs come in two kinds:
  — A character arc tracks one person's moves, position, and decisions within a specific objective or situation. Tag by actor and objective: #clara_seat, #sophie_seat, #sue_seat. Never include {{user}} in a tag — the protagonist is present in everything and adds no information.
  — A situation arc tracks the state of a shared situation, conflict, or evolving dynamic involving multiple characters. Tag by situation: #foundation_contest. One situation arc per conflict, regardless of how many characters are involved.

  When a development shifts one character's position, it belongs in their arc. When it shifts the state of the contest itself, it belongs in the situation arc. When a development affects both a character and a situation, record it in the character arc unless the primary effect is a change in the overall contest state. The same fact does not appear in both — character arcs contain what the actor did, decided, or revealed; situation arcs contain contest state only.

  Once a tag is established, reuse it exactly — even if the new development feels like a distinct phase. Favor continuity of an existing thread over a more precise or better-named new one. Only coin a new tag when a situation introduces stakes, participants, and objectives entirely unrelated to any existing arc.

If none of the above occurred, output only EVENTS and SCENE.`;

export interface BridgePlotEntryDraft {
  name: string;
  content: string;
  arcTag: string;
}

export interface BridgeResult {
  events: string;
  scene: string;
  plotEntries: BridgePlotEntryDraft[];
  /** The fully-rendered prompt this sync actually sent the model — the interpolated system
   *  instructions plus the built user message (transcript + PREVIOUS OUTPUT + running threads).
   *  Persisted onto the sync point (db/migrations/0079_sync_inspection.sql) so the sync-status
   *  panel can play the prompt back; exact reconstruction after the fact is impossible because
   *  previous output / running threads have since moved on. */
  prompt: string;
}

export async function bridgeChatMemory(
  llm: LlmProvider,
  transcript: string,
  previousOutput: string,
  existingThreads: string,
  userName: string | undefined,
  promptOverride?: string,
): Promise<BridgeResult> {
  const resolvedUserName = userName && userName.trim() ? userName : 'the protagonist';
  const instructions = interpolateMacros(promptOverride || DEFAULT_BRIDGE_PROMPT, { userName: resolvedUserName });

  const threadsBlock = existingThreads ? `Currently running plots:\n${existingThreads}\n\n` : '';
  const userMessage =
    `TRANSCRIPT:\n${transcript}\n\n` +
    `PREVIOUS OUTPUT:\n${previousOutput || '(none yet)'}\n\n` +
    threadsBlock +
    `OUTPUT FORMAT — follow exactly:

EVENTS:
| When | What | Who |
|------|------|-----|
| [when] | [what] | [who] |

SCENE:
[approximately 150–200 words of present-tense prose]

**NEW: [Entry Name]**
[2–4 sentences in past tense.]
#thread_tag`;

  const prompt = `${instructions}\n\n${userMessage}`;

  const turn = await llm.complete(
    [
      { role: 'system', content: instructions },
      { role: 'user', content: userMessage },
    ],
    [],
  );

  const parsed = parseBridgeOutput(turn.message.content);
  return {
    events: parsed.events,
    scene: parsed.scene,
    plotEntries: parsed.plotEntries,
    prompt,
  };
}
