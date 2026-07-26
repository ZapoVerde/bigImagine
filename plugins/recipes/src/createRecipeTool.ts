/**
 * @file plugins/recipes/src/createRecipeTool.ts
 * @stamp 2026-07-25
 * @architectural-role IO Wrapper — creates a recipe from structured fields given directly by the caller
 * @description
 * import_recipe (importRecipeTool.ts) exists for turning an unstructured source (a URL, pasted
 * text) into a recipe, which costs an LLM extraction call on the raw_text path since the caller
 * doesn't already have structured fields. When the conversational LLM has already worked out a
 * recipe's ingredients/instructions with the user turn by turn, it already has that structure —
 * routing it back through raw_text would mean flattening it to prose just to pay for a second,
 * lossier LLM call to re-derive the same structure. create_recipe skips that: the caller (the
 * orchestrating LLM) hands over the shape it already has and it's inserted as-is. Reuses
 * recipeSchema.ts's isParsedRecipe so this and import_recipe never validate the shape differently.
 * No source_url (nothing was fetched).
 *
 * After insert, ingredients are structured best-effort (structureNewRecipeBestEffort,
 * ensureStructuredIngredients.ts) — same reasoning as import_recipe: gives RecipesView's
 * just-created validation moment something real to show, and a failure never blocks the create.
 *
 * @api-declaration
 * createCreateRecipeTool(llm) — returns the create_recipe RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, best-effort LLM structuring call)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), LLM]
 */

import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { structureNewRecipeBestEffort } from './ensureStructuredIngredients.js';
import { isParsedRecipe, type ParsedRecipe } from './recipeSchema.js';

function toCandidateRecipe(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const v = value as Record<string, unknown>;
  // tags is optional on the wire (mirrors extractRecipeTool's "omit if none evident" allowance)
  // but isParsedRecipe requires the array to be present — default it before validating.
  if (v.tags === undefined) return { ...v, tags: [] };
  return value;
}

export function createCreateRecipeTool(llm: LlmProvider): RegisteredTool {
  return {
    definition: {
      name: 'create_recipe',
      description:
        'Create a recipe directly from structured fields you already have (e.g. one you just worked out with the user), rather than importing from a URL or pasted text.',
      parameters: {
        type: 'object',
        properties: {
          mealName: { type: 'string', description: 'The name of the dish.' },
          ingredients: {
            type: 'array',
            items: { type: 'string' },
            description: 'Each ingredient line verbatim, e.g. "2 cups flour" — do not split into quantity/unit/item.',
          },
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
            description:
              'Ordered steps. Use plain strings unless the recipe has clearly labeled stages, in which case group steps under {section, steps}.',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: 'Cuisine/category keywords, e.g. ["Italian", "Mains"]. Omit if none apply.',
          },
          prepTime: { type: 'string', description: 'Prep time as human text, e.g. "20 min". Omit if unknown.' },
          cookTime: { type: 'string', description: 'Cook time as human text, e.g. "40 min". Omit if unknown.' },
          servings: { type: 'string', description: 'Servings/yield as human text, e.g. "4-6". Omit if unknown.' },
        },
        required: ['mealName', 'ingredients', 'instructions'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      const candidate = toCandidateRecipe(args);
      if (!isParsedRecipe(candidate)) {
        throw new Error('create_recipe requires a mealName and at least one ingredient, with well-formed instructions/tags');
      }
      const recipe = candidate as ParsedRecipe;

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
          null,
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
