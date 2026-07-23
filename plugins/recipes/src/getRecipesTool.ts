/**
 * @file plugins/recipes/src/getRecipesTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — lists a user's recipe library
 * @description
 * Summary rows only (no ingredients/instructions) — this is what the reasoning LLM calls to see
 * "what recipes do I have" before deciding what to plan or answer a question, not a per-recipe
 * detail view (that's get_recipe). Optional tag filter narrows it (e.g. "quick dinner options").
 *
 * @api-declaration
 * createGetRecipesTool() — returns the get_recipes RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface GetRecipesArgs {
  tag?: string;
}

function isGetRecipesArgs(value: unknown): value is GetRecipesArgs {
  if (typeof value !== 'object' || value === null) return true; // no args is valid ({} handled below)
  const v = value as Record<string, unknown>;
  return v.tag === undefined || typeof v.tag === 'string';
}

export function createGetRecipesTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_recipes',
      description: 'List recipes in the recipe library, optionally filtered by tag (cuisine/category).',
      parameters: {
        type: 'object',
        properties: {
          tag: { type: 'string', description: 'Only return recipes with this tag (case-insensitive).' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetRecipesArgs(args)) {
        throw new Error('get_recipes: tag, if given, must be a string');
      }
      const tag = (args as GetRecipesArgs).tag;

      const rows = await ctx.db.query<{
        recipe_id: string;
        meal_name: string;
        tags: string[];
        prep_time: string | null;
        cook_time: string | null;
        servings: string | null;
      }>(
        tag
          ? `select recipe_id, meal_name, tags, prep_time, cook_time, servings from recipes_meals
             where user_id = $1 and exists (select 1 from unnest(tags) t where lower(t) = lower($2))
             order by meal_name`
          : `select recipe_id, meal_name, tags, prep_time, cook_time, servings from recipes_meals
             where user_id = $1 order by meal_name`,
        tag ? [ctx.userId, tag] : [ctx.userId],
      );

      return rows.map((r) => ({
        recipeId: r.recipe_id,
        mealName: r.meal_name,
        tags: r.tags,
        prepTime: r.prep_time,
        cookTime: r.cook_time,
        servings: r.servings,
      }));
    },
  };
}
