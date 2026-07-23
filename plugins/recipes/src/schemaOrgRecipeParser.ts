/**
 * @file plugins/recipes/src/schemaOrgRecipeParser.ts
 * @stamp 2026-07-23
 * @architectural-role Pure Function module — deterministic recipe extraction from page HTML
 * @description
 * The preferred import path when it applies: recipe sites embed schema.org/Recipe as
 * `<script type="application/ld+json">` for Google's rich-snippet requirement, so a real page's
 * ingredients/instructions can usually be read directly instead of guessed by an LLM. Verified
 * live against an actual recipetineats.com page's raw HTML (not just the spec) before writing
 * this — confirmed the @graph-wrapped shape, the HowToSection/HowToStep nesting for instructions,
 * and that recipeIngredient really is flat strings, not structured fields.
 *
 * Deliberately conservative: returns undefined (never throws, never returns a partial/guessed
 * recipe) whenever the markup is missing, malformed, or lacks a name + at least one ingredient —
 * importRecipeTool.ts falls back to the LLM path in exactly that case.
 *
 * @api-declaration
 * extractSchemaOrgRecipe(html) — undefined if no usable Recipe node is found
 *
 * @contract
 *   assertions:
 *     purity:          pure (string/JSON parsing only, no IO)
 *     state_ownership: []
 *     external_io:     []
 */

import type { ParsedRecipe, RecipeInstruction } from './recipeSchema.js';

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function humanizeIsoDuration(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  const match = /^PT(?:(\d+)H)?(?:(\d+)M)?$/.exec(iso);
  if (!match) return iso; // not the duration shape we expect — pass through rather than guess
  const [, hours, minutes] = match;
  const parts: string[] = [];
  if (hours) parts.push(`${hours} hr`);
  if (minutes) parts.push(`${minutes} min`);
  return parts.length > 0 ? parts.join(' ') : iso;
}

function isRecipeTypeNode(node: unknown): node is Record<string, unknown> {
  if (typeof node !== 'object' || node === null) return false;
  const type = (node as Record<string, unknown>)['@type'];
  return type === 'Recipe' || (Array.isArray(type) && type.includes('Recipe'));
}

function findRecipeNode(parsed: unknown): Record<string, unknown> | undefined {
  const candidates: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
  for (const candidate of candidates) {
    if (isRecipeTypeNode(candidate)) return candidate;
    if (typeof candidate === 'object' && candidate !== null && '@graph' in candidate) {
      const graph = (candidate as Record<string, unknown>)['@graph'];
      if (Array.isArray(graph)) {
        const found = graph.find(isRecipeTypeNode);
        if (found) return found as Record<string, unknown>;
      }
    }
  }
  return undefined;
}

function stepText(step: unknown): string | undefined {
  if (typeof step === 'string') return step;
  if (typeof step === 'object' && step !== null) {
    const v = step as Record<string, unknown>;
    if (typeof v.text === 'string') return v.text;
    if (typeof v.name === 'string') return v.name;
  }
  return undefined;
}

function parseInstructions(raw: unknown): RecipeInstruction[] {
  const entries = toArray(raw as unknown[] | undefined);
  const instructions: RecipeInstruction[] = [];

  for (const entry of entries) {
    if (typeof entry === 'string') {
      instructions.push(entry);
      continue;
    }
    if (typeof entry !== 'object' || entry === null) continue;
    const v = entry as Record<string, unknown>;

    if (v['@type'] === 'HowToSection' && Array.isArray(v.itemListElement)) {
      const steps = v.itemListElement.map(stepText).filter((s): s is string => Boolean(s));
      if (steps.length > 0) {
        instructions.push({ section: typeof v.name === 'string' ? v.name : 'Instructions', steps });
      }
      continue;
    }

    const text = stepText(v);
    if (text) instructions.push(text);
  }

  return instructions;
}

function parseTags(node: Record<string, unknown>): string[] {
  const tags = new Set<string>();
  for (const c of toArray(node.recipeCategory as string | string[] | undefined)) tags.add(c);
  for (const c of toArray(node.recipeCuisine as string | string[] | undefined)) tags.add(c);
  const keywords = node.keywords;
  if (typeof keywords === 'string') {
    for (const k of keywords.split(',')) {
      const trimmed = k.trim();
      if (trimmed) tags.add(trimmed);
    }
  } else {
    for (const k of toArray(keywords as string[] | undefined)) tags.add(k);
  }
  return [...tags];
}

export function extractSchemaOrgRecipe(html: string): ParsedRecipe | undefined {
  const blocks = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);

  for (const block of blocks) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(block[1]!);
    } catch {
      continue; // malformed JSON in this particular block — try the next one, don't fail the page
    }

    const node = findRecipeNode(parsed);
    if (!node) continue;

    const name = typeof node.name === 'string' ? node.name : undefined;
    const ingredients = toArray(node.recipeIngredient as string[] | undefined).filter(
      (i): i is string => typeof i === 'string' && i !== '',
    );
    if (!name || ingredients.length === 0) continue; // not enough to trust — let the LLM fallback handle it

    const yields = toArray(node.recipeYield as string | string[] | undefined);

    return {
      mealName: name,
      ingredients,
      instructions: parseInstructions(node.recipeInstructions),
      tags: parseTags(node),
      prepTime: humanizeIsoDuration(typeof node.prepTime === 'string' ? node.prepTime : undefined),
      cookTime: humanizeIsoDuration(typeof node.cookTime === 'string' ? node.cookTime : undefined),
      servings: yields.length > 0 ? yields.join(', ') : undefined,
    };
  }

  return undefined;
}
