/**
 * @file plugins/recipes/src/shoppingListFromMealPlanTool.ts
 * @stamp 2026-07-26
 * @architectural-role IO Wrapper — turns a date range's meal plan into grocery list items
 * @description
 * Aggregates recipe ingredients across every meal planned in a date range. Each planned meal is
 * structured (ensureStructuredIngredients.ts, lazily backfilling legacy recipes) and scaled
 * (scaleIngredients.ts) against its own meal_plan_entries.target_servings override before
 * aggregation (aggregateScaledIngredients.ts sums same-item-same-unit amounts — cross-unit
 * conversion, e.g. cups vs. tbsp, stays out of scope, same punt this file always had, just
 * narrowed from "no math at all" to "same-unit math only"). Structuring is de-duped per unique
 * recipe_id, not per planned entry — the same recipe planned on three dates in the range triggers
 * one LLM structuring call, not three. Adds each aggregated item as a list_items row via the same
 * primitive plugins/lists uses (find-or-create the named list, insert, best-effort Notion sync).
 * Also skips items already pending on the target list, so re-running this for an overlapping date
 * range doesn't pile up duplicates.
 *
 * Structuring is per-meal try/catch, not all-or-nothing (consistent with this file's existing
 * best-effort ethos for section classification/Notion sync below): one recipe with a structuring
 * failure shouldn't drop a whole week's list. Its ingredients just don't contribute, and its meal
 * name is surfaced via mealsWithErrors instead of silently vanishing from the result.
 *
 * Duplicates (rather than imports) plugins/lists' find-or-create-list and Notion-sync logic:
 * plugins are siblings with no exports map for cross-plugin imports today (only
 * @bigbrain/orchestrator's io/ modules are shared that way), and this is small enough that adding
 * a first-ever plugin-to-plugin dependency isn't worth it for ~20 lines. Both write the same
 * source_table = 'list_items' value into notion_sync_map, so inbound reconciliation
 * (plugins/lists/src/notionReconcile.ts) treats rows from either plugin identically — it reads
 * lists/list_items directly, it has no notion of which plugin wrote a given row.
 *
 * syncItemToNotion also mirrors notionSync.ts's ownerUserId gate: only ctx.userId ===
 * notion.ownerUserId ever reaches the Notion API. A non-owner account's meal-planned groceries
 * stay Postgres-only, isolated by RLS same as everything else that user writes — this gateway is
 * one Notion workspace synced to one owning user, not one per household member.
 *
 * If the target list has a section_order (plugins/lists/src/setListSectionOrderTool.ts), each
 * newly-added ingredient is classified into one of those sections (classifySection.ts, duplicated
 * from plugins/lists — see that file's docstring) before insert, so a whole week's
 * meal-plan-generated shopping list sorts into the same store-walk order as manually-added items
 * on the same list. Best-effort, same as the Notion sync below it: a classification failure is
 * logged but never blocks the item from being added, unsectioned.
 *
 * @api-declaration
 * createGenerateShoppingListFromMealPlanTool(llm, notion) — returns the
 *   generate_shopping_list_from_meal_plan RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session, best-effort LLM and Notion
 *                      API IO)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given), LLM, Notion API (via NotionClient)]
 */

import { log } from '@bigbrain/orchestrator/logger';
import type { LlmProvider } from '@bigbrain/orchestrator/llm-types';
import type { DbSession } from '@bigbrain/orchestrator/postgres';
import type { NotionClient } from '@bigbrain/orchestrator/notion';
import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';
import { classifySection } from './classifySection.js';
import { ensureStructuredIngredients } from './ensureStructuredIngredients.js';
import { scaleIngredients } from './scaleIngredients.js';
import { aggregateScaledIngredients } from './aggregateScaledIngredients.js';
import type { RecipeIngredient, ScaledIngredient } from './recipeIngredientSchema.js';

// Must match plugins/lists' notionSync.ts SOURCE_TABLE — see the file docstring above.
const SOURCE_TABLE = 'list_items';

interface ShoppingListFromMealPlanArgs {
  start_date?: string;
  end_date?: string;
  list_name?: string;
}

