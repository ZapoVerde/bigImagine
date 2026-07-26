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
 * modifier separates a prep instruction (what to do to the ingredient before using it) from item
 * (what the ingredient is) — "garlic, peeled and smashed" becomes item "garlic", modifier "peeled
 * and smashed", not item "garlic, peeled and smashed". The prompt below gives the model a
 * position-based rule for the one real ambiguity here: a descriptor is part of the product's
 * identity (stays in item) when it appears *before* the noun or names something bought that way —
 * "diced tomatoes", "ground beef", "shredded cheese" are all things a store sells under that exact
 * name. A descriptor is a prep instruction (goes in modifier) when it follows the noun, typically
 * after a comma — "onion, diced", "butter, softened", "garlic, peeled and smashed" are all
 * something the cook does, not something printed on a label. modifier, unlike raw, is trusted
 * as the model wrote it — it's free descriptive text, not something a corrupted value could
 * misattribute an amount to.
 *
 * unit is asked for in exact canonical spelling for the ~11 measurement units this household cares
 * about normalizing (teaspoon/tablespoon/cup/pinch, which stay imperial forever, and
 * ounce/fluid ounce/pound/quart/pint/gallon/stick, which convertIngredientUnitsToMetric.ts converts
 * right after this call returns) — dispatch there is exact-string-match, not fuzzy parsing, so the
 * canonical spelling has to come from here. Everything else (cloves, cans, heads — open-ended count
 * units) stays free text exactly as the model would naturally write it. Bare "ounce" is genuinely
 * ambiguous (weight vs. fluid) and the prompt resolves it with a heuristic rather than leaving it
 * for a guess downstream: liquid ingredient -> fluid ounce; solid/semi-solid -> ounce; explicit
 * "fl oz"/"fluid ounce" in the text -> fluid ounce, no guessing needed; canned/packaged goods ->
 * ounce (US labeling convention, even for liquid-ish contents like canned tomatoes); genuinely
 * unclear -> ounce, since recipe writers reach for "fl oz" explicitly when they mean volume.
 *
 * A bad response here (truncated tool-call JSON, or a line-count mismatch from the model merging/
 * splitting lines) is usually a one-off — retrying the exact same request often just works, since
 * it's a fresh, independent completion. So structureIngredients retries once (two attempts total)
 * before giving up, logging a warning in between rather than propagating the first attempt's
 * failure straight to the caller.
 *
 * @api-declaration
 * structureIngredients(llm, rawIngredients, rawServings) -> {ingredients, baseServings} — retries
 *   once on failure; throws if both attempts fail to produce a shape-valid, line-aligned result
 *
 * @contract
 *   assertions:
 *     purity:          impure (calls the LLM)
 *     state_ownership: []
 *     external_io:     [LLM, via the LlmProvider passed in]
 */

import type { LlmProvider, ToolDefinition } from '@bigbrain/orchestrator/llm-types';
import { log } from '@bigbrain/orchestrator/logger';
import { isRecipeIngredient, type RecipeIngredient } from './recipeIngredientSchema.js';
import { convertIngredientUnitsToMetric } from './convertIngredientUnitsToMetric.js';

interface StructureIngredientsResult {
  lines: { amount: number | null; unit: string | null; item: string; modifier: string | null; scalable: boolean }[];
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
    if (line.modifier !== null && typeof line.modifier !== 'string') return false;
    return (line.amount === null) === (line.scalable === false);
  });
}

