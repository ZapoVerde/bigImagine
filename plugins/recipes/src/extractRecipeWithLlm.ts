/**
 * @file plugins/recipes/src/extractRecipeWithLlm.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — forced-schema LLM call, the recipe-import fallback path
 * @description
 * Mirrors document-ingestion's classifyNote.ts pattern exactly: a forced tool call
 * (LlmCompleteOptions.forceTool) against one extract_recipe definition, so the model can't reply
 * with prose. Used by importRecipeTool.ts whenever schemaOrgRecipeParser.ts finds nothing usable
 * — a source with no structured markup (pasted text, a photo transcribed by hand, a page that
 * simply doesn't embed it) — so bigBrain never fails an import just because a site skipped SEO
 * markup, it just costs an LLM call instead of a free parse.
 *
 * @api-declaration
 * extractRecipeWithLlm(llm, sourceText) — throws if the model doesn't call extract_recipe, or
 *   calls it with a malformed payload, rather than returning a partially-guessed recipe
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';
import { isParsedRecipe, type ParsedRecipe } from './recipeSchema.js';

const extractRecipeTool: ToolDefinition = {
  name: 'extract_recipe',
  description: 'Extract a structured recipe from raw text (a pasted recipe, or a recipe page\'s text content).',
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
          'Ordered steps. Use plain strings unless the recipe has clearly labeled stages (e.g. "Sauce:", "Assembly:"), in which case group steps under {section, steps}.',
      },
      tags: {
        type: 'array',
        items: { type: 'string' },
        description: 'Cuisine/category keywords, e.g. ["Italian", "Mains"]. Empty array if none are evident.',
      },
      prepTime: { type: 'string', description: 'Prep time as human text, e.g. "20 min". Omit if unknown.' },
      cookTime: { type: 'string', description: 'Cook time as human text, e.g. "40 min". Omit if unknown.' },
      servings: { type: 'string', description: 'Servings/yield as human text, e.g. "4-6". Omit if unknown.' },
    },
    required: ['mealName', 'ingredients', 'instructions', 'tags'],
    additionalProperties: false,
  },
};

export async function extractRecipeWithLlm(llm: LlmProvider, sourceText: string): Promise<ParsedRecipe> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Extract a recipe from the text the user gives you. Always answer by calling extract_recipe. ' +
          'Preserve ingredient quantities/units verbatim as given — do not convert units or guess missing amounts.',
      },
      { role: 'user', content: sourceText },
    ],
    [extractRecipeTool],
    { forceTool: 'extract_recipe' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'extract_recipe');
  if (!call) {
    throw new Error('extractRecipeWithLlm: model did not call extract_recipe despite forceTool');
  }
  if (!isParsedRecipe(call.arguments)) {
    throw new Error(`extractRecipeWithLlm: model's extract_recipe call had an unexpected shape: ${JSON.stringify(call.arguments)}`);
  }
  return call.arguments;
}
