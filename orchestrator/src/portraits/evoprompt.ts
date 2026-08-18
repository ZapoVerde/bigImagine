/**
 * @file orchestrator/src/portraits/evoprompt.ts
 * @stamp 2026-08-17
 * @architectural-role Pure Function — mutation prompt/marker-text construction + candidate
 *   response parsing (bi_principles.md §8)
 * @description
 * Builds the mutation call for a Portrait Studio generation round (plan §Generation round step 3)
 * and parses the model's candidate response back into chromosomes. The mutation call carries the
 * goal, any pending human feedback from the last episode, the current candidate's parent slots,
 * the Path-1 wiki entries, and `formatLayerDefinitions()`'s boundary prose for every layer, and
 * asks for exactly `candidateCount` (the `visual_mutation_candidate_count` setting, default 3)
 * candidate chromosomes back as plain marker text — NOT a forced tool call.
 *
 * 2026-08-17: dropped `standing_instructions` from this call (and from visual_entities entirely,
 * migration 0114) — it never fed the compiled image prompt (compileTemplate only ever reads
 * `slots`) and duplicated the wiki's now-settled role as the durable per-entity/per-layer guidance
 * mechanism. The wiki is the one guidance channel now; there is no second, unsynced one.
 *
 * 2026-08-17: switched off forced-schema tool-calling (`propose_candidates`) after confirming
 * live that OpenRouter's routing filters out otherwise-healthy pinned providers entirely when a
 * request forces a named-function tool_choice (they 404 "No endpoints found" even though the
 * exact same pin succeeds with tools omitted or tool_choice left to "auto"), AND that providers
 * which do accept a forced call can still return truncated/malformed JSON arguments for a schema
 * this nested (N candidates × per-layer slot maps) — the state a small/quantized model is least
 * reliable at. Plain marker text sidesteps both failure modes at once, the same pattern
 * describeCharacter.ts/describeLocation.ts already use for their own structured extraction (user
 * direction 2026-08-17: "structured requests like our character description work better than
 * json shapes"). The output format:
 *
 *   ### Candidate 1
 *   [layerId]
 *   slotName: value
 *   slotName: value
 *   [anotherLayerId]
 *   slotName: value
 *   Negative: optional negative-prompt fragment
 *
 *   ### Candidate 2
 *   ...
 *
 * one `[layerId]` block per promptable layer, `slot: value` lines under it, and an optional
 * `Negative:` line per candidate. Line-based parsing tolerates a model that gets some lines wrong
 * without losing the whole candidate — the same per-field leniency describeCharacter.ts applies,
 * generalized to a repeated/nested shape.
 *
 * The system prompt follows the same "default + bespoke" shape as every prompt key on this
 * platform (bi_principles.md §17): `systemPromptOverride` empty → the built-in
 * DEFAULT_MUTATION_SYSTEM_PROMPT; non-empty → the override verbatim (the orchestrator resolves
 * `visual_mutation_system_prompt_override` before calling).
 *
 * Wiki lessons reach the mutation call two ways (2026-08-17, the wiki's three-path model — a:
 * entity-specific, b: whole-layer-type, c: tag-catch-all): (a)/(b) are `ctx.wikiEntries` —
 * wiki.ts's formatSubscribedEntries, full title+body (bounded by the caller via
 * formatBoundedSubscribedEntries before this file ever runs), already resolved by the caller
 * before this file ever runs. (c) is `ctx.unsubscribedWikiTagIndex` — wiki.ts's
 * formatUnsubscribedTagIndex, title+tags+id only, for every entry (a)/(b) did NOT already reach —
 * a lesson can be relevant to a round's goal without ever having been subscribed to this entity
 * or this layer, since the subscription model is structural, not semantic. PULL_WIKI_ENTRY_TOOL
 * is offered (never forced — `options.forceTool` unset, so the model may reply with plain
 * marker-text candidates directly in the same turn, the common case) only when that index is
 * non-empty; the caller (portraitGeneration.ts) is responsible for the resulting short pull loop
 * (fetch the entry, feed it back as a 'tool' message, re-call) before it ever hands a turn to
 * parseCandidateResponse. Not a forced named-function tool_choice, so this does not reintroduce
 * the OpenRouter routing failure the file header above describes — that was specific to forcing.
 *
 * parseCandidateResponse is the tolerant-but-loud inverse: it throws a descriptive error only
 * when the reply has no content at all or contains no `### Candidate N` block whatsoever: a
 * malformed *line* inside an otherwise-recognized block is skipped, never fatal — reconcile.ts's
 * enforceSlotKeys is still the strict layer-by-layer gate downstream, and never throws by
 * contract, so malformed content degrades to a parent-backfilled candidate rather than a dead
 * round (plan §Edge Cases).
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness.
 *
 * @api-declaration
 * MutationContext — goal, parentSlots, wikiEntries, unsubscribedWikiTagIndex, layerDefinitions,
 *   pendingFeedback?
 * DEFAULT_MUTATION_SYSTEM_PROMPT — the built-in system prompt (override-empty fallback)
 * PULL_WIKI_ENTRY_TOOL — the optional (never forced) tool definition for wiki path (c); the
 *   caller offers it only when ctx.unsubscribedWikiTagIndex is non-empty
 * parsePullWikiEntryId(call) -> string | undefined — pure; decodes a pull_wiki_entry call's id arg
 * buildMutationPrompt(ctx, candidateCount, systemPromptOverride?) -> { messages } — pure
 * parseCandidateResponse(turn) -> CandidateChromosome[] — pure; throws only when the reply has
 *   no content or no recognizable "### Candidate N" block
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmMessage, LlmTurn, ToolCall, ToolDefinition } from '../io/llm/types.js';
import type { SlotMap } from './composer.js';
import type { CandidateChromosome } from './reconcile.js';

export interface MutationContext {
  goal: string;
  /** The current candidate's per-layer slots — the parent each mutated candidate derives from. */
  parentSlots: SlotMap;
  /** Path-1 (a)/(b) subscribed wiki entries, pre-formatted by wiki.ts formatSubscribedEntries
   *  (empty string = none). */
  wikiEntries: string;
  /** Path-1(c) — wiki.ts formatUnsubscribedTagIndex: title+tags+id for entries (a)/(b) above
   *  did NOT already reach (empty string = none, or every entry already subscribed). Non-empty
   *  is what makes buildMutationPrompt offer PULL_WIKI_ENTRY_TOOL. */
  unsubscribedWikiTagIndex?: string;
  /** `formatLayerDefinitions()` output — boundary prose for every layer. */
  layerDefinitions: string;
  /** Human rationale/notes from the last episode, if any. */
  pendingFeedback?: string;
  /** A concluded reflection lesson the operator chose to drive this round with — the lesson
   *  statement + next change, injected as a hard requirement (docs/plans/portrait-studio-vision-
   *  review-harness-plan.md §API step 6). Undefined = an explicitly exploratory round. */
  guidingLesson?: string;
}

