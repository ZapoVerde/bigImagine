/**
 * @file plugins/recipes/src/aggregateScaledIngredients.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — sums scaled ingredient amounts across multiple meals
 * @description
 * generate_shopping_list_from_meal_plan needs to turn several meals' worth of already-scaled
 * ingredients into one grocery list, merging "2 cups flour" from one meal with "1 cup flour" from
 * another into "3 cups flour" instead of two separate lines. That merge is derivation logic, so it
 * lives here rather than inline in shoppingListFromMealPlanTool.ts (an IO Wrapper, which
 * bb_principles.md §8 says must contain zero derivation logic).
 *
 * Only same-item, same-unit amounts sum ("2 cups flour" + "1 cup flour", not "2 cups" + "3 tbsp") —
 * cross-unit conversion stays explicitly out of scope, same punt this file's caller already
 * documented before this feature. Non-scalable lines (amount null, e.g. "salt to taste") just
 * dedupe by item text, first-seen wins — there's nothing to sum.
 *
 * @api-declaration
 * AggregatedIngredient — {itemName} the final grocery-list display string
 * aggregateScaledIngredients(mealIngredients) — one ScaledIngredient[] per meal in, one deduped/
 *   summed AggregatedIngredient[] out, in first-seen order
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { ScaledIngredient } from './recipeIngredientSchema.js';
import { formatAmount } from './scaleIngredients.js';

export interface AggregatedIngredient {
  itemName: string;
}

interface AggregateEntry {
  item: string;
  unit: string | null;
  amount: number | null;
  scalable: boolean;
}

export function aggregateScaledIngredients(mealIngredients: ScaledIngredient[][]): AggregatedIngredient[] {
  const byKey = new Map<string, AggregateEntry>();
  const order: string[] = [];

  for (const ingredients of mealIngredients) {
    for (const ing of ingredients) {
      const key =
        ing.scalable && ing.unit ? `${ing.item.toLowerCase()}|${ing.unit.toLowerCase()}` : ing.item.toLowerCase();

      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { item: ing.item, unit: ing.unit, amount: ing.amount, scalable: ing.scalable });
        order.push(key);
      } else if (existing.scalable && ing.scalable && existing.amount !== null && ing.amount !== null) {
        existing.amount += ing.amount;
      }
      // else: not summable (unit/scalability mismatch under the same key) — first-seen wins
    }
  }

  return order.map((key) => {
    const entry = byKey.get(key)!;
    if (entry.scalable && entry.amount !== null) {
      const display = formatAmount(entry.amount);
      return { itemName: entry.unit ? `${display} ${entry.unit} ${entry.item}` : `${display} ${entry.item}` };
    }
    return { itemName: entry.item };
  });
}