function isArgs(value: unknown): value is ShoppingListFromMealPlanArgs {
  if (typeof value !== 'object' || value === null) return true;
  const v = value as Record<string, unknown>;
  return (
    (v.start_date === undefined || typeof v.start_date === 'string') &&
    (v.end_date === undefined || typeof v.end_date === 'string') &&
    (v.list_name === undefined || typeof v.list_name === 'string')
  );
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function findOrCreateList(db: DbSession, userId: string, name: string): Promise<string> {
  const existing = await db.query<{ list_id: string }>(
    `select list_id from lists where user_id = $1 and lower(name) = lower($2) limit 1`,
    [userId, name],
  );
  if (existing[0]) return existing[0].list_id;

  const inserted = await db.query<{ list_id: string }>(
    `insert into lists (user_id, name) values ($1, $2) returning list_id`,
    [userId, name],
  );
  return inserted[0]!.list_id;
}

async function syncItemToNotion(
  db: DbSession,
  notion: NotionClient | undefined,
  userId: string,
  itemId: string,
  itemName: string,
  listName: string,
): Promise<void> {
  if (!notion || userId !== notion.ownerUserId) return;
  try {
    const { pageId } = await notion.upsertListItemPage({
      pageId: undefined,
      itemName,
      listName,
      done: false,
      completedAt: null,
    });
    await db.query(
      `insert into notion_sync_map (user_id, source_table, source_row_id, notion_database_id, notion_page_id, last_synced_at)
       values ($1, $2, $3, $4, $5, now())`,
      [userId, SOURCE_TABLE, itemId, notion.listsDataSourceId, pageId],
    );
  } catch (err) {
    log.error(`Notion sync failed for meal-plan-generated list_items row ${itemId} (Postgres write already succeeded, unaffected)`, err);
  }
}

export function createGenerateShoppingListFromMealPlanTool(
  llm: LlmProvider,
  notion: NotionClient | undefined,
): RegisteredTool {
  return {
    definition: {
      name: 'generate_shopping_list_from_meal_plan',
      description:
        'Add every ingredient needed for the meals planned in a date range to a shopping list, skipping ingredients already on it. Defaults to today through the next 6 days and a list named "Grocery List".',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Range start, as YYYY-MM-DD. Defaults to today.' },
          end_date: { type: 'string', description: 'Range end, as YYYY-MM-DD. Defaults to 6 days after start.' },
          list_name: { type: 'string', description: 'The list to add items to. Defaults to "Grocery List".' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isArgs(args)) {
        throw new Error('generate_shopping_list_from_meal_plan: start_date/end_date/list_name, if given, must be strings');
      }
      const today = new Date();
      const startDate = (args as ShoppingListFromMealPlanArgs).start_date ?? isoDate(today);
      const defaultEnd = new Date(today);
      defaultEnd.setDate(defaultEnd.getDate() + 6);
      const endDate = (args as ShoppingListFromMealPlanArgs).end_date ?? isoDate(defaultEnd);
      const listName = (args as ShoppingListFromMealPlanArgs).list_name ?? 'Grocery List';

      const planned = await ctx.db.query<{
        recipe_id: string;
        meal_name: string;
        ingredients: unknown[];
        servings: string | null;
        base_servings: number | null;
        target_servings: number | null;
      }>(
        `select rm.recipe_id, rm.meal_name, rm.ingredients, rm.servings, rm.base_servings, mpe.target_servings
         from meal_plan_entries mpe
         join recipes_meals rm on rm.recipe_id = mpe.recipe_id
         where mpe.user_id = $1 and mpe.planned_date between $2 and $3`,
        [ctx.userId, startDate, endDate],
      );

      if (planned.length === 0) {
        return { listName, itemsAdded: [], itemsSkipped: [], mealsConsidered: 0, mealsWithErrors: [] };
      }

      // De-dupe structuring by recipe_id — the same recipe planned on several dates in the range
      // should only cost one LLM structuring call, not one per planned entry.
      const structuredByRecipe = new Map<string, { ingredients: RecipeIngredient[]; baseServings: number | null } | null>();
      const mealsWithErrors: string[] = [];
      const mealIngredientLists: ScaledIngredient[][] = [];

      for (const meal of planned) {
        if (!structuredByRecipe.has(meal.recipe_id)) {
          try {
            const result = await ensureStructuredIngredients(ctx.db, llm, {
              recipeId: meal.recipe_id,
              ingredients: meal.ingredients,
              servings: meal.servings,
              baseServings: meal.base_servings,
            });
            structuredByRecipe.set(meal.recipe_id, result);
          } catch (err) {
            log.error(`ingredient structuring failed for "${meal.meal_name}" (recipe_id ${meal.recipe_id}) — excluded from this shopping list`, err);
            structuredByRecipe.set(meal.recipe_id, null);
            mealsWithErrors.push(meal.meal_name);
          }
        }

        const structured = structuredByRecipe.get(meal.recipe_id);
        if (!structured || structured.baseServings === null) continue;

        const targetServings = meal.target_servings ?? structured.baseServings;
        const ratio = targetServings / structured.baseServings;
        mealIngredientLists.push(scaleIngredients(structured.ingredients, ratio));
      }

      const aggregated = aggregateScaledIngredients(mealIngredientLists);
      const seen = new Map<string, string>(); // lowercase -> original casing, first-seen wins
      for (const { itemName } of aggregated) {
        const key = itemName.trim().toLowerCase();
        if (key && !seen.has(key)) seen.set(key, itemName.trim());
      }

      const listId = await findOrCreateList(ctx.db, ctx.userId, listName);

      const listRow = await ctx.db.query<{ section_order: string[] }>(`select section_order from lists where list_id = $1`, [listId]);
      const sectionOrder = listRow[0]?.section_order ?? [];

      const existingPending = await ctx.db.query<{ item_name: string }>(
        `select item_name from list_items where list_id = $1 and status = 'pending'`,
        [listId],
      );
      const alreadyOnList = new Set(existingPending.map((r) => r.item_name.trim().toLowerCase()));

      const itemsAdded: string[] = [];
      const itemsSkipped: string[] = [];

      for (const [key, itemName] of seen) {
        if (alreadyOnList.has(key)) {
          itemsSkipped.push(itemName);
          continue;
        }

        let section: string | null = null;
        if (sectionOrder.length > 0) {
          try {
            section = await classifySection(llm, sectionOrder, itemName);
          } catch (err) {
            log.error(`section classification failed for "${itemName}" on list ${listId} (item still added, unsectioned)`, err);
          }
        }

        const inserted = await ctx.db.query<{ item_id: string }>(
          `insert into list_items (list_id, user_id, item_name, section) values ($1, $2, $3, $4) returning item_id`,
          [listId, ctx.userId, itemName, section],
        );
        await syncItemToNotion(ctx.db, notion, ctx.userId, inserted[0]!.item_id, itemName, listName);
        itemsAdded.push(itemName);
      }

      return { listName, itemsAdded, itemsSkipped, mealsConsidered: planned.length, mealsWithErrors };
    },
  };
}
