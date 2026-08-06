/**
 * @file plugins/context-stack-presets/src/assemblePromptStack.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Function — walks a preset's ordered slots against a scene/character's
 *   fields, producing the LlmMessage[] to send
 * @description
 * This is the "Prompt Stack Assembler" spec.md §5 step 2 and bi_principles.md §17 already name.
 * §17 requires it to be a pure function of scene state so the static prefix stays byte-identical
 * across every character's turn in a scene (that's what makes prompt caching actually pay off) —
 * so this module never queries context_stack_presets/context_stack_slots itself. Whatever
 * resolves which preset applies to a turn (an Orchestrator, once scenes/characters exist per
 * docs/bootstrap.md) reads the slots and hands the array in here alongside a plain fields object.
 *
 * `fields` is deliberately flat — one string per marker, not per-marker message arrays — matching
 * spec.md's own "Fixed order, always" framing for step 2: every marker (including recent_history)
 * is a slot in the stack, not a different kind of thing. A caller that wants recent_history to
 * read as prior turns rather than one block of narration is free to format that string however it
 * likes before calling this; the assembler has no opinion beyond "is there content for this slot."
 *
 * Every marker-backed message comes out as role 'system' — these are all context/instruction
 * injections the model should treat as ground truth, not something a user or the model itself
 * said. Only a 'custom' slot's role is caller-chosen (validated at the create/update tool
 * boundary, matching context_stack_slots' own custom_role check constraint).
 *
 * @api-declaration
 * MarkerKey — the closed vocabulary of card fields + BI additions from migration 0042
 * PromptStackFields — Partial<Record<MarkerKey, string>>, the pure function's first argument
 * PromptStackSlot — one context_stack_slots row's assembly-relevant fields
 * assemblePromptStack(fields, slots) — returns LlmMessage[]
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { LlmMessage } from '@bigbrain/orchestrator/llm-types';

export type MarkerKey =
  | 'system'
  | 'description'
  | 'personality'
  | 'scenario'
  | 'persona'
  | 'mes_example'
  | 'post_history_instructions'
  | 'global_rules'
  | 'location'
  | 'canon_facts'
  | 'memory_recall'
  | 'recent_history';

export type PromptStackFields = Partial<Record<MarkerKey, string>>;

export interface PromptStackSlot {
  slotType: 'marker' | 'custom';
  /** Set (and meaningful) only when slotType === 'marker'. */
  markerKey?: string;
  enabled: boolean;
  /** Set (and meaningful) only when slotType === 'custom'. */
  customRole?: 'system' | 'user' | 'assistant';
  /** Set (and meaningful) only when slotType === 'custom'. */
  customContent?: string;
}

export function assemblePromptStack(fields: PromptStackFields, slots: PromptStackSlot[]): LlmMessage[] {
  const messages: LlmMessage[] = [];

  for (const slot of slots) {
    if (!slot.enabled) continue;

    if (slot.slotType === 'custom') {
      messages.push({ role: slot.customRole!, content: slot.customContent! });
      continue;
    }

    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    messages.push({ role: 'system', content: value });
  }

  return messages;
}
