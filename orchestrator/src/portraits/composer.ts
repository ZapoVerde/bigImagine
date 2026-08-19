/**
 * @file orchestrator/src/portraits/composer.ts
 * @stamp 2026-08-19b
 * @architectural-role Pure Function — {{slot}} template compilation + overflow buckets + per-layer
 *   details prose (bi_principles.md §8), generalized over the active manifest's layer list
 * @description
 * compileTemplate takes the active manifest's `template` string and a map of
 * `{ layerId: { slotName: value } }`, substitutes every `{{slot_name}}` token it finds against
 * whichever layer owns that slot name, and folds anything not explicitly placed into that
 * layer's `{{<layerId>_overflow}}` bucket (auto-formatted `"label: value, ..."`), stripping
 * unused tokens and collapsing comma runs afterward. Direct generalization of playground's
 * composer.js, parameterized over the active layer list instead of a fixed three/four — the
 * overflow-token naming derives from the manifest's own layer ids, so a manifest with 2, 4 or 6
 * promptable layers compiles with the same code path (plan §Composition, §Tests).
 *
 * The 4th argument is the round's per-layer authored prose (docs/plans/portrait-studio-layer-
 * details-plan.md): `{ [layerId]: string }`. The reserved `{{<layerId>_details}}` token family
 * (parallel to `_overflow`) places that prose directly — each layer's meaning is distinct, so a
 * value never bleeds across layers ("'Displeased' belongs in Expression details; 'Asian woman'
 * belongs in Subject details"). Defaulted to `{}`, so every pre-details caller and test fixture
 * compiles unchanged.
 *
 * Rule details, all deterministic:
 * - A `{{token}}` naming a slot some layer's map owns → substituted with that value (empty value
 *   substitutes the empty string, and the token counts as "placed" so it is never also folded
 *   into overflow).
 * - `{{<layerId>_overflow}}` for a known promptable layer → the layer's unplaced, non-empty
 *   slots formatted `"label: value, ..."`. Empty bucket → the token vanishes.
 * - `{{<layerId>_details}}` for a known promptable layer → the layer's authored prose, trimmed
 *   (`details[layerId]?.trim() ?? ''`); empty/absent → `''`.
 * - Any other token (unknown slot name, unknown layer, a typo) is left verbatim — the same
 *   diagnosable-not-dropped convention as synthesizeImagePrompt.ts's unknown macros.
 * - Any token that resolves to `''` also consumes its own trailing `, ` (a literal comma +
 *   whitespace immediately following the token in the template), so an empty field never leaves
 *   an orphaned separator behind — "A portrait of {{subject_details}}, {{subject_overflow}}" with
 *   empty details reads "A portrait of <overflow>", not "A portrait of , <overflow>".
 * - After substitution, remaining comma runs (`, ,` left by two adjacent empty fields,
 *   leading/trailing commas) collapse and whitespace trims.
 *
 * Pure by construction: identical inputs always produce identical output — no IO, no state, no
 * randomness — the property the generation round relies on to re-compose a candidate's prompt
 * for the winner/episode record. `details` is just another plain input.
 *
 * @api-declaration
 * SlotMap — { [layerId]: { [slotName]: string } } — a candidate chromosome's slots
 * DetailsMap — { [layerId]: string } — the round's authored per-layer prose
 * compileTemplate(template, slots, layers, details = {}) -> string — pure
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no randomness)
 *     state_ownership: []
 *     external_io:     []
 */

import type { LayerDefinition } from './layerStack.js';

/** A candidate chromosome's slots: one object of slot values per layer id. Values are strings —
 *  reconciliation (reconcile.ts) coerces whatever the model returns before this is ever reached. */
export type SlotMap = Record<string, Record<string, string>>;

/** The round's authored per-layer prose: `{ [layerId]: string }` — the text `{{<layerId>_details}}`
 *  tokens resolve to (composer.ts), loaded once per round from visual_entities.details. */
export type DetailsMap = Record<string, string>;

