/**
 * @file plugins/canonize/src/categories.ts
 * @stamp 2026-08-04
 * @architectural-role Pure Function module — the closed canon-fact category vocabulary
 * @description
 * The MECE category tags canonize-plan.md §3.2 defines: 'place' | 'thing' | 'concept' |
 * 'person' | 'plot'. Shared across every canonize tool so the category check and the category
 * filtering live in exactly one place. Mirrors the CHECK constraint on canon_facts.category —
 * if the schema ever widens, this is the one module to update alongside it.
 *
 * @api-declaration
 * CANON_CATEGORIES — readonly array of the five accepted category values
 * isCanonCategory(value) — narrows an unknown to a CanonCategory
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const CANON_CATEGORIES = ['place', 'thing', 'concept', 'person', 'plot'] as const;
export type CanonCategory = (typeof CANON_CATEGORIES)[number];

export function isCanonCategory(value: unknown): value is CanonCategory {
  return typeof value === 'string' && (CANON_CATEGORIES as readonly string[]).includes(value);
}