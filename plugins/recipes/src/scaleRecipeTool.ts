/**
 * @file plugins/recipes/src/scaleRecipeTool.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — scales a recipe's ingredients to a target serving count
 * @description
 * The one place scaling math is invoked from (scaleIngredients.ts does the actual arithmetic) —
 * reused by RecipesView's scale control and by generate_shopping_list_from_meal_plan (each planned
 * meal's own ratio). target_servings is optional: when omitted, resolves the household-wide
 * default_recipe_servings setting (orchestratorSettings.ts, "always show recipes scaled for 6"),
 * falling back further to the recipe's own base_servings (ratio 1, unscaled) if no default is set
 * either — same live-read-per-call shape household_timezone already uses, so changing the default
 * in Settings takes effect immediately. Structures the recipe first if it's still legacy or missing
 * a base_servings (ensureStructuredIngredients.ts) — a recipe scaled for the first time pays that
 * one-time cost, every scale after is pure arithmetic against the cached structure.
 *
 * @api-declaration
 * createScaleRecipeTool(llm, settings) — returns the scale_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, LLM call on first
 *                      structuring only, reads orchestrator_settings live)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), LLM, orchestrator_settings (via settings)]
 */

import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { ensureStructuredIngredients } from './ensureStructuredIngredients.js';
import { scaleIngredients } from './scaleIngredients.js';

type OrchestratorSettingsStore = PluginDeps['settings'];

interface ScaleRecipeArgs {
  meal_name: string;
  target_servings?: number;
}

function isScaleRecipeArgs(value: unknown): value is ScaleRecipeArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.meal_name !== 'string' || v.meal_name === '') return false;
  return v.target_servings === undefined || (typeof v.target_servings === 'number' && v.target_servings > 0);
}

export function createScaleRecipeTool(llm: LlmProvider, settings: OrchestratorSettingsStore): RegisteredTool {
  return {
    definition: {
      name: 'scale_recipe',
      description:
        "Scale a recipe's ingredient amounts to a target serving count. Omit target_servings to use the household's default scale (Settings tab) or the recipe's own serving count.",
      parameters: {
        type: 'object',
        properties: {
          meal_name: { type: 'string', description: 'The recipe name (matched the same way get_recipe matches).' },
          target_servings: {
            type: 'number',
            description: 'The desired serving count. Omit to use the household default or the recipe as written.',
          },
        },
        required: ['meal_name'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isScaleRecipeArgs(args)) {
        throw new Error('scale_recipe requires a non-empty meal_name: string, and target_servings, if given, must be a positive number');
      }

      const rows = await ctx.db.query<{
        recipe_id: string;
        meal_name: string;
        ingredients: unknown[];
        servings: string | null;
        base_servings: number | null;
        ingredient_structure_version: number | null;
      }>(
        `select recipe_id, meal_name, ingredients, servings, base_servings, ingredient_structure_version
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

      const structured = await ensureStructuredIngredients(ctx.db, llm, {
        recipeId: recipe.recipe_id,
        ingredients: recipe.ingredients,
        servings: recipe.servings,
        baseServings: recipe.base_servings,
        ingredientStructureVersion: recipe.ingredient_structure_version,
      });

      if (structured.baseServings === null) {
        return {
          found: true,
          scaled: false,
          reason: 'recipe has no discoverable serving count to scale from',
          recipeId: recipe.recipe_id,
          mealName: recipe.meal_name,
        };
      }

      let targetServings = args.target_servings;
      if (targetServings === undefined) {
        const defaultSetting = await settings.get('default_recipe_servings');
        const parsedDefault = defaultSetting === undefined ? NaN : Number(defaultSetting);
        targetServings = Number.isFinite(parsedDefault) ? parsedDefault : structured.baseServings;
      }

      const ratio = targetServings / structured.baseServings;
      const ingredients = scaleIngredients(structured.ingredients, ratio);

      return {
        found: true,
        scaled: true,
        recipeId: recipe.recipe_id,
        mealName: recipe.meal_name,
        baseServings: structured.baseServings,
        targetServings,
        ingredients,
      };
    },
  };
}
