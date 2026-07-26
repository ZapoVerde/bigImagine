/**
 * @file plugins/recipes/src/getRecipeTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — reads one full recipe by name
 * @description
 * The detail view: full ingredients + instructions for one recipe, matched by case-insensitive
 * name (matching lists' findOrCreateList lookup convention — chat callers give a name, not a
 * uuid). Ambiguous/no match is a normal, expected outcome (not an error) so the model can tell the
 * user "couldn't find that" or ask which one they meant, rather than the tool call failing.
 *
 * Never triggers ingredient structuring — reading a recipe stays free/instant regardless of
 * whether it's been scaled/shopped-from yet. A legacy (pre-feature or reverted-by-edit) row is
 * normalized on the fly for the response only (normalizeLegacyIngredient,
 * recipeIngredientSchema.ts) so the response shape is always RecipeIngredient[], without
 * persisting anything or calling the LLM — that only happens via scale_recipe/
 * generate_shopping_list_from_meal_plan (ensureStructuredIngredients.ts).
 *
 * @api-declaration
 * createGetRecipeTool() — returns the get_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { isStructuredIngredients, normalizeLegacyIngredient, type RecipeIngredient } from './recipeIngredientSchema.js';

function isGetRecipeArgs(value: unknown): value is { meal_name: string } {
  const v = value as Record<string, unknown>;
  return typeof value === 'object' && value !== null && typeof v.meal_name === 'string' && v.meal_name !== '';
}

export function createGetRecipeTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_recipe',
      description: 'Get the full ingredients and instructions for one recipe by name.',
      parameters: {
        type: 'object',
        properties: {
          meal_name: { type: 'string', description: 'The recipe name (or a close match to search for).' },
        },
        required: ['meal_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetRecipeArgs(args)) {
        throw new Error('get_recipe requires a non-empty meal_name: string argument');
      }

      const rows = await ctx.db.query<{
        recipe_id: string;
        meal_name: string;
        ingredients: unknown[];
        instructions: unknown[];
        tags: string[];
        prep_time: string | null;
        cook_time: string | null;
        servings: string | null;
        base_servings: number | null;
        is_favorite: boolean;
      }>(
        `select recipe_id, meal_name, ingredients, instructions, tags, prep_time, cook_time, servings, base_servings, is_favorite
         from recipes_meals
         where user_id = $1 and lower(meal_name) like lower($2)
         order by (lower(meal_name) = lower($3)) desc, meal_name
         limit 1`,
        [ctx.userId, `%${args.meal_name}%`, args.meal_name],
      );

      const recipe = rows[0];
      if (!recipe) {
        return { found: false, mealName: args.meal_name };
      }

      const ingredients: RecipeIngredient[] = isStructuredIngredients(recipe.ingredients)
        ? recipe.ingredients
        : (recipe.ingredients as string[]).map(normalizeLegacyIngredient);

      return {
        found: true,
        recipeId: recipe.recipe_id,
        mealName: recipe.meal_name,
        ingredients,
        instructions: recipe.instructions,
        tags: recipe.tags,
        prepTime: recipe.prep_time,
        cookTime: recipe.cook_time,
        servings: recipe.servings,
        baseServings: recipe.base_servings,
        isFavorite: recipe.is_favorite,
      };
    },
  };
}
