/**
 * @file plugins/recipes/src/importRecipeTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — the Recipes plugin's create/import tool
 * @description
 * One tool, two entry paths: a `url` (fetched, then parsed deterministically via
 * schemaOrgRecipeParser.ts, falling back to extractRecipeWithLlm.ts only if that finds nothing
 * usable) or `raw_text` (pasted recipe text, straight to the LLM path — there's no markup to look
 * for). Cheap-and-precise before expensive-and-fuzzy, same ordering principle as the write-time
 * hint / inference fallback elsewhere in the platform (docs/spec.md §4).
 *
 * A browser-shaped User-Agent is set on the fetch: verified live that at least one real recipe
 * site's response differs based on this (a bare Node fetch is a plausible bot-block target even
 * for public pages), so this isn't defensive-for-no-reason.
 *
 * `url` is the one fetch target in the platform that's LLM/chat-supplied rather than
 * admin-configured, so it goes through fetchUntrustedUrl (orchestrator/src/io/fetchUntrusted.ts)
 * rather than the plain fetchWithRetry other IO wrappers use — a prompt-injected page could
 * otherwise steer this tool at an internal address on the same Docker network.
 *
 * After insert, ingredients are structured best-effort (structureNewRecipeBestEffort,
 * ensureStructuredIngredients.ts) — gives RecipesView's just-created validation moment something
 * real to show, and a failure never blocks the import (recipe stays legacy, backfilled lazily on
 * first scale/shopping-list use).
 *
 * @api-declaration
 * createImportRecipeTool(llm) — returns the import_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (network fetch, LLM call, Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [whatever URL is passed, LLM, Postgres (via the DbSession it's given)]
 */

import { fetchUntrustedUrl } from '@bigbrain/orchestrator/fetch-untrusted';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { htmlToText } from './htmlToText.js';
import { extractRecipeWithLlm } from './extractRecipeWithLlm.js';
import { structureNewRecipeBestEffort } from './ensureStructuredIngredients.js';
import { extractSchemaOrgRecipe } from './schemaOrgRecipeParser.js';
import type { ParsedRecipe } from './recipeSchema.js';

const FETCH_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

interface ImportRecipeArgs {
  url?: string;
  raw_text?: string;
}

function isImportRecipeArgs(value: unknown): value is ImportRecipeArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  const url = v.url === undefined ? undefined : typeof v.url === 'string' && v.url !== '' ? v.url : null;
  const rawText = v.raw_text === undefined ? undefined : typeof v.raw_text === 'string' && v.raw_text !== '' ? v.raw_text : null;
  if (url === null || rawText === null) return false; // present but wrong type/empty
  return Boolean(url) !== Boolean(rawText); // exactly one of the two
}

async function resolveRecipe(llm: LlmProvider, args: ImportRecipeArgs): Promise<ParsedRecipe> {
  if (args.raw_text) {
    return extractRecipeWithLlm(llm, args.raw_text);
  }

  const response = await fetchUntrustedUrl(args.url!, { headers: { 'User-Agent': FETCH_USER_AGENT } });
  if (!response.ok) {
    throw new Error(`import_recipe: fetching ${args.url} returned HTTP ${response.status}`);
  }
  const html = await response.text();

  const structured = extractSchemaOrgRecipe(html);
  if (structured) return structured;

  return extractRecipeWithLlm(llm, htmlToText(html));
}

export function createImportRecipeTool(llm: LlmProvider): RegisteredTool {
  return {
    definition: {
      name: 'import_recipe',
      description:
        'Create a recipe from either a URL (fetched and parsed automatically) or pasted raw recipe text. Provide exactly one of url or raw_text.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'A URL to a recipe page.' },
          raw_text: { type: 'string', description: 'Pasted recipe text (ingredients + instructions).' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isImportRecipeArgs(args)) {
        throw new Error('import_recipe requires exactly one of url or raw_text: non-empty string');
      }

      const recipe = await resolveRecipe(llm, args);

      const rows = await ctx.db.query<{ recipe_id: string }>(
        `insert into recipes_meals (user_id, meal_name, ingredients, instructions, tags, prep_time, cook_time, servings, source_url)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning recipe_id`,
        [
          ctx.userId,
          recipe.mealName,
          JSON.stringify(recipe.ingredients),
          JSON.stringify(recipe.instructions),
          recipe.tags,
          recipe.prepTime ?? null,
          recipe.cookTime ?? null,
          recipe.servings ?? null,
          args.url ?? null,
        ],
      );

      const recipeId = rows[0]!.recipe_id;
      await structureNewRecipeBestEffort(ctx.db, llm, recipeId, recipe.ingredients, recipe.servings ?? null);

      return {
        recipeId,
        mealName: recipe.mealName,
        ingredientCount: recipe.ingredients.length,
        tags: recipe.tags,
      };
    },
  };
}