/** Wiki path (c)'s tool: fetch one entry's full title+body by the id shown in the
 *  "Other wiki entries" index, when it looks relevant to the round despite carrying no
 *  subscription to this entity or layer. Never forced (see file header) — the model may ignore
 *  it and answer with candidates directly. */
export const PULL_WIKI_ENTRY_TOOL: ToolDefinition = {
  name: 'pull_wiki_entry',
  description:
    'Fetch the full title and body of one wiki entry from the "Other wiki entries" index below, ' +
    'by its id, when it looks relevant to this round\'s goal despite not being directly linked here.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string', description: 'The entry id shown in the index.' } },
    required: ['id'],
    additionalProperties: false,
  },
};

/** Pure: decode a pull_wiki_entry call's id argument — adapters may hand back an object or a
 *  JSON string (the same tolerance portraitFeedback.ts's decodeArguments has). undefined on any
 *  undecodable/missing input; the caller treats that as "entry not found," never throws. */
export function parsePullWikiEntryId(call: ToolCall): string | undefined {
  let raw: unknown = call.arguments;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return undefined;
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const id = (raw as Record<string, unknown>).id;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

export const DEFAULT_MUTATION_SYSTEM_PROMPT =
  'You are the Portrait Studio mutation engine. You mutate a character portrait candidate into ' +
  'fresh candidate chromosomes for an image-generation provider. You are given the goal, the ' +
  'current candidate\'s per-layer slot values, lessons from a wiki of past evaluations, and each ' +
  'layer\'s boundary. Mutate deliberately: change some slots, keep others, always stay inside each ' +
  'layer\'s boundary and only use slot names that already exist in that layer.\n\n' +
  'Wiki lessons are hard requirements, not optional flavor: when a lesson says to avoid, remove, ' +
  'or change something, apply it now, even when that means editing the subject or outfit layer\'s ' +
  'identity or clothing text rather than only style or format. "Keep others unchanged" refers to ' +
  'slots the lessons do not call out — it is never a reason to leave the subject or outfit layer ' +
  'untouched candidate after candidate just because they are the most detailed layers to edit.\n\n' +
  'Respond in plain text ONLY, exactly in this format, one block per candidate and nothing else ' +
  '(no JSON, no commentary, no markdown code fences):\n\n' +
  '### Candidate 1\n' +
  '[layerId]\n' +
  'slotName: value\n' +
  'slotName: value\n' +
  '[anotherLayerId]\n' +
  'slotName: value\n' +
  'Negative: optional negative-prompt fragment for this candidate\n\n' +
  '### Candidate 2\n' +
  '...\n\n' +
  'Use the exact layer ids and slot names shown in "Current candidate" and "Layer boundaries" ' +
  'below — one [layerId] block per promptable layer, one "slotName: value" line per slot. Omit ' +
  'the Negative line entirely when a candidate has no negative fragment.';

function formatSlotsForPrompt(slots: SlotMap): string {
  const lines: string[] = [];
  for (const [layerId, layerSlots] of Object.entries(slots)) {
    const entries = Object.entries(layerSlots);
    if (entries.length === 0) {
      lines.push(`- ${layerId}: (no slots)`);
      continue;
    }
    lines.push(`- ${layerId}: ${entries.map(([k, v]) => `${k}: ${v}`).join(', ')}`);
  }
  return lines.join('\n');
}

/** Pure: the full mutation prompt — system (override or built-in) + the concrete user context.
 *  Tools are absent from the returned messages themselves (LlmMessage carries none) — the caller
 *  passes PULL_WIKI_ENTRY_TOOL to complete() directly, only when ctx.unsubscribedWikiTagIndex is
 *  non-empty; otherwise the model replies as plain marker text (see file header), parsed by
 *  parseCandidateResponse below. */
export function buildMutationPrompt(
  ctx: MutationContext,
  candidateCount: number,
  systemPromptOverride = '',
): { messages: LlmMessage[] } {
  const system = (systemPromptOverride ?? '').trim() || DEFAULT_MUTATION_SYSTEM_PROMPT;
  const feedback = ctx.pendingFeedback?.trim() ? `Feedback from the last round:\n${ctx.pendingFeedback}` : '';
  const unsubscribedIndex = ctx.unsubscribedWikiTagIndex?.trim() ?? '';
  const user = [
    `Goal: ${ctx.goal}`,
    feedback,
    'Current candidate:',
    formatSlotsForPrompt(ctx.parentSlots),
    'Wiki lessons:',
    ctx.wikiEntries.trim() ? ctx.wikiEntries : '(none)',
    ...(ctx.guidingLesson?.trim()
      ? ['Guiding lesson (from the last concluded reflection — treat as a hard requirement):', ctx.guidingLesson.trim()]
      : []),
    ...(unsubscribedIndex
      ? [
          'Other wiki entries (not directly linked to this round — call pull_wiki_entry on one ' +
            'if it looks relevant to the goal, otherwise ignore it):',
          unsubscribedIndex,
        ]
      : []),
    'Layer boundaries:',
    ctx.layerDefinitions,
    `Produce exactly ${candidateCount} mutated candidate chromosomes in the format described above.`,
  ]
    .filter((line) => line !== '')
    .join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
  };
}

