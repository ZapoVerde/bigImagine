/**
 * @file orchestrator/src/util/sectionStability.ts
 * @stamp 2026-08-10
 * @architectural-role Pure util — section-identity stability across a fixed window of calls
 * @description
 * The Prompt Inspector's per-subsection "identical to the previous call" percentage
 * (docs/plans/prompt-inspector-tag-tree.md §3.3). The window is the last x calls on record in
 * io/promptTrace.ts (≤ MAX_ENTRIES_PER_CHAT = 12) — data the trace already holds, no new state,
 * no reset-on-edit bookkeeping. Each consecutive pair (prev, curr) inside the window contributes
 * one observation per section: a section present in curr "saw" a comparison, and counts as
 * identical when its full span (tags + children + text) is byte-identical to the previous call's
 * same section. The percentage shown per section is identical / seen over the window.
 *
 * Sections are keyed by canonical tag name plus an occurrence index within the call (document
 * order, preorder — a section before its children), so two <memory> sections in one call are
 * tracked separately and the frontend can match rendered rows to stats with the same key rule.
 * Purely functional: given the joined texts, everything is derivable — the trace is the only
 * source, so a restart (empty trace) simply yields no stats, same as the cache badges.
 *
 * @api-declaration
 * flattenSections(text) — parse text into ordered section observations {key, name, text}
 * computeSectionStability(joinedTexts) — stats over the consecutive pairs of the window
 *
 * @contract
 *   assertions:
 *     purity:          pure (no imports beyond util/promptTagTree.js)
 *     state_ownership: none
 *     external_io:     []
 */

import { parsePromptTagTree } from './promptTagTree.js';

export interface SectionObservation {
  /** Stable identity across calls: canonical tag name, plus #occ when the name repeats. */
  key: string;
  /** Canonical tag name (attribute-stripped, spaced names preserved). */
  name: string;
  /** The section's full span in the joined text — tags, own text, and children included. */
  text: string;
}

export interface SectionStabilityStat {
  key: string;
  name: string;
  /** How many window comparisons the section took part in (existed in the later call). */
  seen: number;
  /** Of those, how many were byte-identical to the previous call's same section. */
  identical: number;
}

export interface SectionStabilityResult {
  /** Number of consecutive pairs analyzed = joinedTexts.length - 1 (0 for <2 texts). */
  comparisons: number;
  sections: SectionStabilityStat[];
}

// Flatten the tag tree into ordered observations: preorder (a section before its children),
// matching how the frontend renders and keys rows. The occurrence index is per-name and resets
// per call — it only exists to disambiguate repeated names within one call.
export function flattenSections(text: string): SectionObservation[] {
  const out: SectionObservation[] = [];
  const occurrence = new Map<string, number>();
  const tree = parsePromptTagTree(text);
  // walk preorder over the root's children
  const walk = (section: { name: string; start: number; end: number; children: unknown[] }): void => {
    const occ = occurrence.get(section.name) ?? 0;
    occurrence.set(section.name, occ + 1);
    out.push({
      key: occ === 0 ? section.name : `${section.name}#${occ}`,
      name: section.name,
      text: text.slice(section.start, section.end),
    });
    for (const child of section.children as typeof section[]) walk(child);
  };
  for (const child of tree.children) walk(child);
  return out;
}

// Replay the window: for every consecutive pair, compare each section of the later call against
// the earlier call's same key. A section new in the later call counts as seen-but-not-identical
// (there was no previous occurrence to be identical to); a section absent from the later call
// contributes nothing that call (it has no current text to measure). Deterministic.
export function computeSectionStability(joinedTexts: string[]): SectionStabilityResult {
  const stats = new Map<string, SectionStabilityStat>();
  let previous: Map<string, string> = new Map();
  let isFirst = true;
  for (const text of joinedTexts) {
    const current = flattenSections(text);
    const currentByKey = new Map(current.map((o) => [o.key, o.text] as const));
    if (!isFirst) {
      for (const obs of current) {
        const stat = stats.get(obs.key) ?? { key: obs.key, name: obs.name, seen: 0, identical: 0 };
        stat.seen += 1;
        const prevText = previous.get(obs.key);
        if (prevText !== undefined && prevText === obs.text) stat.identical += 1;
        stats.set(obs.key, stat);
      }
    }
    previous = currentByKey;
    isFirst = false;
  }
  return {
    comparisons: Math.max(0, joinedTexts.length - 1),
    sections: [...stats.values()],
  };
}
