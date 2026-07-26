/**
 * @file plugins/recipes/src/updateRecipeTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — edits a recipe's fields
 * @description
 * Only the fields actually supplied are changed — same "build the SET clause from present keys"
 * approach as updateNoteTool.ts/updateCalendarEventTool.ts — so revising a recipe mid-conversation
 * ("swap the flour for almond flour", "add a step") doesn't require resending the whole thing.
 * Identified by recipe_id (from create_recipe/import_recipe/get_recipe), not meal_name, so an
 * in-progress rename can't collide with get_recipe's fuzzy name match.
 *
 * An `ingredients` edit is always bare lines on the wire (same as create_recipe/import_recipe —
 * a manual edit is honest text, not yet re-interpreted) and, stored as-is, reverts the row to
 * legacy shape: it's re-structured lazily next time it's scaled/shopped
 * (ensureStructuredIngredients.ts), rather than silently re-inferring it inline here, per
 * bb_principles.md §3 (explicit signal outranks inferred). A `servings` edit nulls out
 * `base_servings` too, even if `ingredients` isn't also touched — otherwise a stale numeric base
 * would silently miscompute scaling ratios against a serving count that no longer matches the
 * displayed text.
 *
 * isFavorite is a plain boolean, not a rating — the sidebar star toggle (RecipesBrowser.tsx) calls
 * this tool directly (same as get_recipe/scale_recipe do from RecipesView.tsx) rather than needing
 * a dedicated tool, since it's just one more field in the same "only supplied fields change" set.
 *
 * @api-declaration
 * createUpdateRecipeTool() — returns the update_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { isRecipeInstruction } from './recipeSchema.js';
import { isStructuredIngredients, normalizeLegacyIngredient, type RecipeIngredient } from './recipeIngredientSchema.js';

interface UpdateRecipeArgs {
  recipe_id: string;
  mealName?: string;
  ingredients?: string[];
  instructions?: unknown[];
  tags?: string[];
  prepTime?: string;
  cookTime?: string;
  servings?: string;
  isFavorite?: boolean;
}

function isUpdateRecipeArgs(value: unknown): value is UpdateRecipeArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.recipe_id !== 'string' || v.recipe_id === '') return false;
  if (v.ingredients !== undefined && !(Array.isArray(v.ingredients) && v.ingredients.every((i) => typeof i === 'string'))) return false;
  if (v.instructions !== undefined && !(Array.isArray(v.instructions) && v.instructions.every(isRecipeInstruction))) return false;
  if (v.tags !== undefined && !(Array.isArray(v.tags) && v.tags.every((t) => typeof t === 'string'))) return false;
  if (v.isFavorite !== undefined && typeof v.isFavorite !== 'boolean') return false;
  return true;
}

interface RecipeRow {
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
}

export function createUpdateRecipeTool(): RegisteredTool {
  return {
    definition: {
      name: 'update_recipe',
      description: "Edit a recipe's fields. Only the fields provided are changed.",
      parameters: {
        type: 'object',
        properties: {
          recipe_id: { type: 'string', description: 'The recipe to edit (from create_recipe/import_recipe/get_recipe).' },
          mealName: { type: 'string' },
          ingredients: { type: 'array', items: { type: 'string' } },
          instructions: {
            type: 'array',
            items: {
              oneOf: [
                { type: 'string' },
                {
                  type: 'object',
                  properties: {
                    section: { type: 'string' },
                    steps: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['section', 'steps'],
                  additionalProperties: false,
                },
              ],
            },
          },
          tags: { type: 'array', items: { type: 'string' } },
          prepTime: { type: 'string' },
          cookTime: { type: 'string' },
          servings: { type: 'string' },
          isFavorite: { type: 'boolean', description: 'Mark or unmark this recipe as a favorite.' },
        },
        required: ['recipe_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isUpdateRecipeArgs(args)) {
        throw new Error('update_recipe requires a recipe_id: string, with any provided fields well-formed');
      }
      const sets: string[] = [];
      const params: unknown[] = [args.recipe_id, ctx.userId];
      const push = (column: string, value: unknown) => {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      };
      if (args.mealName !== undefined) push('meal_name', args.mealName);
      if (args.ingredients !== undefined) push('ingredients', JSON.stringify(args.ingredients));
      if (args.instructions !== undefined) push('instructions', JSON.stringify(args.instructions));
      if (args.tags !== undefined) push('tags', args.tags);
      if (args.prepTime !== undefined) push('prep_time', args.prepTime);
      if (args.cookTime !== undefined) push('cook_time', args.cookTime);
      if (args.servings !== undefined) push('servings', args.servings);
      if (args.isFavorite !== undefined) push('is_favorite', args.isFavorite);
      // A bare-lines ingredients edit reverts the row to legacy shape on its own (it's just a
      // string[] write). base_servings needs an explicit null-out on either edit, though — an
      // ingredients edit means the old structure/base no longer describes what's stored, and a
      // servings edit means the old numeric base no longer matches the displayed text.
      if (args.ingredients !== undefined || args.servings !== undefined) push('base_servings', null);

      if (sets.length === 0) {
        throw new Error('update_recipe requires at least one field to change');
      }

      const [row] = await ctx.db.query<RecipeRow>(
        `update recipes_meals set ${sets.join(', ')} where recipe_id = $1 and user_id = $2
         returning recipe_id, meal_name, ingredients, instructions, tags, prep_time, cook_time, servings, base_servings, is_favorite`,
        params,
      );
      if (!row) return { found: false, recipeId: args.recipe_id };
      const ingredients: RecipeIngredient[] = isStructuredIngredients(row.ingredients)
        ? row.ingredients
        : (row.ingredients as string[]).map(normalizeLegacyIngredient);
      return {
        found: true,
        recipeId: row.recipe_id,
        mealName: row.meal_name,
        ingredients,
        instructions: row.instructions,
        tags: row.tags,
        baseServings: row.base_servings,
        prepTime: row.prep_time,
        cookTime: row.cook_time,
        servings: row.servings,
        isFavorite: row.is_favorite,
      };
    },
  };
}
