/**
 * @file plugins/recipes/src/addMealPlanEntryTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — plans a recipe for a date
 * @description
 * Deliberately no slot enum (docs/spec.md's meal-plan design note, following the household's own
 * pattern: "generally only dinner," but some days — Christmas — have breakfast and lunch planned
 * with no dinner). meal_label is free text and optional: leave it unset for the default case,
 * set it ("Breakfast", "Lunch") only on days that need disambiguating.
 *
 * Upserts on (user_id, planned_date, meal_label) at the application level, not a DB constraint —
 * replanning a date ("actually let's do X for dinner Thursday instead") should replace, not
 * duplicate, but a household deliberately wanting two things on the same date/label is a fine
 * outcome the schema doesn't need to prevent.
 *
 * target_servings is an optional per-planned-meal scale override ("plan this for 8, we're having
 * people over Thursday") — null/omitted means generate_shopping_list_from_meal_plan uses the
 * recipe's own base_servings, unscaled.
 *
 * @api-declaration
 * createAddMealPlanEntryTool() — returns the add_meal_plan_entry RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface AddMealPlanEntryArgs {
  meal_name: string;
  planned_date: string;
  meal_label?: string;
  target_servings?: number;
}

function isAddMealPlanEntryArgs(value: unknown): value is AddMealPlanEntryArgs {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.meal_name === 'string' &&
    v.meal_name !== '' &&
    typeof v.planned_date === 'string' &&
    v.planned_date !== '' &&
    (v.meal_label === undefined || typeof v.meal_label === 'string') &&
    (v.target_servings === undefined || (typeof v.target_servings === 'number' && v.target_servings > 0))
  );
}

export function createAddMealPlanEntryTool(): RegisteredTool {
  return {
    definition: {
      name: 'add_meal_plan_entry',
      description:
        'Plan a recipe for a date (e.g. dinner on Thursday). Replanning the same date/meal_label replaces the previous entry.',
      parameters: {
        type: 'object',
        properties: {
          meal_name: { type: 'string', description: 'The recipe to plan (matched by name).' },
          planned_date: { type: 'string', description: 'The date, as YYYY-MM-DD.' },
          meal_label: {
            type: 'string',
            description: 'Optional label like "Breakfast" or "Lunch". Leave unset for the default (dinner).',
          },
          target_servings: {
            type: 'number',
            description: 'Optional scale override for this planned meal (e.g. 8 for a bigger crowd). Omit to use the recipe as written.',
          },
        },
        required: ['meal_name', 'planned_date'],
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isAddMealPlanEntryArgs(args)) {
        throw new Error('add_meal_plan_entry requires meal_name: string and planned_date: string (YYYY-MM-DD)');
      }
      const mealLabel = args.meal_label ?? null;
      const targetServings = args.target_servings ?? null;

      const recipe = await ctx.db.query<{ recipe_id: string; meal_name: string }>(
        `select recipe_id, meal_name from recipes_meals
         where user_id = $1 and lower(meal_name) like lower($2)
         order by (lower(meal_name) = lower($3)) desc, meal_name
         limit 1`,
        [ctx.userId, `%${args.meal_name}%`, args.meal_name],
      );
      if (!recipe[0]) {
        return { planned: false, reason: `no recipe found matching "${args.meal_name}"` };
      }

      const existing = await ctx.db.query<{ plan_entry_id: string }>(
        `select plan_entry_id from meal_plan_entries
         where user_id = $1 and planned_date = $2 and meal_label is not distinct from $3`,
        [ctx.userId, args.planned_date, mealLabel],
      );

      if (existing[0]) {
        await ctx.db.query(`update meal_plan_entries set recipe_id = $2, target_servings = $3 where plan_entry_id = $1`, [
          existing[0].plan_entry_id,
          recipe[0].recipe_id,
          targetServings,
        ]);
      } else {
        await ctx.db.query(
          `insert into meal_plan_entries (user_id, recipe_id, planned_date, meal_label, target_servings) values ($1, $2, $3, $4, $5)`,
          [ctx.userId, recipe[0].recipe_id, args.planned_date, mealLabel, targetServings],
        );
      }

      return {
        planned: true,
        mealName: recipe[0].meal_name,
        plannedDate: args.planned_date,
        mealLabel,
        targetServings,
        replaced: Boolean(existing[0]),
      };
    },
  };
}
