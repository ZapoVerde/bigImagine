/**
 * @file plugins/recipes/src/convertIngredientUnitsToMetric.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — converts a fixed set of imperial units to metric
 * @description
 * The deterministic-arithmetic half of unit normalization (bb_principles.md §2: the LLM reasons,
 * nothing else does — multiplying by a conversion factor is exactly the kind of thing the LLM must
 * never be asked to do). structureIngredientsWithLlm.ts's LLM call already decides *which* unit a
 * line is written in (including the weight-vs-fluid-ounce judgment call); this function only ever
 * does the fixed multiplication once that decision is made.
 *
 * Scope decided directly by the household: teaspoon/tablespoon/cup/pinch stay imperial forever
 * (kitchens actually own those as physical measuring tools) — everything else in the dispatch
 * table below converts, including "stick" (of butter), which is a discrete/purchasable unit like
 * "a can of tomatoes" but standardized enough (1 stick = 113g) to be worth converting anyway, since
 * the stick-to-tablespoon mental math is exactly the kind of friction this feature exists to
 * remove. Always converts all the way down to the base unit (gram or milliliter) — never stores
 * kilogram/liter directly; whether to *display* something as kg/L instead of g/mL is a separate,
 * display-only decision (formatIngredientAmount.ts).
 *
 * Depends on structureIngredientsWithLlm.ts's prompt asking for exact canonical spellings for the
 * units in CONVERSION_TABLE — dispatches on exact string match (case/whitespace-normalized
 * defensively) rather than fuzzy-parsing "Tbsp"/"tbsp."/"tablespoons". A unit outside this fixed
 * vocabulary (a count unit like "clove", or one of the kept imperial-volume units) passes through
 * completely unchanged — this function only ever touches the units it explicitly recognizes.
 *
 * @api-declaration
 * convertIngredientUnitsToMetric(ingredient) — returns a new RecipeIngredient with amount/unit
 *   converted if unit is in the table and amount is non-null; otherwise returns the ingredient
 *   unchanged
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

import type { RecipeIngredient } from './recipeIngredientSchema.js';

interface ConversionTarget {
  factor: number;
  unit: 'gram' | 'milliliter';
}

// Canonical spellings structureIngredientsWithLlm.ts's prompt asks the model to use for these
// units. Factors: US customary -> metric, standard values.
const CONVERSION_TABLE: Record<string, ConversionTarget> = {
  ounce: { factor: 28.3495, unit: 'gram' },
  pound: { factor: 453.592, unit: 'gram' },
  stick: { factor: 113.398, unit: 'gram' },
  'fluid ounce': { factor: 29.5735, unit: 'milliliter' },
  quart: { factor: 946.353, unit: 'milliliter' },
  pint: { factor: 473.176, unit: 'milliliter' },
  gallon: { factor: 3785.41, unit: 'milliliter' },
};

export function convertIngredientUnitsToMetric(ingredient: RecipeIngredient): RecipeIngredient {
  if (ingredient.amount === null || ingredient.unit === null) return ingredient;

  const target = CONVERSION_TABLE[ingredient.unit.trim().toLowerCase()];
  if (!target) return ingredient;

  return { ...ingredient, amount: ingredient.amount * target.factor, unit: target.unit };
}
