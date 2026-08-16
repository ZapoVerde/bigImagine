/**
 * @file orchestrator/src/portraits/evoprompt.ts
 * @stamp 2026-08-16
 * @architectural-role Pure Function — mutation prompt/tool-schema construction + candidate
 *   response parsing (bi_principles.md §8)
 * @description
 * Builds the forced-schema mutation call for a Portrait Studio generation round (plan
 * §Generation round step 3) and parses the model's candidate response back into chromosomes.
 * The mutation call carries the goal, any pending human feedback from the last episode, every
 * entity's `standing_instructions` (all layers, always — the settled "soft concentrate-here
 * hint, not a hard per-layer wall" reasoning), the Path-1 wiki entries, and
 * `formatLayerDefinitions()`'s boundary prose for every layer, and forces a `propose_candidates`
 * tool call returning exactly `candidateCount` (the `visual_mutation_candidate_count` setting,
 * default 3) candidate chromosomes, one `{ slots: { layerId: { ... } }, negative_prompt? }`
 * each.
 *
 * The system prompt follows the same "default + bespoke" shape as every prompt key on this
 * platform (bi_principles.md §17): `systemPromptOverride` empty → the built-in
 * DEFAULT_MUTATION_SYSTEM_PROMPT; non-empty → the override verbatim (the orchestrator resolves
 * `visual_mutation_system_prompt_override` before calling).
 *
 * parseCandidateResponse is the tolerant-but-loud inverse: it throws a descriptive error when
 * the model did not call `propose_candidates` at all or the arguments cannot be decoded, and
 * normalizes per-candidate shape leniently (a candidate with no usable slots object becomes
 * `{ slots: {} }` — reconcile.ts's enforceSlotKeys is the strict layer-by-layer gate, and
 * never throws by contract, so malformed *content* degrades to a parent-backfilled candidate
 * rather than a dead round; plan §Edge Cases).
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness.
 *
 * @api-declaration
 * MutationContext — goal, parentSlots, standingInstructions, wikiEntries, layerDefinitions,
 *   pendingFeedback?
 * DEFAULT_MUTATION_SYSTEM_PROMPT — the built-in system prompt (override-empty fallback)
 * buildMutationPrompt(ctx, candidateCount, systemPromptOverride?) -> { messages, tools } — pure
 * parseCandidateResponse(turn) -> CandidateChromosome[] — pure; throws on a missing
 *   propose_candidates call or undecodable arguments
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmMessage, LlmTurn, ToolDefinition } from '../io/llm/types.js';
import type { SlotMap } from './composer.js';
import type { CandidateChromosome } from './reconcile.js';

export interface MutationContext {
  goal: string;
  /** The current candidate's per-layer slots — the parent each mutated candidate derives from. */
  parentSlots: SlotMap;
  /** Every entity's standing_instructions, keyed by layer id (all layers, always). */
  standingInstructions: Record<string, string>;
  /** Path-1 subscribed wiki entries, pre-formatted by wiki.ts (empty string = none). */
  wikiEntries: string;
  /** `formatLayerDefinitions()` output — boundary prose for every layer. */
  layerDefinitions: string;
  /** Human rationale/notes from the last episode, if any. */
  pendingFeedback?: string;
}

export const DEFAULT_MUTATION_SYSTEM_PROMPT =
  'You are the Portrait Studio mutation engine. You mutate a character portrait candidate into ' +
  'fresh candidate chromosomes for an image-generation provider. You are given the goal, the ' +
  'current candidate\'s per-layer slot values, standing instructions per layer, lessons from a ' +
  'wiki of past evaluations, and each layer\'s boundary. Mutate deliberately: change some slots, ' +
  'keep others, always stay inside each layer\'s boundary and only use slot names that already ' +
  'exist in that layer. Respond exclusively by calling propose_candidates with exactly the ' +
  'requested number of candidate chromosomes.';

/** The one mutation tool: a forced-schema array of candidate chromosomes. `candidateCount` is
 *  baked into the description so the model sees the exact cardinality it must honor. */
