/**
 * @file plugins/recipes/src/structureIngredientsWithLlm.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — forced-schema LLM call, parses ingredient lines + resolves a
 *   numeric base serving count
 * @description
 * Same forced-tool-call shape as classifySection.ts/extractRecipeWithLlm.ts. Turns raw ingredient
 * lines ("2 cups flour") into RecipeIngredient objects and, in the same round trip, resolves a
 * single representative numeric base_servings from the recipe's free-text servings ("4-6" -> a
 * number) — one LLM call does both since both need the same judgment-call reasoning bb_principles
 * §2 reserves for the LLM. Scaling itself never happens here or anywhere near the LLM — that's
 * scaleIngredients.ts's job, pure arithmetic, because bb_principles §2 also means the LLM must
 * never be asked to do math.
 *
 * The model is NOT trusted to echo back the ingredient text it was given — `raw` is assigned
 * server-side by zipping the model's per-line answers against the original input array. This
 * also means the response must stay index-aligned with the input: a model that merges, splits,
 * drops, or reorders lines would otherwise silently misattribute amounts to the wrong ingredient,
 * so a length mismatch is rejected the same way a malformed tool call is (throws, doesn't guess).
 *
 * @api-declaration
 * structureIngredients(llm, rawIngredients, rawServings) -> {ingredients, baseServings} — throws
 *   if the model doesn't call structure_ingredients, returns a mismatched-length array, or
 *   violates the amount/scalable pairing, rather than returning a partially-trustworthy result
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';
import { isRecipeIngredient, type RecipeIngredient } from './recipeIngredientSchema.js';

interface StructureIngredientsResult {
  lines: { amount: number | null; unit: string | null; item: string; scalable: boolean }[];
  baseServings: number | null;
}

function isStructureIngredientsResult(value: unknown, expectedLength: number): value is StructureIngredientsResult {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.lines) || v.lines.length !== expectedLength) return false;
  if (v.baseServings !== null && typeof v.baseServings !== 'number') return false;
  return v.lines.every((l) => {
    if (typeof l !== 'object' || l === null) return false;
    const line = l as Record<string, unknown>;
    if (typeof line.item !== 'string' || typeof line.scalable !== 'boolean') return false;
    if (line.amount !== null && typeof line.amount !== 'number') return false;
    if (line.unit !== null && typeof line.unit !== 'string') return false;
    return (line.amount === null) === (line.scalable === false);
  });
}

const structureIngredientsTool: ToolDefinition = {
  name: 'structure_ingredients',
  description: 'Parse each ingredient line into a numeric amount/unit/item, and resolve a single numeric base serving count.',
  parameters: {
    type: 'object',
    properties: {
      lines: {
        type: 'array',
        description: 'Exactly one entry per input ingredient line, in the same order — do not merge, split, drop, or reorder lines.',
        items: {
          type: 'object',
          properties: {
            amount: { type: ['number', 'null'], description: 'The numeric quantity, e.g. 2 for "2 cups flour". Null if not cleanly scalable (e.g. "salt to taste").' },
            unit: { type: ['string', 'null'], description: 'The unit, e.g. "cup". Null if there is no unit (e.g. "3 eggs") or amount is null.' },
            item: { type: 'string', description: 'The ingredient name, without amount/unit, e.g. "flour". If amount is null, the full descriptive text, e.g. "salt to taste".' },
            scalable: { type: 'boolean', description: 'True iff amount is a real number that should be multiplied when scaling the recipe.' },
          },
          required: ['amount', 'unit', 'item', 'scalable'],
          additionalProperties: false,
        },
      },
      baseServings: {
        type: ['number', 'null'],
        description: 'A single representative number of servings, e.g. 5 for "4-6" or 4 for "4". Null if servings is unknown/not given.',
      },
    },
    required: ['lines', 'baseServings'],
    additionalProperties: false,
  },
};

export async function structureIngredients(
  llm: LlmProvider,
  rawIngredients: string[],
  rawServings: string | null,
): Promise<{ ingredients: RecipeIngredient[]; baseServings: number | null }> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Parse each given ingredient line into a numeric amount/unit/item, and resolve the given servings text to a ' +
          'single representative number. Always answer by calling structure_ingredients, with exactly one lines entry ' +
          'per input line, in the same order. Never guess a scalable amount that is not actually present in the text.',
      },
      {
        role: 'user',
        content: `Servings: ${rawServings ?? '(unknown)'}\n\nIngredients:\n${rawIngredients.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
      },
    ],
    [structureIngredientsTool],
    { forceTool: 'structure_ingredients' },
  );

  const call = turn.toolCalls.find((c) => c.name === 'structure_ingredients');
  if (!call) {
    throw new Error('structureIngredients: model did not call structure_ingredients despite forceTool');
  }
  if (!isStructureIngredientsResult(call.arguments, rawIngredients.length)) {
    throw new Error(
      `structureIngredients: model's structure_ingredients call had an unexpected shape or wrong line count: ${JSON.stringify(call.arguments)}`,
    );
  }

  const ingredients: RecipeIngredient[] = call.arguments.lines.map((line, i) => ({
    raw: rawIngredients[i]!,
    amount: line.amount,
    unit: line.unit,
    item: line.item,
    scalable: line.scalable,
  }));

  if (!ingredients.every(isRecipeIngredient)) {
    throw new Error('structureIngredients: assembled ingredients failed validation after zipping with raw lines');
  }

  return { ingredients, baseServings: call.arguments.baseServings };
}
