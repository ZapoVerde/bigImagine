/**
 * @file frontend/src/lib/aggregateRows.ts
 * @stamp 2026-08-14
 * @architectural-role Pure Function — the groupBy/aggregate helpers both Stats sections share
 * (docs/plans/llm-stats-page-plan.md: "no library" — this replaces the earlier react-pivottable
 * draft with plain code)
 * @description
 * The Stats view is a "group by X, show Y" over a flat admin row list. These four helpers are the
 * entire aggregation surface: stable first-seen groupBy, sum and mean over a nullable numeric
 * column, and a span helper for the Timing section's start/stop pairs. The "omit, don't
 * fabricate" rule from the plan's Edge Cases is enforced here: null columns are excluded from
 * sums/averages, and an all-null group yields null (the view then shows "no data" for that bar)
 * rather than a fabricated zero.
 *
 * @api-declaration
 * groupRows<T>(rows, keyOf, labelOf?)        — StatGroup<T>[], first-seen order, '(unknown)' bucket
 * sumOf<T>(rows, pick)                       — number | null (null when every value is null)
 * meanOf<T>(rows, pick)                      — number | null (null when every value is null)
 * spanMs(startMs, stopMs)                    — number | null (null unless both are numbers)
 *
 * @contract
 *   assertions:
 *     purity:          pure
 *     state_ownership: []
 *     external_io:     []
 */

export interface StatGroup<T> {
  key: string;
  label: string;
  rows: T[];
}

/** Stable groupBy over a key extractor: groups appear in first-seen order of their key (the
 *  admin rows arrive newest-first, so a 'day' grouping reads newest day first — no extra sort
 *  needed). A null/undefined key falls into the '(unknown)' bucket rather than vanishing — a
 *  pre-migration row has no provider/model, but it still belongs on the page. */
export function groupRows<T>(
  rows: T[],
  keyOf: (row: T) => string | null | undefined,
  labelOf?: (key: string) => string,
): StatGroup<T>[] {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row) ?? '(unknown)';
    let list = groups.get(key);
    if (!list) {
      list = [];
      groups.set(key, list);
    }
    list.push(row);
  }
  return [...groups.entries()].map(([key, groupRows]) => ({
    key,
    label: labelOf ? labelOf(key) : key,
    rows: groupRows,
  }));
}

/** Sum of a nullable numeric column — nulls excluded, all-null → null (never 0). */
export function sumOf<T>(rows: T[], pick: (row: T) => number | null | undefined): number | null {
  const values = rows.map(pick).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0);
}

/** Mean of a nullable numeric column — nulls excluded, all-null → null. */
export function meanOf<T>(rows: T[], pick: (row: T) => number | null | undefined): number | null {
  const values = rows.map(pick).filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** A start/stop pair's elapsed span — null unless both ends were actually reached. */
export function spanMs(startMs: number | null | undefined, stopMs: number | null | undefined): number | null {
  if (typeof startMs !== 'number' || typeof stopMs !== 'number') return null;
  return stopMs - startMs;
}
