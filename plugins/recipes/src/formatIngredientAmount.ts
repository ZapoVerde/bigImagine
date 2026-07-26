/**
 * @file plugins/recipes/src/formatIngredientAmount.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — picks the most natural display unit for an amount
 * @description
 * Deciding *which* unit to show (gram vs. kilogram, teaspoon vs. tablespoon vs. cup) is itself a
 * small derivation, so it belongs in a Pure Function rather than reconstructed client-side
 * (bb_principles.md §7: the client only displays what it's given). Runs at every render of a
 * (possibly-scaled) amount, not as a scaling-specific special case — the same amount always picks
 * the same display unit whether it came from the recipe as written or from scaling it up or down.
 *
 * Two "ladders," walked by magnitude in both directions (promoting up when an amount has grown
 * large, demoting back down when it's shrunk to something awkward):
 *   - metric weight: gram <-> kilogram, switching at 1000g
 *   - metric volume: milliliter <-> liter, switching at 1000mL
 *   - kept imperial volume (teaspoon/tablespoon/cup, converted internally to a teaspoon-equivalent
 *     purely to pick a rung — never stored that way): promotes to tablespoon at 1 tbsp (3 tsp), to
 *     cup at a quarter-cup (12 tsp / 4 tbsp) rather than only at a full cup, since "3/4 cup" reads
 *     far better than "12 Tablespoon" and the household's own kitchens measure quarter-cups
 *     directly. Promotion is also gated on reading cleanly at the bigger unit — formatCleanFraction
 *     (below) only accepts amounts within 10% of a common cooking fraction (eighths/quarters/
 *     thirds/halves) or a whole number; an amount that would land on an ugly decimal (e.g. 0.42 cup)
 *     stays at the smaller, finer-grained unit instead, checked the same way one rung down, with
 *     teaspoon as the unconditional floor. This tolerance is deliberately relative (10% of the
 *     fraction's own size), unlike formatAmount's absolute 0.03 used everywhere else — a fixed
 *     absolute tolerance is right for count units (a borderline decimal shouldn't get mislabeled as
 *     "7 3/8 cloves") but wrong here, since how close is "close enough" to 1/3 cup vs. 1/8 cup isn't
 *     the same fixed amount.
 *
 * Metric amounts are tiered by magnitude rather than rounded to one fixed increment, because a
 * flat rounding step is either too coarse for a small amount or too precise-looking for a large
 * one: under 50 (g or mL) rounds to the nearest 1, 50-250 to the nearest 5, 250-1000 to the nearest
 * 10, and 1000+ switches to kg/L at 2 decimal places (equivalent resolution, more readable).
 * Rounding only ever affects the returned display string — the numeric amount scaleIngredients.ts
 * computed and would scale again from later is never touched.
 *
 * Anything outside these three families (no unit, or a count unit like "clove"/"can"/"head") falls
 * straight through to formatAmount alone.
 *
 * formatAmount itself lives here (moved from scaleIngredients.ts, which now calls
 * formatIngredientAmount instead of formatting amounts itself) purely to avoid a two-file import
 * cycle — this module already needs it internally for the imperial-volume/fallback cases, and
 * aggregateScaledIngredients.ts needs the same unit-aware formatting for its final display string.
 *
 * @api-declaration
 * formatIngredientAmount(amount, unit) -> a ready-to-render string with its unit already included
 *   (e.g. "3/4 cup", "1.59 kg", "5 g", or formatAmount's own fallback shape for anything else)
 * formatAmount(amount) — the cooking-friendly fraction formatter (e.g. 1.5 -> "1 1/2"), snapped to
 *   eighths/quarters/thirds/halves; falls back to a plain decimal when nothing snaps closely enough
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

const COMMON_DENOMINATORS = [2, 3, 4, 8];
const FRACTION_MATCH_TOLERANCE = 0.03;

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}

export function formatAmount(amount: number): string {
  const whole = Math.floor(amount);
  const fraction = amount - whole;

  if (fraction < FRACTION_MATCH_TOLERANCE) return String(whole);
  if (fraction > 1 - FRACTION_MATCH_TOLERANCE) return String(whole + 1);

  let bestNumerator = 0;
  let bestDenominator = 1;
  let bestError = FRACTION_MATCH_TOLERANCE;
  for (const d of COMMON_DENOMINATORS) {
    const n = Math.round(fraction * d);
    if (n === 0 || n === d) continue;
    const error = Math.abs(fraction - n / d);
    if (error < bestError) {
      bestError = error;
      bestNumerator = n;
      bestDenominator = d;
    }
  }

  if (bestNumerator === 0) {
    // No common cooking fraction matches closely enough — a misleadingly precise fraction would
    // be worse than a rounded decimal here.
    const rounded = Math.round(amount * 100) / 100;
    return String(rounded);
  }

  const g = gcd(bestNumerator, bestDenominator);
  const fractionStr = `${bestNumerator / g}/${bestDenominator / g}`;
  return whole > 0 ? `${whole} ${fractionStr}` : fractionStr;
}

const TSP_PER_TBSP = 3;
const TSP_PER_CUP = 48; // 16 tbsp, each 3 tsp

function formatMetricTiered(amount: number, smallUnit: string, bigUnit: string): string {
  if (amount >= 1000) {
    return `${Math.round((amount / 1000) * 100) / 100} ${bigUnit}`;
  }
  let rounded: number;
  if (amount < 50) rounded = Math.round(amount);
  else if (amount < 250) rounded = Math.round(amount / 5) * 5;
  else rounded = Math.round(amount / 10) * 10;
  return `${rounded} ${smallUnit}`;
}

// formatAmount's own snap tolerance is absolute (0.03), which is right for count units (a
// borderline fraction should stay a plain decimal rather than mislabel "7 cloves" as "7 3/8") but
// wrong for deciding whether to *promote* to a bigger measuring unit: a physical cup measure only
// reads cleanly at eighths/quarters/thirds/halves, and how close is "close enough" scales with the
// fraction itself, not a fixed absolute amount. Returns the formatted fraction only when it lands
// within 10% of a common cooking fraction (or is already ~whole); null otherwise, signaling the
// caller to stay at a smaller, finer-grained unit instead of showing an ugly decimal here.
const RELATIVE_SNAP_TOLERANCE = 0.1;

function formatCleanFraction(amount: number): string | null {
  const whole = Math.floor(amount);
  const fraction = amount - whole;

  if (fraction < FRACTION_MATCH_TOLERANCE) return String(whole);
  if (fraction > 1 - FRACTION_MATCH_TOLERANCE) return String(whole + 1);

  let bestNumerator = 0;
  let bestDenominator = 1;
  let bestRelativeError = RELATIVE_SNAP_TOLERANCE;
  for (const d of COMMON_DENOMINATORS) {
    const n = Math.round(fraction * d);
    if (n === 0 || n === d) continue;
    const candidate = n / d;
    const relativeError = Math.abs(fraction - candidate) / candidate;
    if (relativeError <= bestRelativeError) {
      bestRelativeError = relativeError;
      bestNumerator = n;
      bestDenominator = d;
    }
  }

  if (bestNumerator === 0) return null;

  const g = gcd(bestNumerator, bestDenominator);
  const fractionStr = `${bestNumerator / g}/${bestDenominator / g}`;
  return whole > 0 ? `${whole} ${fractionStr}` : fractionStr;
}

function formatImperialVolume(amount: number, unit: 'teaspoon' | 'tablespoon' | 'cup'): string {
  const tspEquivalent = unit === 'teaspoon' ? amount : unit === 'tablespoon' ? amount * TSP_PER_TBSP : amount * TSP_PER_CUP;

  if (tspEquivalent >= TSP_PER_CUP / 4) {
    const cupFraction = formatCleanFraction(tspEquivalent / TSP_PER_CUP);
    if (cupFraction !== null) return `${cupFraction} cup`;
  }
  if (tspEquivalent >= TSP_PER_TBSP) {
    const tbspFraction = formatCleanFraction(tspEquivalent / TSP_PER_TBSP);
    if (tbspFraction !== null) return `${tbspFraction} tablespoon`;
  }
  return `${formatAmount(tspEquivalent)} teaspoon`;
}

export function formatIngredientAmount(amount: number, unit: string | null): string {
  const normalizedUnit = unit?.trim().toLowerCase() ?? null;

  if (normalizedUnit === 'gram') return formatMetricTiered(amount, 'g', 'kg');
  if (normalizedUnit === 'milliliter') return formatMetricTiered(amount, 'mL', 'L');
  if (normalizedUnit === 'teaspoon' || normalizedUnit === 'tablespoon' || normalizedUnit === 'cup') {
    return formatImperialVolume(amount, normalizedUnit);
  }

  const fraction = formatAmount(amount);
  return unit ? `${fraction} ${unit}` : fraction;
}
