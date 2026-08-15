/**
 * @file orchestrator/src/util/assemblePromptStack.ts
 * @stamp 2026-08-06
 * @architectural-role Pure Function — walks a preset's ordered slots against a scene/character's
 *   fields, producing the LlmMessage[] to send
 * @description
 * This is the "Prompt Stack Assembler" spec.md §5 step 2 names. It is a pure function of scene
 * state (bi_principles.md §8's Pure Functions category) so the static prefix stays byte-identical
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
 * Moved here from plugins/context-stack-presets/src/ (2026-08-06, docs/plans/turn-loop-plan.md §3.2):
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
  | 'sync_summaries'
  | 'lorebook'
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
  /** Migration 0086: this slot is a member of a group. Every member of a contiguous run carries
   *  the same group_name (the opener's name); the FIRST member of a run is the opener (the
   *  editor shows its name box there) and the LAST is the closer (</Name> chip). See groupRuns. */
  groupName?: string;
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
  sync_summaries: 'Sync Summaries',
  lorebook: 'Lorebook',
  recent_history: 'Recent History',
  post_history_instructions: 'Post-History Instructions',
};

/**
 * The sanitized form of a tag name — the same rule 0085's slot tags and 0086's group tags use:
 * trimmed, internal whitespace/newlines collapsed to a single space, literal < and > stripped
 * so a name can't forge nested tags. Empty after sanitizing means the caller emits no tag.
 */
export function sanitizeTagName(raw: string): string {
  return raw.replace(/[<>]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * The friendly name a slot is shown under — the same resolution PromptStacksView.tsx's
 * slotLabel() uses, so the tag in the prompt matches the name in the editor: an explicit slot
 * `label` wins; marker slots fall back to their marker's display name; custom slots to
 * "Custom block (system)". Sanitized for tag use (see sanitizeTagName).
 */
export function slotTagName(slot: Pick<PromptStackSlot, 'slotType' | 'markerKey' | 'label' | 'customRole'>): string {
  const raw =
    slot.label?.trim() ||
    (slot.slotType === 'marker' ? MARKER_LABELS[slot.markerKey ?? ''] ?? slot.markerKey ?? '' : `Custom block (${slot.customRole ?? 'system'})`);
  return sanitizeTagName(raw);
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
 * the content untouched, byte-identical to pre-0085 assembly (preserving the prompt-cache
 * contract).
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

/**
 * Migration 0086: a contiguous run of slots sharing the same (sanitized, non-empty) group_name
 * is one group. The FIRST slot of the run is its opener (the editor shows its name box there),
 * the LAST is its closer (the </Name> chip) — the "toggle on the opener, toggle on the last
 * member" mechanic, derived purely from contiguity + equality so no opener/closer flags are
 * needed: toggle a later slot on and the closer moves; toggle the closer off and the previous
 * member closes the run. An empty/whitespace group_name emits no tags and breaks a run.
 * Default unset (NULL) keeps existing stacks byte-identical.
 */
export interface GroupRun {
  /** Sanitized group name, non-empty — the tag both the opener and closer are built from. */
  name: string;
  /** Index of the run's opener (first member). */
  startIndex: number;
  /** Index of the run's closer (last member). */
  endIndex: number;
}

export function groupRuns(slots: Array<Pick<PromptStackSlot, 'groupName'>>): GroupRun[] {
  const runs: GroupRun[] = [];
  let i = 0;
  while (i < slots.length) {
    const name = slots[i]!.groupName ? sanitizeTagName(slots[i]!.groupName!) : '';
    if (!name) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j < slots.length && slots[j]!.groupName && sanitizeTagName(slots[j]!.groupName!) === name) {
      j++;
    }
    runs.push({ name, startIndex: i, endIndex: j - 1 });
    i = j;
  }
  return runs;
}

/**
 * The group tags to attach around each rendered slot's content, given which slots rendered
 * (enabled and non-empty). The opener's <Name> attaches to the FIRST rendered member of its
 * run, the closer's </Name> to the LAST — disabled/empty members stay inside the group
 * positionally but render nothing, so the tags wrap the content that actually ships. A run
 * whose members all render nothing emits no tags at all; a single rendered member gets both
 * tags (<Name>…</Name> around just itself).
 */
export function groupTagsForRendered(
  slots: PromptStackSlot[],
  renderedIndices: number[],
): Map<number, { open?: string; close?: string }> {
  const tags = new Map<number, { open?: string; close?: string }>();
  for (const run of groupRuns(slots)) {
    const members = renderedIndices.filter((i) => i >= run.startIndex && i <= run.endIndex);
    if (members.length === 0) continue;
    const first = members[0]!;
    const last = members[members.length - 1]!;
    tags.set(first, { ...(tags.get(first) ?? {}), open: `<${run.name}>` });
    tags.set(last, { ...(tags.get(last) ?? {}), close: `</${run.name}>` });
  }
  return tags;
}

export function assemblePromptStack(fields: PromptStackFields, slots: PromptStackSlot[]): LlmMessage[] {
  const messages: LlmMessage[] = [];
  // Track which slots rendered (enabled and non-empty) so group tags can attach to the first/last
  // rendered member of each run instead of to disabled/empty ones.
  const renderedIndices: number[] = [];

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i]!;
    if (!slot.enabled) continue;

    if (slot.slotType === 'custom') {
      renderedIndices.push(i);
      messages.push({ role: slot.customRole!, content: wrapSlotContent(slot.customContent!, slot) });
      continue;
    }

    const value = slot.markerKey ? fields[slot.markerKey as MarkerKey] : undefined;
    if (!value) continue;
    renderedIndices.push(i);
    messages.push({ role: 'system', content: wrapSlotContent(value, slot) });
  }

  const groupTags = groupTagsForRendered(slots, renderedIndices);
  for (let m = 0; m < messages.length; m++) {
    const tags = groupTags.get(renderedIndices[m]!);
    if (!tags) continue;
    const { open, close } = tags;
    messages[m] = {
      ...messages[m]!,
      content: `${open ? `${open}\n` : ''}${messages[m]!.content}${close ? `\n${close}` : ''}`,
    };
  }

  return messages;
}