// Captures a token's own trailing separator (a literal comma + whitespace, if the template has
// one right there) so an empty-valued token can drop it along with itself — see compileTemplate.
const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}(,\s*)?/g;

/** All slot names the template places explicitly — used to decide what overflow may NOT contain
 *  (a placed slot never also lands in its layer's bucket). Overflow tokens
 *  (`{{<layerId>_overflow}}`) and details tokens (`{{<layerId>_details}}`) place nothing — both
 *  are reserved families, same as the plan's `_overflow` carve-out; a bare `{{<layerId>}}` token
 *  is not special — it is just a (probably unknown) slot name, matching the verbatim-unknown-token
 *  rule below. */
function collectPlacedSlots(template: string, layers: LayerDefinition[]): Set<string> {
  const promptableIds = new Set(layers.filter((l) => l.promptable).map((l) => l.id));
  const placed = new Set<string>();
  for (const match of template.matchAll(TOKEN_RE)) {
    const token = match[1];
    const suffix = token.endsWith('_overflow') ? '_overflow' : token.endsWith('_details') ? '_details' : null;
    const isReserved = suffix !== null && promptableIds.has(token.slice(0, -suffix.length));
    if (!isReserved) placed.add(token);
  }
  return placed;
}

/** The overflow bucket for one layer: every non-empty slot value not explicitly placed in the
 *  template, formatted `"label: value, ..."`. Deterministic — slot insertion order, no sorting. */
function overflowFor(slots: Record<string, string>, placed: Set<string>): string {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(slots)) {
    if (placed.has(name)) continue;
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) continue;
    parts.push(`${name}: ${text}`);
  }
  return parts.join(', ');
}

/** Collapse comma runs and trim ragged whitespace left by empty substitutions: `", , "` →
 *  `""`, `"a, , b"` → `"a, b"`, leading/trailing commas vanish. Idempotent. */
function collapse(text: string): string {
  return text
    .replace(/(,\s*){2,}/g, ', ')
    .replace(/^\s*,\s*/, '')
    .replace(/\s*,\s*$/, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** Pure template compilation. `layers` must be the active manifest's layer list (promptable and
 *  non-promptable alike — overflow/details tokens exist for promptable layers only). `details` is
 *  the round's authored prose per layer (defaulted `{}` for pre-details callers). */
export function compileTemplate(template: string, slots: SlotMap, layers: LayerDefinition[], details: DetailsMap = {}): string {
  const placed = collectPlacedSlots(template, layers);
  const promptableIds = new Set(layers.filter((l) => l.promptable).map((l) => l.id));

  const compiled = template.replace(TOKEN_RE, (match, token: string, sep: string | undefined) => {
    let value: string | null; // null = unknown token — leave the whole match verbatim, comma included
    if (token.endsWith('_details')) {
      const layerId = token.slice(0, -'_details'.length);
      value = promptableIds.has(layerId) ? details[layerId]?.trim() ?? '' : null;
    } else if (token.endsWith('_overflow')) {
      const layerId = token.slice(0, -'_overflow'.length);
      value = promptableIds.has(layerId) ? overflowFor(slots[layerId] ?? {}, placed) : null;
    } else {
      // Plain slot token → the value owned by whichever layer has this slot name.
      value = null;
      for (const layer of layers) {
        const layerSlots = slots[layer.id];
        if (layerSlots && token in layerSlots) {
          const raw = layerSlots[token];
          value = typeof raw === 'string' ? raw : '';
          break;
        }
      }
    }
    if (value === null) return match; // unknown slot/layer — leave verbatim (diagnosable, never silently dropped)
    // A token that resolves empty takes its own trailing ", " down with it, so a skipped-first-of-
    // two field ("A portrait of {{empty}}, {{overflow}}") doesn't leave an orphaned comma+space —
    // collapse() below only catches doubled comma runs, not this single-orphan case.
    return value === '' ? '' : value + (sep ?? '');
  });

  return collapse(compiled);
}
