/**
 * @file plugins/recipes/src/shoppingListFromMealPlanTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — turns a date range's meal plan into grocery list items
 * @description
 * Aggregates recipe ingredients across every meal planned in a date range, dedupes by name (no
 * quantity math/unit conversion — list_items has no quantity field, and "2 cups + 1 cup" unit
 * arithmetic is exactly the kind of complexity this project keeps deciding to punt on), and adds
 * each as a list_items row via the same primitive plugins/lists uses (find-or-create the named
 * list, insert, best-effort Notion sync). Also skips ingredients that already exist as a pending
 * item on the target list, so re-running this for an overlapping date range doesn't pile up
 * duplicates.
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

      const planned = await ctx.db.query<{ ingredients: string[] }>(
        `select rm.ingredients
         from meal_plan_entries mpe
         join recipes_meals rm on rm.recipe_id = mpe.recipe_id
         where mpe.user_id = $1 and mpe.planned_date between $2 and $3`,
        [ctx.userId, startDate, endDate],
      );

      if (planned.length === 0) {
        return { listName, itemsAdded: [], itemsSkipped: [], mealsConsidered: 0 };
      }

      const seen = new Map<string, string>(); // lowercase -> original casing, first-seen wins
      for (const { ingredients } of planned) {
        for (const ingredient of ingredients) {
          const key = ingredient.trim().toLowerCase();
          if (key && !seen.has(key)) seen.set(key, ingredient.trim());
        }
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

      return { listName, itemsAdded, itemsSkipped, mealsConsidered: planned.length };
    },
  };
}
