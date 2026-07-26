/**
 * @file plugins/recipes/src/ensureStructuredIngredients.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — lazily structures + persists a recipe's ingredients if needed
 * @description
 * Shared by scaleRecipeTool.ts and shoppingListFromMealPlanTool.ts — the two tools that actually
 * need real numbers and can't just display raw text. create_recipe/import_recipe already structure
 * eagerly (best-effort) right after insert, so this is the backfill path: for a recipe that
 * predates this feature, or whose ingredients were reverted to legacy shape by a manual
 * update_recipe edit, this runs the one LLM structuring call and persists the result so it only
 * ever runs once per recipe. Same-plugin sharing (precedent: plugins/lists/src/listLookup.ts, used
 * by four sibling tools) — only cross-plugin duplication is this codebase's deliberate convention,
 * see shoppingListFromMealPlanTool.ts's own docstring.
 *
 * Unlike the eager creation-time call, ensureStructuredIngredients is NOT best-effort: a caller
 * reaching here has nothing to scale/aggregate without a result, so a structuring failure
 * propagates rather than being logged and swallowed. structureNewRecipeBestEffort is the opposite
 * shape, used only by create_recipe/import_recipe right after insert: a fresh recipe should never
 * fail to be created just because the structuring pass had a hiccup, so it logs and leaves the
 * recipe in legacy shape instead — same best-effort convention shoppingListFromMealPlanTool.ts's
 * section classification already uses. It never needs the "already structured?" check
 * ensureStructuredIngredients does, since a recipe that was just inserted from raw lines is always
 * legacy.
 *
 * @api-declaration
 * ensureStructuredIngredients(db, llm, recipe) -> {ingredients, baseServings} — recipes that are
 *   already structured, resolved, AND on CURRENT_STRUCTURE_VERSION (recipeIngredientSchema.ts) are
 *   returned as-is with no LLM call; anything else (never structured, stale contract version, or
 *   missing base_servings) is structured and persisted before returning; throws on structuring
 *   failure
 * structureNewRecipeBestEffort(db, llm, recipeId, ingredients, servings) -> void — structures and
 *   persists a freshly-created recipe's ingredients; logs and returns (recipe stays legacy) on
 *   failure instead of throwing
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, LLM call)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), LLM]
 */

import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import { log } from '@bigbrain/orchestrator/logger';
import {
  CURRENT_STRUCTURE_VERSION,
  isStructuredIngredients,
  rawLineOf,
  type RecipeIngredient,
} from './recipeIngredientSchema.js';
import { structureIngredients } from './structureIngredientsWithLlm.js';

interface RecipeToStructure {
  recipeId: string;
  ingredients: unknown[];
  servings: string | null;
  baseServings: number | null;
  ingredientStructureVersion: number | null;
}

export async function ensureStructuredIngredients(
  db: DbSession,
  llm: LlmProvider,
  recipe: RecipeToStructure,
): Promise<{ ingredients: RecipeIngredient[]; baseServings: number | null }> {
  if (
    isStructuredIngredients(recipe.ingredients) &&
    recipe.baseServings !== null &&
    recipe.ingredientStructureVersion === CURRENT_STRUCTURE_VERSION
  ) {
    return { ingredients: recipe.ingredients, baseServings: recipe.baseServings };
  }

  // rawLineOf handles every possible shape uniformly: never-structured (bare strings), structured
  // under an older contract version, and the current shape with a stale/null base_servings — every
  // one of those has to fall back to re-deriving raw text from whatever's actually there rather
  // than assuming a shape isStructuredIngredients/the version check just rejected.
  const rawLines = recipe.ingredients.map(rawLineOf);

  const result = await structureIngredients(llm, rawLines, recipe.servings);

  await db.query(
    `update recipes_meals set ingredients = $1, base_servings = $2, ingredient_structure_version = $3 where recipe_id = $4`,
    [JSON.stringify(result.ingredients), result.baseServings, CURRENT_STRUCTURE_VERSION, recipe.recipeId],
  );

  return result;
}

export async function structureNewRecipeBestEffort(
  db: DbSession,
  llm: LlmProvider,
  recipeId: string,
  ingredients: string[],
  servings: string | null,
): Promise<void> {
  try {
    const result = await structureIngredients(llm, ingredients, servings);
    await db.query(
      `update recipes_meals set ingredients = $1, base_servings = $2, ingredient_structure_version = $3 where recipe_id = $4`,
      [JSON.stringify(result.ingredients), result.baseServings, CURRENT_STRUCTURE_VERSION, recipeId],
    );
  } catch (err) {
    log.error(`ingredient structuring failed for newly-created recipe ${recipeId} (recipe still created, ingredients left legacy — will be structured on first scale/shopping-list use)`, err);
  }
}
