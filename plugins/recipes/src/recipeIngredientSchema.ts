/**
 * @file plugins/recipes/src/recipeIngredientSchema.ts
 * @stamp 2026-07-26
 * @architectural-role Pure Function module — the structured ingredient shape + runtime validation
 * @description
 * recipeSchema.ts's ParsedRecipe.ingredients (extraction-time: raw lines, string[]) deliberately
 * stays flat — that decision is unchanged and still correct for the extraction step. This file
 * covers what happens *after* extraction: structureIngredientsWithLlm.ts turns those raw lines
 * into RecipeIngredient objects (one LLM judgment call, cached), and everything downstream
 * (scaleIngredients.ts, scale_recipe, the shopping-list aggregation) operates on this shape
 * instead. Kept in its own file rather than added to recipeSchema.ts so that file's existing
 * preamble — which argues, with a live citation, that ingredients should stay undecomposed
 * forever — doesn't end up contradicting itself.
 *
 * `ingredients` in the DB stays jsonb regardless: a legacy row (created before this feature, or
 * reverted to legacy by a manual update_recipe edit — see that file) holds a bare string[]: raw
 * lines never structured. isLegacyIngredients/normalizeLegacyIngredient exist so every read site
 * can treat the two shapes uniformly without a schema migration or a "structured: boolean" column
 * — the shape of the first element says which kind of row this is.
 *
 * @api-declaration
 * RecipeIngredient — {raw, amount, unit, item, scalable}, the structured shape
 * ScaledIngredient — RecipeIngredient + amountDisplay (fraction-formatted, scaling's own output)
 * isRecipeIngredient(value) — validates one structured ingredient, including the
 *   amount===null <=> scalable===false pairing scaleIngredients.ts trusts without re-deriving
 * isLegacyIngredients(value) — true if this is a pre-structuring bare-string ingredients array
 * isStructuredIngredients(value) — true if every element is already a RecipeIngredient
 * normalizeLegacyIngredient(raw) — wraps one legacy string line into the structured shape for
 *   display, without claiming to have parsed it (amount/unit null, scalable false)
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface RecipeIngredient {
  raw: string;
  amount: number | null;
  unit: string | null;
  item: string;
  scalable: boolean;
}

export interface ScaledIngredient extends RecipeIngredient {
  amountDisplay: string | null;
}

export function isRecipeIngredient(value: unknown): value is RecipeIngredient {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.raw !== 'string' || typeof v.item !== 'string' || typeof v.scalable !== 'boolean') return false;
  if (v.amount !== null && typeof v.amount !== 'number') return false;
  if (v.unit !== null && typeof v.unit !== 'string') return false;
  return (v.amount === null) === (v.scalable === false);
}

export function isLegacyIngredients(value: unknown[]): value is string[] {
  return value.length === 0 || typeof value[0] === 'string';
}

export function isStructuredIngredients(value: unknown[]): value is RecipeIngredient[] {
  return value.length > 0 && value.every(isRecipeIngredient);
}

export function normalizeLegacyIngredient(raw: string): RecipeIngredient {
  return { raw, amount: null, unit: null, item: raw, scalable: false };
}