export function mutationToolDefinition(candidateCount: number): ToolDefinition {
  return {
    name: 'propose_candidates',
    description: `Propose exactly ${candidateCount} mutated candidate chromosomes for the portrait round.`,
    parameters: {
      type: 'object',
      properties: {
        candidates: {
          type: 'array',
          description:
            `Exactly ${candidateCount} candidate chromosomes. Each chromosome mutates the ` +
            'current candidate: a slots object with one entry per promptable layer, each entry ' +
            'using only the slot names that already exist for that layer, plus an optional ' +
            'negative_prompt fragment.',
          items: {
            type: 'object',
            properties: {
              slots: {
                type: 'object',
                description: 'One entry per promptable layer; each layer object maps that layer\'s existing slot names to their mutated values.',
                additionalProperties: {
                  type: 'object',
                  additionalProperties: { type: 'string' },
                },
              },
              negative_prompt: {
                type: 'string',
                description: 'Optional negative-prompt fragment for this candidate only.',
              },
            },
            required: ['slots'],
            additionalProperties: false,
          },
        },
      },
      required: ['candidates'],
      additionalProperties: false,
    },
  };
}

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

function formatStandingInstructions(instructions: Record<string, string>): string {
  const entries = Object.entries(instructions).filter(([, v]) => v.trim() !== '');
  if (entries.length === 0) return '(none)';
  return entries.map(([layerId, text]) => `- ${layerId}: ${text}`).join('\n');
}

/** Pure: the full mutation prompt — system (override or built-in) + the concrete user context.
 *  `tools` contains exactly the one forced tool, so the call can pass `{ forceTool:
 *  'propose_candidates' }` (the forced-schema pattern, docs/spec.md §6.1). */
export function buildMutationPrompt(
  ctx: MutationContext,
  candidateCount: number,
  systemPromptOverride = '',
): { messages: LlmMessage[]; tools: ToolDefinition[] } {
  const system = (systemPromptOverride ?? '').trim() || DEFAULT_MUTATION_SYSTEM_PROMPT;
  const feedback = ctx.pendingFeedback?.trim() ? `Feedback from the last round:\n${ctx.pendingFeedback}` : '';
  const user = [
    `Goal: ${ctx.goal}`,
    feedback,
    'Current candidate:',
    formatSlotsForPrompt(ctx.parentSlots),
    'Standing instructions:',
    formatStandingInstructions(ctx.standingInstructions),
    'Wiki lessons:',
    ctx.wikiEntries.trim() ? ctx.wikiEntries : '(none)',
    'Layer boundaries:',
    ctx.layerDefinitions,
    `Produce exactly ${candidateCount} mutated candidate chromosomes via propose_candidates.`,
  ]
    .filter((line) => line !== '')
    .join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    tools: [mutationToolDefinition(candidateCount)],
  };
}

/** Decode a tool call's arguments — adapters may hand back an object or a JSON string. Throws
 *  on undecodable input (the orchestrator logs and fails the round, §11). */
function decodeArguments(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      throw new Error('propose_candidates arguments were not valid JSON');
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('propose_candidates arguments were not an object');
  }
  return raw as Record<string, unknown>;
}

/** Pure: parse the model's mutation turn into candidate chromosomes. Throws only when the
 *  `propose_candidates` call is missing or its arguments are undecodable — per-candidate shape
 *  is normalized leniently and left to reconcile.ts to gate strictly. */
export function parseCandidateResponse(turn: LlmTurn): CandidateChromosome[] {
  const call = turn.toolCalls.find((c) => c.name === 'propose_candidates');
  if (!call) {
    throw new Error('mutation response did not call propose_candidates');
  }
  const args = decodeArguments(call.arguments);
  if (!Array.isArray(args.candidates)) {
    throw new Error('propose_candidates arguments had no candidates array');
  }
  const chromosomes: CandidateChromosome[] = [];
  for (const entry of args.candidates) {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error('propose_candidates returned a non-object candidate');
    }
    const candidate = entry as Record<string, unknown>;
    const slots: SlotMap = {};
    if (typeof candidate.slots === 'object' && candidate.slots !== null && !Array.isArray(candidate.slots)) {
      for (const [layerId, layerSlots] of Object.entries(candidate.slots as Record<string, unknown>)) {
        if (typeof layerSlots !== 'object' || layerSlots === null || Array.isArray(layerSlots)) continue;
        const out: Record<string, string> = {};
        for (const [name, value] of Object.entries(layerSlots as Record<string, unknown>)) {
          out[name] = typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
        }
        slots[layerId] = out;
      }
    }
    chromosomes.push({
      slots,
      ...(typeof candidate.negative_prompt === 'string' && candidate.negative_prompt !== ''
        ? { negative_prompt: candidate.negative_prompt }
        : {}),
    });
  }
  return chromosomes;
}
