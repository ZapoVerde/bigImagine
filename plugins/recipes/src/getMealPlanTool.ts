/**
 * @file plugins/recipes/src/getMealPlanTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — reads the planned meals for a date range
 * @description
 * start_date/end_date default to today through six days out (a week-ish window) when omitted, so
 * "what's the plan this week" needs no dates from the caller — the common case shouldn't require
 * the model to compute a date range itself.
 *
 * @api-declaration
 * createGetMealPlanTool() — returns the get_meal_plan RegisteredTool
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface GetMealPlanArgs {
  start_date?: string;
  end_date?: string;
}

function isGetMealPlanArgs(value: unknown): value is GetMealPlanArgs {
  if (typeof value !== 'object' || value === null) return true;
  const v = value as Record<string, unknown>;
  return (v.start_date === undefined || typeof v.start_date === 'string') && (v.end_date === undefined || typeof v.end_date === 'string');
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function createGetMealPlanTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_meal_plan',
      description: 'List planned meals within a date range. Defaults to today through the next 6 days if no dates are given.',
      parameters: {
        type: 'object',
        properties: {
          start_date: { type: 'string', description: 'Range start, as YYYY-MM-DD. Defaults to today.' },
          end_date: { type: 'string', description: 'Range end, as YYYY-MM-DD. Defaults to 6 days after start.' },
        },
        additionalProperties: false,
      },
    },
    handler: async (args, ctx) => {
      if (!isGetMealPlanArgs(args)) {
        throw new Error('get_meal_plan: start_date/end_date, if given, must be strings (YYYY-MM-DD)');
      }
      const today = new Date();
      const startDate = (args as GetMealPlanArgs).start_date ?? isoDate(today);
      const defaultEnd = new Date(today);
      defaultEnd.setDate(defaultEnd.getDate() + 6);
      const endDate = (args as GetMealPlanArgs).end_date ?? isoDate(defaultEnd);

      const rows = await ctx.db.query<{
        planned_date: string;
        meal_label: string | null;
        meal_name: string;
        recipe_id: string;
        target_servings: number | null;
      }>(
        `select mpe.planned_date, mpe.meal_label, rm.meal_name, rm.recipe_id, mpe.target_servings
         from meal_plan_entries mpe
         join recipes_meals rm on rm.recipe_id = mpe.recipe_id
         where mpe.user_id = $1 and mpe.planned_date between $2 and $3
         order by mpe.planned_date, mpe.meal_label nulls first`,
        [ctx.userId, startDate, endDate],
      );

      return rows.map((r) => ({
        plannedDate: r.planned_date,
        mealLabel: r.meal_label,
        mealName: r.meal_name,
        recipeId: r.recipe_id,
        targetServings: r.target_servings,
      }));
    },
  };
}