const CANDIDATE_HEADER = /^#{1,3}\s*Candidate\s*\d+.*$/gim;
const LAYER_HEADER = /^\[([^\]]+)\]\s*$/;
const NEGATIVE_LINE = /^Negative:\s*(.*)$/i;

/** Pure: parse the model's plain-text mutation reply into candidate chromosomes. Throws only
 *  when the reply has no content at all or contains no recognizable "### Candidate N" block —
 *  everything inside a recognized block is parsed leniently line by line: a line that isn't a
 *  "[layerId]" header, a "Negative:" line, or a "slot: value" pair under a layer is simply
 *  skipped, never fatal (reconcile.ts's enforceSlotKeys is still the strict per-layer gate
 *  downstream, and never throws by contract). */
export function parseCandidateResponse(turn: LlmTurn): CandidateChromosome[] {
  const text = turn.message.content ?? '';
  if (!text.trim()) {
    throw new Error('mutation response had no content');
  }
  const headers = [...text.matchAll(CANDIDATE_HEADER)];
  if (headers.length === 0) {
    throw new Error('mutation response contained no "### Candidate N" block');
  }

  const chromosomes: CandidateChromosome[] = [];
  for (let i = 0; i < headers.length; i++) {
    const start = headers[i]!.index! + headers[i]![0].length;
    const end = i + 1 < headers.length ? headers[i + 1]!.index! : text.length;
    const block = text.slice(start, end);

    const slots: SlotMap = {};
    let negativePrompt: string | undefined;
    let currentLayer: string | undefined;
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      const layerMatch = line.match(LAYER_HEADER);
      if (layerMatch) {
        currentLayer = layerMatch[1]!.trim();
        if (!slots[currentLayer]) slots[currentLayer] = {};
        continue;
      }
      const negativeMatch = line.match(NEGATIVE_LINE);
      if (negativeMatch) {
        negativePrompt = negativeMatch[1]!.trim();
        currentLayer = undefined;
        continue;
      }
      if (!currentLayer) continue; // stray line outside any [layerId] block — skip

      const sep = line.indexOf(':');
      if (sep === -1) continue; // not a "slot: value" line — skip
      const key = line.slice(0, sep).trim();
      if (!key) continue;
      slots[currentLayer]![key] = line.slice(sep + 1).trim();
    }

    chromosomes.push({
      slots,
      ...(negativePrompt ? { negative_prompt: negativePrompt } : {}),
    });
  }
  return chromosomes;
}
