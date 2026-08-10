/**
 * @file orchestrator/src/util/assemblePromptStack.ts
 * @stamp 2026-08-06
 * @architectural-role Pure Function — walks a preset's ordered slots against a scene/character's
 *   fields, producing the LlmMessage[] to send
 * @description
 * This is the "Prompt Stack Assembler" spec.md §5 step 2 and bi_principles.md §17 already name.
 * §17 requires it to be a pure function of scene state so the static prefix stays byte-identical
 * across every character's turn in a scene (that's what makes prompt caching actually pay off) —
 * so this module never queries context_stack_presets/context_stack_slots itself. Whatever
 * resolves which preset applies to a turn reads the slots and hands the array in here alongside a
 * plain fields object.
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
 * Moved here from plugins/context-stack-presets/src/ (2026-08-06, docs/turn-loop-plan.md §3.2):
 * server/httpServer.ts needs to call this directly for per-turn narrator assembly, and
 * plugins/document-ingestion's own doc already establishes the rule this file was violating by
 * living in a plugin — "plugins depend on @bigbrain/orchestrator, never the reverse." A pure
 * function with zero plugin-specific state belongs in core the same way interpolateMacros.ts
 * already does; plugins/context-stack-presets/src/applyPromptStackToChatTool.ts now imports it
 * back via the `@bigbrain/orchestrator/assemble-prompt-stack` export, same as any other core util
 * a plugin consumes.
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

import type { LlmMessage } from '../io/llm/types.js';

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
  | 'bridge'
  | 'plot_threads'
  | 'auto_recall'
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
  /** Optional display name (migration 0060) — assembly-relevant only when tagEnabled (it names
   *  the wrapper tag); ignored otherwise, matching 0060's original cosmetic-only contract. */
  label?: string;
  /** Migration 0085: wrap this slot's assembled content in <Friendly Name>…</Friendly Name>
   *  HTML-style tags — a hint to the LLM, not real HTML. Default off; see wrapSlotContent. */
  tagEnabled?: boolean;
}

// Mirror of frontend/src/api/markerLabels.ts (the editor + inspector's display-name map) —
// the assembler needs the friendly name server-side to name the wrapper tag, and the two must
// not drift. Keep in sync when either side changes.
export const MARKER_LABELS: Record<string, string> = {
  system: 'System Prompt',
  global_rules: 'Global Rules',
  description: 'Description',
  personality: 'Personality',
  scenario: 'Scenario',
  persona: 'User Persona',
  location: 'Active Location',
  canon_facts: 'Canon Facts',
  mes_example: 'Example Messages',
  memory_recall: 'Memory Recall',
  bridge: 'Bridge',
  plot_threads: 'Plot Threads',
  auto_recall: 'Auto Recall',
  recent_history: 'Recent History',
  post_history_instructions: 'Post-History Instructions',
};

/**
 * The friendly name a slot is shown under — the same resolution PromptStacksView.tsx's
 * slotLabel() uses, so the tag in the prompt matches the name in the editor: an explicit slot
 * `label` wins; marker slots fall back to their marker's display name; custom slots to
 * "Custom block (system)". Sanitized for tag use: trimmed, internal whitespace/newlines
 * collapsed to a single space, literal < and > stripped so the name can't forge nested tags.
 */
export function slotTagName(slot: Pick<PromptStackSlot, 'slotType' | 'markerKey' | 'label' | 'customRole'>): string {
  const raw =
    slot.label?.trim() ||
    (slot.slotType === 'marker' ? MARKER_LABELS[slot.markerKey ?? ''] ?? slot.markerKey ?? '' : `Custom block (${slot.customRole ?? 'system'})`);
  return raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Migration 0085: when a slot has tagEnabled, wrap its assembled content in HTML-style tags
 * named after the slot's friendly label:
 *
 *   <Chat History>
 *   ...content...
 *   </Chat History>
 *
 * A hint to the LLM (a labeled boundary, like the preset-authored tags Comfy 2 already uses),
 * not real HTML — so the name stays verbatim (spaces, punctuation), and the opening/closing tags
 * are generated from the same string so they always match. tagEnabled off (the default) returns
 * the content untouched, byte-identical to pre-0085 assembly (bi_principles.md §17's
 * prompt-cache contract).
 */
export function wrapSlotContent(
  content: string,
  slot: Pick<PromptStackSlot, 'slotType' | 'markerKey' | 'label' | 'customRole' | 'tagEnabled'>,
): string {
  if (!slot.tagEnabled) return content;
  const name = slotTagName(slot);
  if (!name) return content;
  return `<${name}>\n${content}\n</${name}>`;
}

export function assemblePromptStack(fields: PromptStackFields, slots: PromptStackSlot[]): LlmMessage[] {
  const messages: LlmMessage[] = [];

  for (const slot of slots) {
    if (!slot.enabled) continue;

    if (slot.slotType === 'custom') {
      messages.push({ role: slot.customRole!, content: wrapSlotContent(slot.customContent!, slot) });
      continue;
    }

    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    messages.push({ role: 'system', content: wrapSlotContent(value, slot) });
  }

  return messages;
}
