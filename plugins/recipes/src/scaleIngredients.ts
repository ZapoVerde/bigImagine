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
 * amountDisplay is built by formatIngredientAmount.ts, which also decides *which* unit reads best
 * for the now-scaled amount (g vs. kg, tbsp vs. cup) — so amountDisplay is a complete, ready-to-
 * render string with its own unit already included, not just a number the caller glues a static
 * unit onto.
 *
 * @api-declaration
 * scaleIngredients(ingredients, ratio) — multiplies amount by ratio for scalable lines, passes
 *   non-scalable lines through unchanged (amountDisplay: null — item already carries the full
 *   descriptive text for those, e.g. "salt to taste")
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { RecipeIngredient, ScaledIngredient } from './recipeIngredientSchema.js';
import { formatIngredientAmount } from './formatIngredientAmount.js';

export function scaleIngredients(ingredients: RecipeIngredient[], ratio: number): ScaledIngredient[] {
  return ingredients.map((ing) => {
    if (!ing.scalable || ing.amount === null) {
      return { ...ing, amountDisplay: null };
    }
    const amount = ing.amount * ratio;
    return { ...ing, amount, amountDisplay: formatIngredientAmount(amount, ing.unit) };
  });
}