const structureIngredientsTool: ToolDefinition = {
  name: 'structure_ingredients',
  description: 'Parse each ingredient line into a numeric amount/unit/item/modifier, and resolve a single numeric base serving count.',
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
            unit: {
              type: ['string', 'null'],
              description:
                'The unit. Null if there is no unit (e.g. "3 eggs") or amount is null. For these specific measurement units, use this exact spelling, singular: ' +
                '"teaspoon", "tablespoon", "cup", "pinch" (never converted — kitchens measure with these directly), or ' +
                '"ounce", "fluid ounce", "pound", "quart", "pint", "gallon", "stick" (converted to metric right after this call). ' +
                'Bare "oz"/"ounce" is ambiguous between weight and volume — write "ounce" for a solid/semi-solid ingredient or a canned/packaged good ' +
                '(US labeling convention labels those by weight even when the contents are liquid-ish, e.g. canned tomatoes), "fluid ounce" only when the text says ' +
                '"fl oz"/"fluid ounce" or the ingredient is clearly a poured liquid; default to "ounce" if genuinely unclear. ' +
                'Any other unit (e.g. "clove", "can", "head", "slice") is free text exactly as written.',
            },
            item: {
              type: 'string',
              description:
                'The ingredient name only, without amount/unit/modifier, e.g. "garlic" not "garlic, peeled and smashed". If amount is null, the full descriptive text, e.g. "salt to taste". ' +
                'Keep a descriptor in item when it names the product as sold — "diced tomatoes", "ground beef", "shredded cheese" — since that\'s what you\'d ask for at a store.',
            },
            modifier: {
              type: ['string', 'null'],
              description:
                'A prep instruction — what to do to the ingredient before using it — e.g. "peeled and smashed" for "garlic, peeled and smashed", or "diced" for "onion, diced". ' +
                'This is different from a descriptor that\'s part of the product name (see item) even when it\'s the same word: "1 can diced tomatoes" has no modifier (diced stays in item, ' +
                'it\'s what the can is labeled), but "1 onion, diced" has modifier "diced" (it\'s an instruction to the cook). Null if there is no separate prep instruction.',
            },
            scalable: { type: 'boolean', description: 'True iff amount is a real number that should be multiplied when scaling the recipe.' },
          },
          required: ['amount', 'unit', 'item', 'modifier', 'scalable'],
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

const MAX_ATTEMPTS = 2;

export async function structureIngredients(
  llm: LlmProvider,
  rawIngredients: string[],
  rawServings: string | null,
): Promise<{ ingredients: RecipeIngredient[]; baseServings: number | null }> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await attemptStructureIngredients(llm, rawIngredients, rawServings);
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        log.warn(`structureIngredients: attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying`, err);
      }
    }
  }
  throw lastError;
}

async function attemptStructureIngredients(
  llm: LlmProvider,
  rawIngredients: string[],
  rawServings: string | null,
): Promise<{ ingredients: RecipeIngredient[]; baseServings: number | null }> {
  const turn = await llm.complete(
    [
      {
        role: 'system',
        content:
          'Parse each given ingredient line into a numeric amount/unit/item/modifier, and resolve the given servings text ' +
          'to a single representative number. Always answer by calling structure_ingredients, with exactly one lines ' +
          'entry per input line, in the same order. Never guess a scalable amount that is not actually present in the ' +
          'text. Separate a prep instruction (modifier, e.g. "diced", "peeled and smashed") from the ingredient itself ' +
          '(item) — but keep a descriptor in item when it names the product as commonly sold (e.g. "diced tomatoes", ' +
          '"ground beef") rather than an instruction to the cook. Use the exact canonical unit spelling requested in the ' +
          'schema for the measurement units it lists, including resolving ambiguous "oz" to "ounce" or "fluid ounce".',
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
    modifier: line.modifier,
    scalable: line.scalable,
  }));

  if (!ingredients.every(isRecipeIngredient)) {
    throw new Error('structureIngredients: assembled ingredients failed validation after zipping with raw lines');
  }

  // Deterministic, not the model's job (bb_principles.md §2) — convert the fixed imperial units
  // this household normalizes (ounce/pound/stick/fluid ounce/quart/pint/gallon) to grams/
  // milliliters now that the LLM has already decided which unit each line is written in.
  const metricIngredients = ingredients.map(convertIngredientUnitsToMetric);

  return { ingredients: metricIngredients, baseServings: call.arguments.baseServings };
}
