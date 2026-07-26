/**
 * @file plugins/recipes/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as document-ingestion, shopping-
 * analytics, lists): an `info` object and an async `registerTools`. import_recipe/create_recipe
 * need deps.llm (import's LLM-extraction fallback path, and both's best-effort post-insert
 * ingredient structuring, structureNewRecipeBestEffort). generate_shopping_list_from_meal_plan
 * needs deps.llm (section classification + lazy structuring backfill) and deps.notion
 * (best-effort outbound sync — undefined when Notion isn't configured, same as every other
 * Notion-touching tool in this codebase). scale_recipe needs deps.llm (lazy structuring backfill)
 * and deps.settings (the household default_recipe_servings, orchestratorSettings.ts). The
 * remaining read/write tools (get_recipes, get_recipe, update_recipe, add_meal_plan_entry,
 * get_meal_plan) only need ctx.db/ctx.userId, supplied per-call, so they take no constructor deps.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [import_recipe, create_recipe, get_recipes, get_recipe,
 *   update_recipe, add_meal_plan_entry, get_meal_plan, generate_shopping_list_from_meal_plan,
 *   scale_recipe]
 *
 * @contract
 *   assertions:
 *     purity:          impure (constructs tools that do IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { PluginDeps } from '@bigbrain/orchestrator/plugin-loader';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { createImportRecipeTool } from './importRecipeTool.js';
import { createCreateRecipeTool } from './createRecipeTool.js';
import { createGetRecipesTool } from './getRecipesTool.js';
import { createGetRecipeTool } from './getRecipeTool.js';
import { createUpdateRecipeTool } from './updateRecipeTool.js';
import { createAddMealPlanEntryTool } from './addMealPlanEntryTool.js';
import { createGetMealPlanTool } from './getMealPlanTool.js';
import { createGenerateShoppingListFromMealPlanTool } from './shoppingListFromMealPlanTool.js';
import { createScaleRecipeTool } from './scaleRecipeTool.js';

export const info = {
  id: 'recipes',
  name: 'Recipes & Meal Planning',
  description: 'Create/import recipes, plan meals by date, scale servings, and generate a shopping list from the meal plan.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createImportRecipeTool(deps.llm),
    createCreateRecipeTool(deps.llm),
    createGetRecipesTool(),
    createGetRecipeTool(),
    createUpdateRecipeTool(),
    createAddMealPlanEntryTool(),
    createGetMealPlanTool(),
    createGenerateShoppingListFromMealPlanTool(deps.llm, deps.notion),
    createScaleRecipeTool(deps.llm, deps.settings),
  ];
}
