/**
 * @file plugins/shopping-analytics/src/shoppingAnalyticsTool.ts
 * @stamp 2026-07-23
 * @architectural-role IO Wrapper — docs/spec.md §6.2's Chronological Shopping Analytics Engine
 * @description
 * `days_between_purchases` is not a stored column — spec.md §6.2 was explicit that a stored
 * value would drift stale the moment a new purchase is logged. It's derived per request via a
 * window function (LAG over each item's purchase history, partitioned by item_name), exactly as
 * corrected there. This adapts the spec's literal query in one way: it converts the LAG delta
 * from a raw Postgres interval to a plain number of days (extract(epoch from ...) / 86400.0),
 * since a serialized interval object is awkward for a tool-call result an LLM has to reason over
 * — the window-function-over-a-stored-column fix is unchanged, only the output shape is friendlier.
 *
 * This is deterministic aggregation, not an LLM reasoning step (bb_principles.md §8's "kinds of
 * code" — this is domain logic, not orchestration): it returns the raw per-item stats and leaves
 * interpretation ("what's due soon") to the model's own next turn, the same separation
 * ingest_note keeps between classification (LLM) and storage (SQL).
 *
 * @api-declaration
 * createShoppingAnalyticsTool() — returns the get_shopping_patterns RegisteredTool; no
 *   constructor dependencies, only ctx.db/ctx.userId supplied per-call
 *
 * @contract
 *   assertions:
 *     purity:          impure (Postgres IO via the injected session)
 *     state_ownership: []
 *     external_io:     [Postgres (via the DbSession it's given)]
 */

import type { RegisteredTool } from '@bigbrain/orchestrator/tool-registry';

interface PatternRow {
  item_name: string;
  purchase_count: number;
  avg_days_between: string | null;
  last_purchased_at: string;
}

const QUERY = `
  with deltas as (
    select
      item_name,
      "timestamp",
      extract(epoch from ("timestamp" - lag("timestamp") over (partition by item_name order by "timestamp"))) / 86400.0 as days_between
    from shopping_logs
    where user_id = $1
  )
  select
    item_name,
    count(*)::int as purchase_count,
    avg(days_between) as avg_days_between,
    max("timestamp") as last_purchased_at
  from deltas
  group by item_name
  order by last_purchased_at desc
`;

export function createShoppingAnalyticsTool(): RegisteredTool {
  return {
    definition: {
      name: 'get_shopping_patterns',
      description:
        'Get chronological purchase patterns per item: how many times each item was bought, the average number of days between purchases, and when it was last bought. Useful for "what am I due to buy again" or "how often do I buy X" questions.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    handler: async (_args, ctx) => {
      const rows = await ctx.db.query<PatternRow>(QUERY, [ctx.userId]);

      return rows.map((r) => ({
        itemName: r.item_name,
        purchaseCount: r.purchase_count,
        avgDaysBetween: r.avg_days_between === null ? null : Number(r.avg_days_between),
        lastPurchasedAt: r.last_purchased_at,
      }));
    },
  };
}
