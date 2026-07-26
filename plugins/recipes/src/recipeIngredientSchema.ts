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
 * modifier (added after the initial structuring pass shipped) separates a prep instruction — what
 * to do to the ingredient before using it — from item, so "garlic, peeled and smashed" doesn't
 * leave "peeled and smashed" stuck inside item where it reads oddly once amount/unit are pulled
 * out ("1 head | garlic, peeled and smashed" vs. today's "1 | garlic, peeled and smashed").
 *
 * CURRENT_STRUCTURE_VERSION (db/migrations/0028_ingredient_structure_version.sql's
 * recipes_meals.ingredient_structure_version) is the authoritative "does this recipe's structuring
 * reflect the latest contract" signal — ensureStructuredIngredients.ts compares a recipe's stored
 * version against this constant and re-structures if it's behind (or null, meaning it predates
 * versioning entirely). This replaced an earlier ad hoc trick of checking whether a specific field
 * (originally modifier) was present at all — that only ever catches one contract change; a real
 * version number keeps working for however many more there end up being. isRecipeIngredient's
 * shape validation is a separate, complementary check: it catches structurally malformed data
 * regardless of version, but the version number is what actually decides whether it's time to
 * re-run the LLM pass.
 *
 * @api-declaration
 * RecipeIngredient — {raw, amount, unit, item, modifier, scalable}, the structured shape
 * ScaledIngredient — RecipeIngredient + amountDisplay (fraction-formatted, scaling's own output)
 * CURRENT_STRUCTURE_VERSION — bump whenever the structuring contract changes (a new field, a new
 *   normalization pass) so ensureStructuredIngredients.ts knows to re-run existing recipes once
 * isRecipeIngredient(value) — validates one structured ingredient, including the
 *   amount===null <=> scalable===false pairing scaleIngredients.ts trusts without re-deriving
 * isLegacyIngredients(value) — true if this is a pre-structuring bare-string ingredients array
 * isStructuredIngredients(value) — true if every element is already a (fully current-shape)
 *   RecipeIngredient — false for both legacy strings and pre-modifier structured rows alike
 * normalizeLegacyIngredient(raw) — wraps one legacy string line into the structured shape for
 *   display, without claiming to have parsed it (amount/unit/modifier null, scalable false)
 * rawLineOf(value) — the original text of one ingredients[] element regardless of which of the
 *   three shapes (legacy string / pre-modifier structured / current structured) it's currently in
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export const CURRENT_STRUCTURE_VERSION = 1;

export interface RecipeIngredient {
  raw: string;
  amount: number | null;
  unit: string | null;
  item: string;
  modifier: string | null;
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
  if (v.modifier !== null && typeof v.modifier !== 'string') return false;
  return (v.amount === null) === (v.scalable === false);
}

export function isLegacyIngredients(value: unknown[]): value is string[] {
  return value.length === 0 || typeof value[0] === 'string';
}

export function isStructuredIngredients(value: unknown[]): value is RecipeIngredient[] {
  return value.length > 0 && value.every(isRecipeIngredient);
}

export function normalizeLegacyIngredient(raw: string): RecipeIngredient {
  return { raw, amount: null, unit: null, item: raw, modifier: null, scalable: false };
}

export function rawLineOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null && typeof (value as Record<string, unknown>).raw === 'string') {
    return (value as Record<string, unknown>).raw as string;
  }
  return String(value);
}
