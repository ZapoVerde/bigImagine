/**
 * @file plugins/recipes/src/deleteRecipeTool.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — deletes a recipe
 * @description
 * meal_plan_entries.recipe_id and shopping_logs.recipe_id both reference recipes_meals with no
 * cascade (db/migrations/0002_schema.sql, 0006_recipes_mealplan.sql — default RESTRICT), so a
 * bare delete would fail at the DB level with an opaque FK error. This tool checks both first and
 * throws a descriptive error naming what's still referencing the recipe — the recipe must be
 * removed from the meal plan (and any shopping log) before it can be deleted, it is never
 * cascade-deleted out from under those records.
 *
 * @api-declaration
 * createDeleteRecipeTool() — returns the delete_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

function isDeleteRecipeArgs(value: unknown): value is { recipe_id: string } {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v.recipe_id === 'string' && v.recipe_id !== '';
}

export function createDeleteRecipeTool(): RegisteredTool {
  return {
    definition: {
      name: 'delete_recipe',
      description:
        'Delete a recipe by id. Fails with a descriptive error if the recipe is still planned on the meal plan or referenced by a shopping log entry.',
      parameters: {
        type: 'object',
        properties: {
          recipe_id: { type: 'string', description: 'The recipe to delete, from create_recipe/import_recipe/get_recipe(s).' },
        },
        required: ['recipe_id'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isDeleteRecipeArgs(args)) {
        throw new Error('delete_recipe requires a recipe_id: string argument');
      }

      const plannedDates = await ctx.db.query<{ planned_date: string }>(
        'select planned_date from meal_plan_entries where recipe_id = $1 and user_id = $2',
        [args.recipe_id, ctx.userId],
      );
      if (plannedDates.length > 0) {
        const dates = plannedDates.map((r) => r.planned_date).join(', ');
        throw new Error(`delete_recipe: still planned on the meal plan (${dates}) — remove it from the meal plan first`);
      }

      const shoppingLogCount = await ctx.db.query<{ count: string }>(
        'select count(*)::text as count from shopping_logs where recipe_id = $1 and user_id = $2',
        [args.recipe_id, ctx.userId],
      );
      const logCount = Number(shoppingLogCount[0]?.count ?? '0');
      if (logCount > 0) {
        throw new Error(`delete_recipe: still referenced by ${logCount} shopping log entr${logCount === 1 ? 'y' : 'ies'}`);
      }

      const [row] = await ctx.db.query<{ recipe_id: string; meal_name: string }>(
        'delete from recipes_meals where recipe_id = $1 and user_id = $2 returning recipe_id, meal_name',
        [args.recipe_id, ctx.userId],
      );
      return { deleted: row !== undefined, mealName: row?.meal_name };
    },
  };
}
