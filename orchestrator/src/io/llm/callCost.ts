/**
 * @file orchestrator/src/io/llm/callCost.ts
 * @stamp 2026-08-14
 * @architectural-role Pure Function — cost derivation kept out of llmGate.ts because the gate is
 * an IO Wrapper (bi_principles.md §8: "contain zero reasoning or derivation logic") and USD cost
 * arithmetic is derivation. Its own file, not a helper inside the gate, so the arithmetic is
 * unit-testable without any Postgres/LLM scaffolding (the same split the frontend's
 * computeReceiptCost keeps client-side for the Prompt Inspector receipt).
 * @description
 * Turns one call's token counts and the resolved connection's price tiers into a USD cost. The
 * "omit rather than guess" rule from docs/plans/completed/prompt-inspector-usage-cost.md: it only
 * returns a number when every tier the calculation actually needs is present — input and output
 * always; the cache-hit tier only when cacheReadTokens is a positive number (a zero or absent
 * cache count prices the full prompt at the input rate, no cache tier needed). Any missing
 * needed tier yields undefined — the caller stores null and the Stats page excludes the row from
 * sums/averages rather than showing a fabricated $0.00.
 *
 * Arithmetic is the same shape as the inspector's receipt: cache-hit tokens are billed at the
 * cache rate, the remainder of promptTokens at the input rate, completionTokens at the output
 * rate, all per-1M-token prices divided by 1_000_000.
 *
 * @api-declaration
 * computeCallCostUsd(usage, price) — number | undefined, per the rules above.
 *
 * @contract
 *   assertions:
 *     purity:          pure (no IO, no state, no exceptions for well-typed inputs)
 *     state_ownership: []
 *     external_io:     []
 */

export interface CallCostUsage {
  promptTokens: number;
  completionTokens: number;
  /** Prompt tokens served from the provider's cache — undefined and 0 both mean "no cache hit
   *  to price"; only a positive number engages the cache-hit tier requirement. */
  cacheReadTokens?: number;
}

export interface CallCostPrice {
  priceInputPerMillion?: number;
  priceOutputPerMillion?: number;
  priceCacheHitPerMillion?: number;
}

const PER_MILLION = 1_000_000;

export function computeCallCostUsd(
  usage: CallCostUsage,
  price: CallCostPrice,
): number | undefined {
  const needsCacheRate = typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens > 0;
  if (
    price.priceInputPerMillion === undefined ||
    price.priceOutputPerMillion === undefined ||
    (needsCacheRate && price.priceCacheHitPerMillion === undefined)
  ) {
    return undefined;
  }
  const cacheHit = usage.cacheReadTokens ?? 0;
  const cacheMiss = usage.promptTokens - cacheHit;
  return (
    (cacheMiss * price.priceInputPerMillion + cacheHit * (price.priceCacheHitPerMillion ?? 0)) / PER_MILLION +
    (usage.completionTokens * price.priceOutputPerMillion) / PER_MILLION
  );
}
