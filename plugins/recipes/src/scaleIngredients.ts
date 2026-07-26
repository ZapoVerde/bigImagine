/**
 * @file plugins/recipes/src/scaleIngredients.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — scales structured ingredient amounts by a ratio
 * @description
 * The deterministic-arithmetic half of the LLM-structures/code-scales split (bb_principles.md §2:
 * the LLM reasons, nothing else does — and multiplying a number by a ratio is exactly the kind of
 * thing an LLM should never be asked to do, since it isn't reliable at arithmetic). Every scaling
 * call in the plugin — scale_recipe, generate_shopping_list_from_meal_plan — goes through this one
 * function so there is exactly one place ratio math happens.
 *
 * amountDisplay renders as a cooking-friendly fraction (e.g. 1.5 -> "1 1/2") rather than a raw
 * decimal, snapped to eighths/quarters/thirds/halves since that's what a household actually
 * measures with. A ratio that doesn't land near one of those is shown as a plain decimal instead
 * of a misleadingly precise fraction.
 *
 * @api-declaration
 * scaleIngredients(ingredients, ratio) — multiplies amount by ratio for scalable lines, passes
 *   non-scalable lines through unchanged (amountDisplay: null — item already carries the full
 *   descriptive text for those, e.g. "salt to taste")
 * formatAmount(amount) — the fraction-friendly formatter, exported so callers needing just the
 *   display string (not a full ScaledIngredient) can reuse it
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { RecipeIngredient, ScaledIngredient } from './recipeIngredientSchema.js';

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

export function scaleIngredients(ingredients: RecipeIngredient[], ratio: number): ScaledIngredient[] {
  return ingredients.map((ing) => {
    if (!ing.scalable || ing.amount === null) {
      return { ...ing, amountDisplay: null };
    }
    const amount = ing.amount * ratio;
    return { ...ing, amount, amountDisplay: formatAmount(amount) };
  });
}
