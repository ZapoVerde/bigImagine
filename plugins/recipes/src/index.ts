/**
 * @file plugins/recipes/src/index.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plugin package entry point
 * @description
 * The contract orchestrator/pluginLoader.ts expects (same as document-ingestion, shopping-
 * analytics, lists): an `info` object and an async `registerTools`. import_recipe needs
 * deps.llm (the LLM-extraction fallback path); generate_shopping_list_from_meal_plan needs both
 * deps.llm (best-effort section classification, classifySection.ts) and deps.notion (best-effort
 * outbound sync of the list items it creates — undefined when Notion isn't configured, same as
 * every other Notion-touching tool in this codebase). The read/plan tools (get_recipes,
 * get_recipe, add_meal_plan_entry, get_meal_plan) only need ctx.db/ctx.userId, supplied per-call,
 * so they take no constructor deps at all.
 *
 * @api-declaration
 * info — plugin identity
 * registerTools(deps) — returns [import_recipe, get_recipes, get_recipe, add_meal_plan_entry,
 *   get_meal_plan, generate_shopping_list_from_meal_plan]
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
import { createGetRecipesTool } from './getRecipesTool.js';
import { createGetRecipeTool } from './getRecipeTool.js';
import { createAddMealPlanEntryTool } from './addMealPlanEntryTool.js';
import { createGetMealPlanTool } from './getMealPlanTool.js';
import { createGenerateShoppingListFromMealPlanTool } from './shoppingListFromMealPlanTool.js';

export const info = {
  id: 'recipes',
  name: 'Recipes & Meal Planning',
  description: 'Create/import recipes, plan meals by date, and generate a shopping list from the meal plan.',
};

export async function registerTools(deps: PluginDeps): Promise<RegisteredTool[]> {
  return [
    createImportRecipeTool(deps.llm),
    createGetRecipesTool(),
    createGetRecipeTool(),
    createAddMealPlanEntryTool(),
    createGetMealPlanTool(),
    createGenerateShoppingListFromMealPlanTool(deps.llm, deps.notion),
  ];
}
