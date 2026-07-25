/**
 * @file plugins/recipes/src/recipeSchema.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module — shared recipe shape + runtime validation
 * @description
 * The one shape both import paths (schemaOrgRecipeParser.ts's deterministic parse and
 * extractRecipeWithLlm.ts's forced-schema fallback) produce, so importRecipeTool.ts's insert
 * code doesn't care which path a given recipe came through. Modeled on schema.org/Recipe
 * (verified live against a real recipetineats.com page's own JSON-LD) but deliberately narrower:
 * ingredients stay flat strings — schema.org itself doesn't decompose "3 chicken breasts
 * (300g/10oz each)" into qty/unit/item, so there's no reason bigBrain should either — and
 * nutrition/author/publish-date are dropped entirely since nothing here uses them.
 *
 * @api-declaration
 * ParsedRecipe — the shared shape
 * isParsedRecipe(value) — the minimum-viable check: a non-empty mealName and at least one
 *   ingredient. Everything else is optional and defaults to empty/undefined rather than failing.
 * isRecipeInstruction(value) — validates one instruction entry (a plain step, or a
 *   {section, steps} group), exported so a partial-field update (updateRecipeTool.ts) can validate
 *   just the instructions array without requiring a full ParsedRecipe.
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface RecipeInstructionSection {
  section: string;
  steps: string[];
}

export type RecipeInstruction = string | RecipeInstructionSection;

export interface ParsedRecipe {
  mealName: string;
  ingredients: string[];
  instructions: RecipeInstruction[];
  tags: string[];
  prepTime?: string;
  cookTime?: string;
  servings?: string;
}

export function isRecipeInstruction(value: unknown): value is RecipeInstruction {
  if (typeof value === 'string') return true;
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.section === 'string' && Array.isArray(v.steps) && v.steps.every((s) => typeof s === 'string');
}

export function isParsedRecipe(value: unknown): value is ParsedRecipe {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.mealName === 'string' &&
    v.mealName !== '' &&
    Array.isArray(v.ingredients) &&
    v.ingredients.length > 0 &&
    v.ingredients.every((i) => typeof i === 'string') &&
    Array.isArray(v.instructions) &&
    v.instructions.every(isRecipeInstruction) &&
    Array.isArray(v.tags) &&
    v.tags.every((t) => typeof t === 'string')
  );
}
