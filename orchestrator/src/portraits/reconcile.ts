/**
 * @file orchestrator/src/portraits/reconcile.ts
 * @stamp 2026-08-16
 * @architectural-role Pure Function — slot-key fidelity between a mutated candidate and its
 *   parent, per layer (bi_principles.md §8)
 * @description
 * enforceSlotKeys reconciles a mutated candidate chromosome against its parent: the mutation LLM
 * is free-form enough to hallucinate a slot key no entity owns, or to omit one it should have
 * carried forward — both corruptions are fixed here, per layer, unconditionally (plan
 * §Generation round step 5). A key in the child that the parent's layer does not have is
 * dropped (hallucinated); a parent key missing from the child is backfilled from the parent.
 * The operation is per layer over the manifest's whole layer list — a child's slots object is
 * reconciled independently for every layer, so a manifest with 2, 4 or 6 layers takes the same
 * code path (plan §Tests). Values pass through untouched: fidelity is about *which* keys exist,
 * not rewriting what the model produced.
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness. Never throws (plan §Edge Cases): a malformed child (missing slots object, a layer
 * entry that isn't an object) is treated as "no child content for that layer" and backfilled
 * wholesale from the parent; the call site can rely on reconcile having produced a valid
 * chromosome or having thrown only on a genuinely unusable parent.
 *
 * @api-declaration
 * CandidateChromosome — { slots: SlotMap, negative_prompt?: string }
 * enforceSlotKeys(parent, child, layers) -> CandidateChromosome — pure; drops hallucinated child
 *   keys, backfills omitted parent keys, per layer, never throws
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LayerDefinition } from './layerStack.js';
import type { SlotMap } from './composer.js';

export interface CandidateChromosome {
  slots: SlotMap;
  negative_prompt?: string;
}

/** Pure: value coercion for slot values the model returned non-string (a number, a nested
 *  object) — the chromosome contract is string values; anything else is stringified rather than
 *  dropped, so the composed prompt never silently loses a legitimately proposed value. */
function toSlotValue(value: unknown): string {
  return typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value);
}

/** Pure: reconcile one layer's child slots against the parent's. The parent's key set is the
 *  contract; the child may neither invent keys nor drop existing ones. */
function reconcileLayer(parent: Record<string, unknown>, child: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  const childIsObject = typeof child === 'object' && child !== null && !Array.isArray(child);
  for (const [key, value] of Object.entries(parent)) {
    const candidate = childIsObject && typeof (child as Record<string, unknown>)[key] !== 'undefined'
      ? (child as Record<string, unknown>)[key]
      : value;
    out[key] = toSlotValue(candidate);
  }
  return out;
}

/** Pure: full-chromosome reconciliation over every layer the manifest declares. Hallucinated
 *  child keys are dropped; omitted parent keys are backfilled; `negative_prompt` passes through
 *  (it is not layer-scoped and has no parent contract). Never throws — a degenerate child (null,
 *  a missing/empty slots object) is treated as "no child content at all" and every layer is
 *  backfilled wholesale from the parent; only a genuinely unusable parent (null) is the caller's
 *  bug, not this module's fallback path. */
export function enforceSlotKeys(parent: CandidateChromosome, child: CandidateChromosome, layers: LayerDefinition[]): CandidateChromosome {
  const childIsUsable = typeof child === 'object' && child !== null;
  const childSlots = childIsUsable && typeof child.slots === 'object' && child.slots !== null ? child.slots : {};
  const slots: SlotMap = {};
  for (const layer of layers) {
    const parentLayer = parent.slots[layer.id];
    if (!parentLayer) continue; // parent had nothing for this layer — nothing to enforce
    slots[layer.id] = reconcileLayer(parentLayer, childSlots[layer.id]);
  }
  const negative = childIsUsable ? child.negative_prompt : undefined;
  return { slots, ...(negative !== undefined ? { negative_prompt: negative } : {}) };
}
